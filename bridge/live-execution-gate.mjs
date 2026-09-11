import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

const port = Number(process.env.ENKEI_LIVE_GATE_PORT ?? 8791);
const commonDirectory = process.env.ENKEI_MT4_COMMON_DIR ?? path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const gateDirectory = path.join(commonDirectory, 'enkei', 'live-execution');
const pendingPath = path.join(gateDirectory, 'pending-live-ticket.csv');
const closePath = path.join(gateDirectory, 'pending-live-close.csv');
const killPath = path.join(gateDirectory, 'KILL.switch');
const auditPath = path.join(gateDirectory, 'live-execution-audit.csv');
const pairingPath = path.join(gateDirectory, 'pairing-session.json');
const enablementPath = path.join(gateDirectory, 'live-enablement.json');
// MT4 cannot parse JSON. The EA reads this flat CSV mirror of the same
// enablement state, refreshed on every enable/disable/startup write.
const enablementCsvPath = path.join(gateDirectory, 'live-enablement.flat');
const budgetPath = path.join(gateDirectory, 'live-daily-budget.json');
const accountSnapshotPath = path.join(gateDirectory, 'live-account-snapshot.json');
const safetyBackupPath = path.join(gateDirectory, 'live-safety-backup.json');
const buildVersion = '1.6.2';
const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const allowedSymbols = new Set(['USDJPY', 'EURUSD', 'EURJPY', 'GBPUSD', 'GBPJPY', 'AUDJPY']);

async function readExistingPairingCode() {
  try {
    const parsed = JSON.parse(await readFile(pairingPath, 'utf8'));
    return typeof parsed?.code === 'string' && /^[A-F0-9]{24,}$/i.test(parsed.code) ? parsed.code.toUpperCase() : null;
  } catch { return null; }
}
const pairingCode = process.env.ENKEI_LIVE_GATE_CODE ?? await readExistingPairingCode() ?? randomBytes(12).toString('hex').toUpperCase();

