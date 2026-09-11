import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { aggregateYears, asBar, historyPathFor, normaliseQuote, normaliseSymbol, supportedSymbols, supportedTimeframes } from './history-core.mjs';

const port = Number(process.env.ENKEI_BRIDGE_PORT ?? 8788);
const commonDirectory = process.env.ENKEI_MT4_COMMON_DIR
  ?? path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const snapshotPath = path.join(commonDirectory, 'enkei', 'market-snapshot.json');
const historyDirectory = path.join(commonDirectory, 'enkei', 'history');
const supervisorPath = path.join(commonDirectory, 'enkei', 'research-supervisor.json');
const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

function historyPath(symbol, timeframe) {
  return historyPathFor(historyDirectory, symbol, timeframe);
}

async function readSnapshot() {
  const [content, info] = await Promise.all([readFile(snapshotPath, 'utf8'), stat(snapshotPath)]);
  const parsed = JSON.parse(content.trim());
  const legacyQuote = normaliseQuote(parsed);
  const quotes = (Array.isArray(parsed?.quotes) ? parsed.quotes : legacyQuote ? [legacyQuote] : [])
    .map(normaliseQuote)
    .filter(Boolean);
  if (quotes.length === 0) throw new Error('Snapshot schema is invalid.');
  const primary = quotes[0];
  const serverEpoch = Number(parsed?.server_epoch);
  const gmtEpoch = Number(parsed?.gmt_epoch);
  const reportedOffset = Number(parsed?.server_gmt_offset_seconds);
  const rawOffset = Number.isFinite(reportedOffset) ? reportedOffset : serverEpoch - gmtEpoch;
  const boundedOffset = Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 14 * 3600 ? Math.round(rawOffset) : 0;
  // MT4 datetime values can be encoded as broker wall-clock seconds.  Only
  // apply an offset when the corrected server clock agrees with this PC's UTC
  // clock; otherwise leave the history untouched and report the mismatch.
  const correctedServerEpoch = Number.isFinite(serverEpoch) ? serverEpoch - boundedOffset : NaN;
  const clockAligned = Number.isFinite(correctedServerEpoch) && Math.abs(correctedServerEpoch - Date.now() / 1000) <= 20 * 60;
  const historyAdjustmentSeconds = clockAligned ? -boundedOffset : 0;
  return {
    ...primary,
    quotes,
    server_time: typeof parsed?.server_time === 'string' ? parsed.server_time : '',
    server_epoch: Number.isFinite(serverEpoch) ? serverEpoch : null,
    gmt_epoch: Number.isFinite(gmtEpoch) ? gmtEpoch : null,
    server_gmt_offset_seconds: boundedOffset,
    history_time_adjustment_seconds: historyAdjustmentSeconds,
    clock_status: clockAligned ? (historyAdjustmentSeconds === 0 ? 'aligned' : 'offset-corrected') : 'unresolved',
    age_ms: Date.now() - info.mtimeMs,
    mode: 'read-only-mt4-demo',
  };
}

async function readHistory(symbol, timeframe, limit) {
  const interval = String(timeframe ?? '').toUpperCase();
  const filePath = historyPath(symbol, interval);
  if (!filePath) throw new Error('Unsupported currency pair.');
  const [content, info, snapshot] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath), readSnapshot().catch(() => null)]);
  const bars = content.split(/\r?\n/).slice(1).map(asBar).filter(Boolean);
  const unique = Array.from(new Map(bars.map((bar) => [bar.time, bar])).values()).sort((left, right) => left.time - right.time);
  const rawLatestBarTime = unique.at(-1)?.time ?? null;
  const adjustment = snapshot?.history_time_adjustment_seconds ?? 0;
  const normalized = adjustment === 0 ? unique : unique.map((bar) => ({ ...bar, time: bar.time + adjustment }));
  const processed = interval === 'Y1' ? aggregateYears(normalized) : normalized;
  return {
    symbol: normaliseSymbol(symbol),
    bars: processed.slice(-limit),
    total_bars: processed.length,
    file_updated_at: info.mtime.toISOString(),
    file_age_ms: Date.now() - info.mtimeMs,
    latest_bar_time: processed.at(-1)?.time ?? null,
    raw_latest_bar_time: rawLatestBarTime,
    clock: snapshot ? {
      status: snapshot.clock_status,
      server_gmt_offset_seconds: snapshot.server_gmt_offset_seconds,
      history_time_adjustment_seconds: adjustment,
    } : { status: 'unavailable', server_gmt_offset_seconds: 0, history_time_adjustment_seconds: 0 },
  };
}

