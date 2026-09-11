import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

const port = Number(process.env.ENKEI_DEMO_GATE_PORT ?? 8790);
const commonDirectory = process.env.ENKEI_MT4_COMMON_DIR ?? path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const gateDirectory = path.join(commonDirectory, 'enkei', 'demo-execution');
const pendingPath = path.join(gateDirectory, 'pending-ticket.csv');
const closePath = path.join(gateDirectory, 'pending-close.csv');
const killPath = path.join(gateDirectory, 'KILL.switch');
const auditPath = path.join(gateDirectory, 'demo-execution-audit.csv');
const pairingPath = path.join(gateDirectory, 'pairing-session.json');
const positionSnapshotPath = path.join(gateDirectory, 'demo-position-snapshot.json');
const buildVersion = '1.7.0';
const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const allowedSymbols = new Set(['USDJPY', 'EURUSD', 'EURJPY', 'GBPUSD', 'GBPJPY', 'AUDJPY']);
// A local restart must not silently invalidate an already armed browser
// session.  The code remains loopback-only and never grants a live path, but
// is retained in the MT4 Common folder until the user deliberately removes it.
async function readExistingPairingCode() {
  try {
    const parsed = JSON.parse(await readFile(pairingPath, 'utf8'));
    return typeof parsed?.code === 'string' && /^[A-F0-9]{24,}$/i.test(parsed.code) ? parsed.code.toUpperCase() : null;
  } catch { return null; }
}
const pairingCode = process.env.ENKEI_DEMO_GATE_CODE ?? await readExistingPairingCode() ?? randomBytes(12).toString('hex').toUpperCase();