function normaliseSymbol(value) { return String(value ?? '').replace(/[^A-Za-z]/g, '').toUpperCase(); }
function csv(value) { return String(value).replace(/[\r\n,]/g, ''); }
function isPairingValid(request) { return request.headers['x-enkei-live-code'] === pairingCode; }
function json(response, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Enkei-Live-Code';
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
async function readEnablement() {
  try {
    const parsed = JSON.parse(await readFile(enablementPath, 'utf8'));
    const marker = String(parsed?.env_marker ?? '');
    return {
      active: parsed?.live_trading === true && /^LIVE-[A-F0-9]{8,}$/i.test(marker),
      live_trading: parsed?.live_trading === true,
      env_marker: marker.toUpperCase(),
      broker_name: String(parsed?.broker_name ?? ''),
      account_number: String(parsed?.account_number ?? ''),
      enabled_at: String(parsed?.enabled_at ?? ''),
    };
  } catch { return { active: false, live_trading: false, env_marker: '', broker_name: '', account_number: '', enabled_at: '' }; }
}
async function readDailyBudget() {
  try {
    const raw = JSON.parse(await readFile(budgetPath, 'utf8'));
    if (String(raw?.date) !== new Date().toISOString().slice(0, 10)) return { date: new Date().toISOString().slice(0, 10), realized_loss: 0, entries: 0, limit: Number(raw?.limit) || 0 };
    return { date: String(raw.date), realized_loss: Number(raw.realized_loss) || 0, entries: Number(raw.entries) || 0, limit: Number(raw.limit) || 0 };
  } catch { return { date: new Date().toISOString().slice(0, 10), realized_loss: 0, entries: 0, limit: 0 }; }
}
async function readLiveAccount() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = JSON.parse(await readFile(accountSnapshotPath, 'utf8'));
      if (raw?.mode !== 'live-only') return { updated_at: null, updated_at_epoch: null, account: null, positions: [], closed_positions: [] };
      return {
        updated_at: String(raw.updated_at ?? ''),
        updated_at_epoch: Number.isFinite(Number(raw.updated_at_epoch)) ? Number(raw.updated_at_epoch) : null,
        account: raw.account && typeof raw.account === 'object' ? raw.account : null,
        positions: Array.isArray(raw.positions) ? raw.positions : [],
        closed_positions: Array.isArray(raw.closed_positions) ? raw.closed_positions : [],
        today: raw.today && typeof raw.today === 'object' ? raw.today : null,
      };
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return { updated_at: null, updated_at_epoch: null, account: null, positions: [], closed_positions: [], today: null };
}
async function readAudit() {
  try { return (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).slice(-30).reverse().map((line) => line.split(',')); } catch { return []; }
}
async function fetchLoopbackJson(url) {
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2_500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function runtimeSafetyChecks() {
  const [health, triggerPayload] = await Promise.all([
    fetchLoopbackJson('http://127.0.0.1:8710/health'),
    fetchLoopbackJson('http://127.0.0.1:8710/v1/research/triggers?limit=200'),
  ]);
  const routing = health?.gateway ?? {};
  const modelReady = health?.service === 'ok' && (routing.librechat_ready === true || routing.local_fallback_enabled === true);
  const activeTriggers = Array.isArray(triggerPayload?.triggers) ? triggerPayload.triggers.filter((item) => item?.normal_policy_suspended === true) : [];
  let writable = false;
  const probe = path.join(gateDirectory, `.write-probe-${randomUUID()}`);
  try { await writeFile(probe, 'ok', 'utf8'); await unlink(probe); writable = true; } catch {}
  let backupAt = null;
  try { backupAt = JSON.parse(await readFile(safetyBackupPath, 'utf8'))?.created_at ?? null; } catch {}
  return [
    { id: 'model-link', passed: modelReady, detail: modelReady ? `${routing.primary_execution ?? 'configured'}` : 'no-verified-model-route' },
    { id: 'event-risk', passed: activeTriggers.length === 0, detail: activeTriggers.length ? `${activeTriggers.length}-active-trigger(s)` : 'clear' },
    { id: 'database-writable', passed: writable, detail: writable ? 'ready' : 'write-failed' },
    { id: 'safety-backup', passed: Boolean(backupAt), detail: backupAt ?? 'missing' },
  ];
}
async function livePreflight(enablement, liveAccount, budget, kill) {
  const updatedEpoch = Number(liveAccount.updated_at_epoch);
  const snapshotAgeSeconds = Number.isFinite(updatedEpoch) ? Math.max(0, Math.floor(Date.now() / 1000 - updatedEpoch)) : null;
  const accountLogin = String(liveAccount.account?.login ?? '');
  const accountServer = String(liveAccount.account?.server ?? '');
  const checks = [
    { id: 'enablement', passed: enablement.active, detail: enablement.active ? enablement.env_marker : 'live-path-locked' },
    { id: 'emergency-stop', passed: !kill.active, detail: kill.active ? String(kill.reason ?? 'kill-active') : 'clear' },
    { id: 'ea-account-snapshot', passed: Boolean(liveAccount.account), detail: liveAccount.account ? 'available' : 'missing' },
    { id: 'snapshot-freshness', passed: snapshotAgeSeconds !== null && snapshotAgeSeconds <= 15, detail: snapshotAgeSeconds === null ? 'unknown' : `${snapshotAgeSeconds}s` },
    { id: 'account-lock', passed: Boolean(accountLogin) && accountLogin === enablement.account_number, detail: accountLogin || 'missing' },
    { id: 'broker-lock', passed: Boolean(accountServer) && accountServer.toLowerCase().includes(enablement.broker_name.toLowerCase()), detail: accountServer || 'missing' },
    { id: 'daily-loss-budget', passed: Number(budget.limit) > 0 && Number(budget.realized_loss) < Number(budget.limit), detail: `${Number(budget.realized_loss).toFixed(2)}/${Number(budget.limit).toFixed(2)}` },
    ...(await runtimeSafetyChecks()),
  ];
  return { ready: checks.every((item) => item.passed), checked_at: new Date().toISOString(), snapshot_age_seconds: snapshotAgeSeconds, checks };
}
async function expirePendingTicket() {
  try {
    const fields = (await readFile(pendingPath, 'utf8')).trim().split(',');
    const expiresAt = Number(fields[2]);
    if (Number.isFinite(expiresAt) && Math.floor(Date.now() / 1000) >= expiresAt) {
      await unlink(pendingPath);
      await appendAudit('live-ticket-expired', `${fields[0] ?? 'unknown'} cleared by local gate`);
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
      await appendAudit('live-close-expired', `${fields[0] ?? 'unknown'} cleared by local gate`);
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
  const enablement = await readEnablement();
  const liveAccount = await readLiveAccount();
  const budget = await readDailyBudget();
  const killed = kill.active;
  const preflight = await livePreflight(enablement, liveAccount, budget, kill);
  return {
    mode: 'live-only-execution-gate',
    build_version: buildVersion,
    status: killed ? 'killed' : pending || closePending ? 'ticket-pending' : 'ready',
    pending, close_pending: closePending, killed, kill_reason: kill.reason,
    paired: true,
    limits: { max_lots: 1, min_lots: 0.01, max_positions: 10, max_pending_tickets: 1, ticket_ttl_seconds: 90 },
    live: {
      enablement_active: enablement.active,
      live_trading: enablement.live_trading,
      env_marker: enablement.env_marker,
      broker_name: enablement.broker_name,
      account_number: enablement.account_number,
      enabled_at: enablement.enabled_at,
    },
    daily_budget: budget,
    preflight,
    live_account: liveAccount.account,
    live_positions: liveAccount.positions,
    live_closed_positions: liveAccount.closed_positions,
    live_account_today: liveAccount.today,
    live_account_updated_at: liveAccount.updated_at,
    live_account_updated_at_epoch: liveAccount.updated_at_epoch,
    audit: await readAudit(),
    safety: { live_accounts: true, controlled_automatic_entries_supported: true, live_position_view: true, credentials: false, live_path_locked: !enablement.active, fail_closed: true },
  };
}
function validateTicket(input, enablement) {
  const symbol = normaliseSymbol(input.symbol);
  const side = input.side === 'long' || input.side === 'short' ? input.side : null;
  const lots = Number(input.lots);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(input.takeProfit);
  const maxSpreadPips = Number(input.maxSpreadPips);
  if (!enablement.active) throw new Error('Live path is locked. Enable live trading with a matching confirmation first.');
  if (String(input.envMarker ?? '').toUpperCase() !== enablement.env_marker) throw new Error('Environment marker mismatch. Refusing to submit a live intent.');
  if (!allowedSymbols.has(symbol)) throw new Error('Unsupported symbol.');
  if (!side) throw new Error('Side must be long or short.');
  if (!Number.isFinite(lots) || lots < .01 || lots > 1 || Math.round(lots * 100) !== lots * 100) throw new Error('Lots must be 0.01–1.00 in 0.01 steps.');
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || stopLoss <= 0 || takeProfit <= 0) throw new Error('Stop loss and target are required.');
  if (!Number.isFinite(maxSpreadPips) || maxSpreadPips < 0 || maxSpreadPips > 50) throw new Error('Maximum spread must be 0 (disabled) or 0.1–50.0 pips.');
  if (input.confirmation !== 'LIVE') throw new Error('Manual confirmation must equal LIVE.');
  const dailyLossLimit = Number(input.dailyLossLimit);
  if (!Number.isFinite(dailyLossLimit) || dailyLossLimit < 10) throw new Error('A daily loss limit of at least 10 is required for live intents.');
  const policyId = String(input.policyId ?? '').trim();
  const requestId = String(input.requestId ?? '').trim();
  const timeframe = input.timeframe === 'M5' || input.timeframe === 'M15' ? input.timeframe : null;
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(policyId)) throw new Error('A valid policy ID is required for live learning traceability.');
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(requestId)) throw new Error('A valid analysis request ID is required for live audit traceability.');
  if (!timeframe) throw new Error('Live decisions must use M5 or M15. M1 cannot produce an order.');
  return { symbol, side, lots: lots.toFixed(2), stopLoss: stopLoss.toFixed(symbol.endsWith('JPY') ? 3 : 5), takeProfit: takeProfit.toFixed(symbol.endsWith('JPY') ? 3 : 5), maxSpreadPips: maxSpreadPips.toFixed(1), dailyLossLimit: dailyLossLimit.toFixed(2), envMarker: enablement.env_marker, policyId, requestId, timeframe };
}
async function appendAudit(type, detail) { await appendFile(auditPath, `${new Date().toISOString()},GATE,${csv(type)},${csv(detail)}\n`, 'utf8'); }
// Flat mirror for the MQL4 EA (which has no JSON parser). Comparative check in
// the EA is authoritative; this mirror only reflects what the gate has already
// validated. Keep field order stable: live,env_marker,broker_name,account_number
async function writeEnablementFlat(active, envMarker, brokerName, accountNumber) {
  const temporaryPath = `${enablementCsvPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${active ? '1' : '0'},${envMarker},${csv(brokerName)},${csv(accountNumber)}\n`, 'utf8');
  await rename(temporaryPath, enablementCsvPath);
}
async function submitTicket(request, enablement) {
  await expirePendingTicket();
  if (await exists(killPath)) throw new Error('Kill switch is active. Reset it before creating a live intent.');
  if (!enablement.active) throw new Error('Live path is locked. Enable live trading first.');
  if (await exists(pendingPath)) throw new Error('A live intent is already pending. Wait for EA acknowledgement or cancel it first.');
  const budget = await readDailyBudget();
  if (budget.limit > 0 && budget.realized_loss >= budget.limit) throw new Error(`Daily loss limit reached (${budget.realized_loss.toFixed(2)} / ${budget.limit.toFixed(2)}). New live entries are blocked until tomorrow.`);
  const input = await readBody(request);
  const ticket = validateTicket(input, enablement);
  const preflight = await livePreflight(enablement, await readLiveAccount(), budget, await killState());
  if (!preflight.ready) throw new Error(`Live preflight failed: ${preflight.checks.filter((item) => !item.passed).map((item) => item.id).join(', ')}.`);
  const [policy, triggerPayload] = await Promise.all([
    fetchLoopbackJson(`http://127.0.0.1:8710/v1/policies/current?symbol=${encodeURIComponent(ticket.symbol)}&timeframe=${ticket.timeframe}`),
    fetchLoopbackJson(`http://127.0.0.1:8710/v1/research/triggers?symbol=${encodeURIComponent(ticket.symbol)}&limit=50`),
  ]);
  if (!policy || policy.policy_id !== ticket.policyId || policy.request_id !== ticket.requestId || policy.action_bias !== ticket.side || Date.parse(policy.expires_at) <= Date.now()) {
    throw new Error('The live intent does not match the terminal current policy identity, direction, or validity window.');
  }
  const activeSymbolTrigger = Array.isArray(triggerPayload?.triggers) && triggerPayload.triggers.some((item) => item?.normal_policy_suspended === true);
  if (activeSymbolTrigger) throw new Error('A planned event or unplanned anomaly has suspended the normal live policy for this symbol.');
  const id = randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 90;
  const row = [id, created, expires, ticket.symbol, ticket.side, ticket.lots, ticket.stopLoss, ticket.takeProfit, ticket.maxSpreadPips, ticket.envMarker, '1.6.2', ticket.dailyLossLimit, ticket.policyId, ticket.requestId, ticket.timeframe].map(csv).join(',');
  const temporaryPath = `${pendingPath}.${id}.tmp`;
  await writeFile(temporaryPath, `${row}\n`, 'utf8');
  await rename(temporaryPath, pendingPath);
  await appendAudit('live-ticket-created', `${id} policy=${ticket.policyId} request=${ticket.requestId} ${ticket.symbol} ${ticket.side} ${ticket.lots} daily-limit=${ticket.dailyLossLimit}`);
  return { id, expires_at: new Date(expires * 1000).toISOString(), ...ticket };
}
async function submitClose(request, enablement) {
  await expirePendingClose();
  // Emergency stop blocks new risk but deliberately keeps the authenticated
  // close-only path available so the user can flatten exposure immediately.
  if (!enablement.active) throw new Error('Live path is locked. Enable live trading first.');
  if (await exists(closePath)) throw new Error('A live close action is already pending. Wait for EA acknowledgement first.');
  const input = await readBody(request);
  const ticket = Number(input.ticket);
  if (!Number.isInteger(ticket) || ticket < 0) throw new Error('A valid live ticket or 0 (all EA live positions) is required.');
  if (input.confirmation !== 'LIVE') throw new Error('Manual confirmation must equal LIVE.');
  if (String(input.envMarker ?? '').toUpperCase() !== enablement.env_marker) throw new Error('Environment marker mismatch. Refusing to submit a live close action.');
  const id = randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 90;
  const row = [id, created, expires, ticket, enablement.env_marker].map(csv).join(',');
  const temporaryPath = `${closePath}.${id}.tmp`;
  await writeFile(temporaryPath, `${row}\n`, 'utf8');
  await rename(temporaryPath, closePath);
  await appendAudit('live-close-created', `${id} ticket=${ticket === 0 ? 'all-ea-live-positions' : ticket}`);
  return { id, ticket, env_marker: enablement.env_marker, expires_at: new Date(expires * 1000).toISOString() };
}