async function readCoverage(symbol) {
  const key = normaliseSymbol(symbol);
  if (!supportedSymbols.has(key)) throw new Error('Unsupported currency pair.');
  const timeframes = [...supportedTimeframes];
  const coverage = await Promise.all(timeframes.map(async (timeframe) => {
    const filePath = historyPath(key, timeframe);
    try {
      const info = await stat(filePath);
      return { timeframe, ready: info.size > 0, bytes: info.size, age_ms: Date.now() - info.mtimeMs };
    } catch {
      return { timeframe, ready: false, bytes: 0, age_ms: null };
    }
  }));
  return { symbol: key, coverage };
}

async function readSupervisor() {
  const [content, info] = await Promise.all([readFile(supervisorPath, 'utf8'), stat(supervisorPath)]);
  const supervisor = JSON.parse(content.trim());
  return { ...supervisor, file_age_ms: Date.now() - info.mtimeMs, source: 'enkei-local-background-supervisor', mode: 'read-only-background-research' };
}

function json(response, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === 'OPTIONS') return json(response, 204, {}, origin);
  if (request.method !== 'GET') return json(response, 405, { error: 'Read-only bridge: GET only.' }, origin);
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/health') {
    try {
      const snapshot = await readSnapshot();
      return json(response, 200, { status: snapshot.age_ms <= 10_000 ? 'ready' : 'stale', snapshot_path: snapshotPath, history_directory: historyDirectory, quote_count: snapshot.quotes.length, age_ms: snapshot.age_ms }, origin);
    } catch (error) {
      return json(response, 503, { status: 'waiting', snapshot_path: snapshotPath, history_directory: historyDirectory, message: error instanceof Error ? error.message : 'Snapshot unavailable.' }, origin);
    }
  }
  if (url.pathname === '/api/snapshot') {
    try {
      return json(response, 200, await readSnapshot(), origin);
    } catch (error) {
      return json(response, 503, { error: error instanceof Error ? error.message : 'Snapshot unavailable.' }, origin);
    }
  }
  if (url.pathname === '/api/history') {
    const requested = Number(url.searchParams.get('limit') ?? 2000);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 100), 20_000) : 2000;
    const timeframe = String(url.searchParams.get('timeframe') ?? 'H1').toUpperCase();
    try {
      const history = await readHistory(url.searchParams.get('symbol') ?? '', timeframe, limit);
      return json(response, 200, { ...history, timeframe, source: 'mt4-local-history-read-only', mode: 'read-only-mt4-demo' }, origin);
    } catch (error) {
      return json(response, 404, { error: error instanceof Error ? error.message : 'History unavailable.' }, origin);
    }
  }
  if (url.pathname === '/api/coverage') {
    try {
      return json(response, 200, await readCoverage(url.searchParams.get('symbol') ?? ''), origin);
    } catch (error) {
      return json(response, 404, { error: error instanceof Error ? error.message : 'Coverage unavailable.' }, origin);
    }
  }
  if (url.pathname === '/api/supervisor') {
    try {
      return json(response, 200, await readSupervisor(), origin);
    } catch (error) {
      return json(response, 503, { status: 'waiting', message: error instanceof Error ? error.message : 'Background supervisor unavailable.' }, origin);
    }
  }
  return json(response, 404, { error: 'Not found.' }, origin);
}).listen(port, '127.0.0.1', () => {
  console.log(`Enkei read-only MT4 bridge listening at http://127.0.0.1:${port}`);
  console.log(`Watching quotes: ${snapshotPath}`);
  console.log(`Watching history files: ${historyDirectory}`);
});