function normaliseSymbol(value) { return String(value ?? '').replace(/[^A-Za-z]/g, '').toUpperCase(); }
function csv(value) { return String(value).replace(/[\r\n,]/g, ''); }
function isPairingValid(request) { return request.headers['x-enkei-demo-code'] === pairingCode; }
function json(response, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Enkei-Demo-Code';
    headers['Access-Control-Max-Age'] = '600';
  }
  response.writeHead(status, headers); response.end(JSON.stringify(body));
}
async function readBody(request) {
  let content = '';
  for await (const chunk of request) { content += chunk; if (content.length > 8_192) throw new Error('Request too large.'); }
  return content ? JSON.parse(content) : {};
}
async function exists(filePath) { try { await stat(filePath); return true; } catch { return false; } }
async function killState() {
  try {
    const value = await readFile(killPath, 'utf8');
    if (/MANUAL-EMERGENCY/i.test(value)) return { active: true, reason: 'manual-emergency' };
    return { active: true, reason: 'startup-safe' };
  } catch { return { active: false, reason: null }; }
}
async function readAudit() {
  try { return (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).slice(-30).reverse().map((line) => line.split(',')); } catch { return []; }
}
async function readDemoPositions() {
  // MT4 may be replacing this small file during its one-second timer. Retry
  // briefly instead of treating that harmless write window as "no position".
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = JSON.parse(await readFile(positionSnapshotPath, 'utf8'));
      if (raw?.mode !== 'demo-only' || !Array.isArray(raw.positions)) return { updated_at: null, updated_at_epoch: null, positions: [], closed_positions: [] };
      const positions = raw.positions.filter((item) => item && typeof item.symbol === 'string' && Number.isFinite(Number(item.profit))).map((item) => ({ ticket: Number(item.ticket), policy_id: String(item.policy_id ?? ''), request_id: String(item.request_id ?? ''), timeframe: String(item.timeframe ?? ''), symbol: item.symbol, side: item.side === 'short' ? 'short' : 'long', lots: Number(item.lots), open_price: Number(item.open_price), current_price: Number(item.current_price), stop_loss: Number(item.stop_loss), take_profit: Number(item.take_profit), profit: Number(item.profit), swap: Number(item.swap), commission: Number(item.commission), spread_pips: Number(item.spread_pips), slippage_pips: Number(item.slippage_pips) }));
      const closed_positions = Array.isArray(raw.closed_positions) ? raw.closed_positions.filter((item) => item && typeof item.symbol === 'string' && Number.isFinite(Number(item.profit))).map((item) => ({ ticket: Number(item.ticket), policy_id: String(item.policy_id ?? ''), request_id: String(item.request_id ?? ''), timeframe: String(item.timeframe ?? ''), symbol: item.symbol, side: item.side === 'short' ? 'short' : 'long', lots: Number(item.lots), open_price: Number(item.open_price), close_price: Number(item.close_price), opened_at: String(item.opened_at ?? ''), closed_at: String(item.closed_at ?? ''), profit: Number(item.profit), swap: Number(item.swap), commission: Number(item.commission), spread_pips: Number(item.spread_pips), slippage_pips: Number(item.slippage_pips) })) : [];
      const account = raw.account && Number.isFinite(Number(raw.account.equity)) ? { balance: Number(raw.account.balance), equity: Number(raw.account.equity), free_margin: Number(raw.account.free_margin), margin: Number(raw.account.margin), leverage: Number(raw.account.leverage), currency: String(raw.account.currency ?? '') } : null;
      return { updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null, updated_at_epoch: Number.isFinite(Number(raw.updated_at_epoch)) ? Number(raw.updated_at_epoch) : null, account, positions, closed_positions };
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return { updated_at: null, updated_at_epoch: null, account: null, positions: [], closed_positions: [] };
}
async function expirePendingTicket() {
  try {
    const fields = (await readFile(pendingPath, 'utf8')).trim().split(',');
    const expiresAt = Number(fields[2]);
    if (Number.isFinite(expiresAt) && Math.floor(Date.now() / 1000) >= expiresAt) {
      await unlink(pendingPath);
      await appendAudit('ticket-expired', `${fields[0] ?? 'unknown'} cleared by local gate`);
      return true;
    }
  } catch {}
  return false;
}
async function expirePendingClose() {
  try {
    const fields = (await readFile(closePath, 'utf8')).trim().split(',');
    const expiresAt = Number(fields[2]);
    if (Number.isFinite(expiresAt) && Math.floor(Date.now() / 1000) >= expiresAt) {
      await unlink(closePath);
      await appendAudit('close-expired', `${fields[0] ?? 'unknown'} cleared by local gate`);
      return true;
    }
  } catch {}
  return false;
}
async function state() {
  await expirePendingTicket();
  await expirePendingClose();
  const pending = await exists(pendingPath);
  const closePending = await exists(closePath);
  const kill = await killState();
  const killed = kill.active;
  const demoPositions = await readDemoPositions();
  return { mode: 'demo-only-execution-gate', build_version: buildVersion, status: killed ? 'killed' : pending || closePending ? 'ticket-pending' : 'ready', pending, close_pending: closePending, killed, kill_reason: kill.reason, paired: true, limits: { max_lots: 1, min_lots: 0.01, max_positions: 10, max_pending_tickets: 1, ticket_ttl_seconds: 90 }, audit: await readAudit(), demo_account: demoPositions.account, demo_positions: demoPositions.positions, demo_closed_positions: demoPositions.closed_positions, demo_positions_updated_at: demoPositions.updated_at, demo_positions_updated_at_epoch: demoPositions.updated_at_epoch, safety: { live_accounts: false, automatic_entries: false, demo_position_view: true, credentials: false } };
}
function validateTicket(input) {
  const symbol = normaliseSymbol(input.symbol);
  const side = input.side === 'long' || input.side === 'short' ? input.side : null;
  const lots = Number(input.lots);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(input.takeProfit);
  const maxSpreadPips = Number(input.maxSpreadPips);
  const policyId = String(input.policyId ?? '').trim();
  const requestId = String(input.requestId ?? '').trim();
  const timeframe = input.timeframe === 'M5' || input.timeframe === 'M15' ? input.timeframe : null;
  if (!allowedSymbols.has(symbol)) throw new Error('Unsupported symbol.');
  if (!side) throw new Error('Side must be long or short.');
  if (!Number.isFinite(lots) || lots < .01 || lots > 1 || Math.round(lots * 100) !== lots * 100) throw new Error('Lots must be 0.01–1.00 in 0.01 steps.');
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || stopLoss <= 0 || takeProfit <= 0) throw new Error('Stop loss and target are required.');
  if (!Number.isFinite(maxSpreadPips) || maxSpreadPips < 0 || maxSpreadPips > 50) throw new Error('Maximum spread must be 0 (disabled) or 0.1–50.0 pips.');
  if (input.confirmation !== 'DEMO') throw new Error('Manual confirmation must equal DEMO.');
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(policyId) || !/^[A-Za-z0-9_-]{8,96}$/.test(requestId)) throw new Error('A valid policy and analysis request ID are required for Demo learning traceability.');
  if (!timeframe) throw new Error('Demo AI orders must use M5 or M15.');
  return { symbol, side, lots: lots.toFixed(2), stopLoss: stopLoss.toFixed(symbol.endsWith('JPY') ? 3 : 5), takeProfit: takeProfit.toFixed(symbol.endsWith('JPY') ? 3 : 5), maxSpreadPips: maxSpreadPips.toFixed(1), policyId, requestId, timeframe };
}
async function appendAudit(type, detail) { await appendFile(auditPath, `${new Date().toISOString()},GATE,${csv(type)},${csv(detail)}\n`, 'utf8'); }
async function submitTicket(request) {
  await expirePendingTicket();
  if (await exists(killPath)) throw new Error('Kill switch is active. Reset it before creating a new Demo ticket.');
  if (await exists(pendingPath)) throw new Error('A Demo ticket is already pending. Wait for EA acknowledgement or cancel it first.');
  const input = await readBody(request);
  const ticket = validateTicket(input);
  const id = randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 90;
  const row = [id, created, expires, ticket.symbol, ticket.side, ticket.lots, ticket.stopLoss, ticket.takeProfit, ticket.maxSpreadPips, ticket.policyId, ticket.requestId, ticket.timeframe].map(csv).join(',');
  const temporaryPath = `${pendingPath}.${id}.tmp`;
  await writeFile(temporaryPath, `${row}\n`, 'utf8');
  await rename(temporaryPath, pendingPath);
  await appendAudit('ticket-created', `${id} policy=${ticket.policyId} request=${ticket.requestId} ${ticket.symbol} ${ticket.side} ${ticket.lots}`);
  return { id, expires_at: new Date(expires * 1000).toISOString(), ...ticket };
}
async function submitClose(request) {
  await expirePendingClose();
  // 急停只阻止增加风险；已配对的一键平仓必须始终可用。
  if (await exists(closePath)) throw new Error('A Demo close action is already pending. Wait for EA acknowledgement first.');
  const input = await readBody(request);
  const ticket = Number(input.ticket);
  if (!Number.isInteger(ticket) || ticket < 0) throw new Error('A valid Demo ticket or 0 (all EA Demo positions) is required.');
  if (input.confirmation !== 'DEMO') throw new Error('Manual confirmation must equal DEMO.');
  const id = randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 90;
  const row = [id, created, expires, ticket].map(csv).join(',');
  const temporaryPath = `${closePath}.${id}.tmp`;
  await writeFile(temporaryPath, `${row}\n`, 'utf8');
  await rename(temporaryPath, closePath);
  await appendAudit('close-created', `${id} ticket=${ticket === 0 ? 'all-ea-demo-positions' : ticket}`);
  return { id, ticket, expires_at: new Date(expires * 1000).toISOString() };
}