await mkdir(gateDirectory, { recursive: true });
if (!(await exists(auditPath))) await writeFile(auditPath, 'time,actor,event,detail\n', 'utf8');
if (!(await exists(killPath))) await writeFile(killPath, `KILL STARTUP-SAFE ${new Date().toISOString()}\n`, 'utf8');
if (!(await exists(enablementPath))) await writeFile(enablementPath, `${JSON.stringify({ live_trading: false, env_marker: '', broker_name: '', account_number: '', enabled_at: '', note: 'Live path starts locked. Flip live_trading to true with a matching broker/account to arm the adapter.' })}\n`, 'utf8');
if (!(await exists(safetyBackupPath))) await writeFile(safetyBackupPath, `${JSON.stringify({ created_at: new Date().toISOString(), kind: 'enkei-live-safety-backup/v1', enablement: await readEnablement(), budget: await readDailyBudget() })}\n`, 'utf8');
{
  const runningEnablement = await readEnablement();
  await writeEnablementFlat(runningEnablement.live_trading, runningEnablement.env_marker, runningEnablement.broker_name, runningEnablement.account_number);
}
await writeFile(pairingPath, `${JSON.stringify({ code: pairingCode, created_at: new Date().toISOString(), mode: 'live-only' })}\n`, 'utf8');
setInterval(() => { void expirePendingTicket(); }, 1_000);
setInterval(() => { void expirePendingClose(); }, 1_000);
createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === 'OPTIONS') return json(response, 204, {}, origin);
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/status' && request.method === 'GET') return json(response, 200, await state(), origin);
  if (!isPairingValid(request)) return json(response, 401, { error: 'Pairing code required.' }, origin);
  if (url.pathname === '/api/pair' && request.method === 'POST') return json(response, 200, await state(), origin);
  if (url.pathname === '/api/account' && request.method === 'GET') {
    // Read-only snapshot published by the paired EnkeiLiveExecutionGate EA.
    // Mirrors read-only account state; it never contains credentials.
    try { return json(response, 200, JSON.parse(await readFile(accountSnapshotPath, 'utf8')), origin); }
    catch { return json(response, 404, { error: 'No live account snapshot yet. Mount and run the live EA on the paired live account.' }, origin); }
  }
  if (url.pathname === '/api/enable' && request.method === 'POST') {
    try {
      const body = await readBody(request);
      const brokerName = String(body.brokerName ?? '').trim();
      const accountNumber = String(body.accountNumber ?? '').trim();
      if (body.confirmation !== 'LIVE') throw new Error('Manual confirmation must equal LIVE to enable the live path.');
      if (!brokerName) throw new Error('Broker name is required. It must match the MT4 account server (e.g. Rakuten).');
      if (!/^\d+$/.test(accountNumber)) throw new Error('A numeric account number is required to lock this path to one account.');
      const marker = `LIVE-${randomBytes(6).toString('hex').toUpperCase()}`;
      await writeFile(safetyBackupPath, `${JSON.stringify({ created_at: new Date().toISOString(), kind: 'enkei-live-safety-backup/v1', enablement: await readEnablement(), budget: await readDailyBudget() })}\n`, 'utf8');
      await writeFile(enablementPath, `${JSON.stringify({ live_trading: true, env_marker: marker, broker_name: brokerName, account_number: accountNumber, enabled_at: new Date().toISOString(), note: 'Armed by manual confirmation. The EA must still be mounted and enabled to execute.' })}\n`, 'utf8');
      await writeEnablementFlat(true, marker, brokerName, accountNumber);
      await appendAudit('live-enabled', `env_marker=${marker} broker=${csv(brokerName)} account=${accountNumber}`);
      return json(response, 201, { enabled: true, env_marker: marker, broker_name: brokerName, account_number: accountNumber, live: await state() }, origin);
    } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Enable rejected.' }, origin); }
  }
  if (url.pathname === '/api/disable' && request.method === 'POST') {
    try {
      const body = await readBody(request);
      if (body.confirmation !== 'DISABLE') throw new Error('Manual confirmation must equal DISABLE to unlock the live path.');
      await writeFile(enablementPath, `${JSON.stringify({ live_trading: false, env_marker: '', broker_name: '', account_number: '', enabled_at: '', disabled_at: new Date().toISOString(), note: 'Live path locked by user.' })}\n`, 'utf8');
      await writeEnablementFlat(false, '', '', '');
      try { await unlink(pendingPath); } catch {}
      try { await unlink(closePath); } catch {}
      await appendAudit('live-disabled', 'Live path locked; pending intents cleared.');
      return json(response, 200, { disabled: true, live: await state() }, origin);
    } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Disable rejected.' }, origin); }
  }
  if (url.pathname === '/api/ticket' && request.method === 'POST') {
    try { return json(response, 201, { ticket: await submitTicket(request, await readEnablement()) }, origin); } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Ticket rejected.' }, origin); }
  }
  if (url.pathname === '/api/close' && request.method === 'POST') {
    try { return json(response, 201, { close: await submitClose(request, await readEnablement()) }, origin); } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Close action rejected.' }, origin); }
  }
  if (url.pathname === '/api/kill' && request.method === 'POST') {
    try { await unlink(pendingPath); } catch {}
    try { await unlink(closePath); } catch {}
    await writeFile(killPath, `KILL MANUAL-EMERGENCY ${new Date().toISOString()}\n`, 'utf8'); await appendAudit('live-kill-active', 'Manual emergency stop activated; pending intent and close action cleared.'); return json(response, 200, await state(), origin);
  }
  if (url.pathname === '/api/kill/reset' && request.method === 'POST') {
    try { await unlink(killPath); } catch {} await appendAudit('live-kill-reset', 'Manual emergency stop reset.'); return json(response, 200, await state(), origin);
  }
  if (url.pathname === '/api/cancel' && request.method === 'POST') {
    try { await unlink(pendingPath); } catch {} try { await unlink(closePath); } catch {} await appendAudit('live-ticket-cancelled', 'Pending live action cancelled by user.'); return json(response, 200, await state(), origin);
  }
  return json(response, 404, { error: 'Not found.' }, origin);
}).listen(port, '127.0.0.1', () => {
  console.log(`Enkei LIVE execution gate listening at http://127.0.0.1:${port}`);
  console.log(`PAIRING CODE (enter manually in the dashboard; do not save it): ${pairingCode}`);
  console.log('LIVE PATH STARTS LOCKED. enablement false -> /api/ticket is rejected. Loopback only.');
});
