import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const commonDirectory = process.env.ENKEI_MT4_COMMON_DIR
  ?? path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const enkeiDirectory = path.join(commonDirectory, 'enkei');
const snapshotPath = path.join(enkeiDirectory, 'market-snapshot.json');
const historyDirectory = path.join(enkeiDirectory, 'history');
const outputPath = path.join(enkeiDirectory, 'research-supervisor.json');
const intervalMs = Math.max(30_000, Number(process.env.ENKEI_SUPERVISOR_INTERVAL_MS ?? 60_000));
const symbols = ['USDJPY', 'EURUSD', 'EURJPY', 'GBPUSD', 'GBPJPY', 'AUDJPY'];
const timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
let cycles = 0;

async function inspectSnapshot() {
  try {
    const [content, info] = await Promise.all([readFile(snapshotPath, 'utf8'), stat(snapshotPath)]);
    const parsed = JSON.parse(content.trim());
    const quotes = Array.isArray(parsed?.quotes) ? parsed.quotes : [parsed];
    const validQuotes = quotes.filter((quote) => Number.isFinite(Number(quote?.bid)) && Number.isFinite(Number(quote?.ask)) && Number(quote.bid) > 0 && Number(quote.ask) > 0);
    const serverEpoch = Number(parsed?.server_epoch);
    const gmtEpoch = Number(parsed?.gmt_epoch);
    const reportedOffset = Number(parsed?.server_gmt_offset_seconds);
    const rawOffset = Number.isFinite(reportedOffset) ? reportedOffset : serverEpoch - gmtEpoch;
    const offset = Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 14 * 3600 ? Math.round(rawOffset) : 0;
    const correctedServerEpoch = Number.isFinite(serverEpoch) ? serverEpoch - offset : NaN;
    const clockAligned = Number.isFinite(correctedServerEpoch) && Math.abs(correctedServerEpoch - Date.now() / 1000) <= 20 * 60;
    const ageMs = Date.now() - info.mtimeMs;
    return { available: validQuotes.length > 0, quote_count: validQuotes.length, age_ms: ageMs, fresh: ageMs <= 10_000, clock_status: clockAligned ? (offset === 0 ? 'aligned' : 'offset-corrected') : 'unresolved' };
  } catch (error) {
    return { available: false, quote_count: 0, age_ms: null, fresh: false, clock_status: 'unavailable', error: error instanceof Error ? error.message : 'Snapshot unavailable.' };
  }
}

async function inspectMarket(symbol) {
  const checks = await Promise.all(timeframes.map(async (timeframe) => {
    const filePath = path.join(historyDirectory, `${symbol}-${timeframe}.csv`);
    try {
      const info = await stat(filePath);
      const ageMs = Date.now() - info.mtimeMs;
      return { timeframe, ready: info.size > 1024, bytes: info.size, age_ms: ageMs, fresh: ageMs <= 5 * 60_000 };
    } catch {
      return { timeframe, ready: false, bytes: 0, age_ms: null, fresh: false };
    }
  }));
  const researchReady = checks.some((item) => item.timeframe === 'M15' && item.ready && item.fresh) || checks.some((item) => item.timeframe === 'H1' && item.ready && item.fresh);
  return { symbol, research_ready: researchReady, coverage: checks };
}

async function tick() {
  cycles += 1;
  const snapshot = await inspectSnapshot();
  const markets = await Promise.all(symbols.map(inspectMarket));
  const readyMarkets = markets.filter((market) => market.research_ready).length;
  const alerts = [];
  if (!snapshot.fresh) alerts.push('MT4 quote snapshot is stale or unavailable.');
  if (snapshot.clock_status === 'unresolved') alerts.push('MT4 server clock is not verified; history must not be promoted to research decisions.');
  if (readyMarkets < 2) alerts.push(`Only ${readyMarkets}/6 markets have fresh M15 or H1 history.`);
  const status = !snapshot.fresh ? 'waiting-for-mt4' : snapshot.clock_status === 'unresolved' ? 'clock-not-verified' : readyMarkets < 2 ? 'history-building' : 'research-watch-ready';
  const payload = { version: '0.80', mode: 'read-only-background-research', status, updated_at: new Date().toISOString(), cycle: cycles, interval_seconds: Math.round(intervalMs / 1000), snapshot, ready_market_count: readyMarkets, markets, alerts, safety: { orders: false, account_reads: false, credential_storage: false, broker_connection: false } };
  await mkdir(enkeiDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[${payload.updated_at}] ${status}; ready markets ${readyMarkets}/6; alerts ${alerts.length}`);
}

async function run() {
  try { await tick(); } catch (error) { console.error('Supervisor cycle failed:', error); }
  setTimeout(run, intervalMs);
}

console.log(`Enkei background research supervisor started. Output: ${outputPath}`);
console.log('Read-only monitoring only: no orders, account reads, credentials, or broker connection.');
void run();