await mkdir(gateDirectory, { recursive: true });
if (!(await exists(auditPath))) await writeFile(auditPath, 'time,actor,event,detail\n', 'utf8');
if (!(await exists(killPath))) await writeFile(killPath, `KILL STARTUP-SAFE ${new Date().toISOString()}\n`, 'utf8');
await writeFile(pairingPath, `${JSON.stringify({ code: pairingCode, created_at: new Date().toISOString(), mode: 'demo-only' })}\n`, 'utf8');
setInterval(() => { void expirePendingTicket(); }, 1_000);
setInterval(() => { void expirePendingClose(); }, 1_000);
createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === 'OPTIONS') return json(response, 204, {}, origin);
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/status' && request.method === 'GET') return json(response, 200, await state(), origin);
  if (!isPairingValid(request)) return json(response, 401, { error: 'Pairing code required.' }, origin);
  if (url.pathname === '/api/pair' && request.method === 'POST') return json(response, 200, await state(), origin);
  if (url.pathname === '/api/ticket' && request.method === 'POST') {
    try { return json(response, 201, { ticket: await submitTicket(request) }, origin); } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Ticket rejected.' }, origin); }
  }
  if (url.pathname === '/api/close' && request.method === 'POST') {
    try { return json(response, 201, { close: await submitClose(request) }, origin); } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Close action rejected.' }, origin); }
  }
  if (url.pathname === '/api/kill' && request.method === 'POST') {
    try { await unlink(pendingPath); } catch {}
    try { await unlink(closePath); } catch {}
    await writeFile(killPath, `KILL MANUAL-EMERGENCY ${new Date().toISOString()}\n`, 'utf8'); await appendAudit('kill-active', 'Manual emergency stop activated; pending entry cleared. Authenticated close-only remains available.'); return json(response, 200, await state(), origin);
  }
  if (url.pathname === '/api/kill/reset' && request.method === 'POST') {
    try { await unlink(killPath); } catch {} await appendAudit('kill-reset', 'Manual emergency stop reset.'); return json(response, 200, await state(), origin);
  }
  if (url.pathname === '/api/cancel' && request.method === 'POST') {
    try { await unlink(pendingPath); } catch {} try { await unlink(closePath); } catch {} await appendAudit('ticket-cancelled', 'Pending Demo action cancelled by user.'); return json(response, 200, await state(), origin);
  }
  return json(response, 404, { error: 'Not found.' }, origin);
}).listen(port, '127.0.0.1', () => {
  console.log(`Enkei Demo execution gate listening at http://127.0.0.1:${port}`);
  console.log(`PAIRING CODE (enter manually in the dashboard; do not save it): ${pairingCode}`);
  console.log('DEMO ONLY. One ticket, max 1.00 lots, 10 positions, 90-second expiry, local loopback only.');
});
