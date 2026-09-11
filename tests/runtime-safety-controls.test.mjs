import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('runtime controller exposes a managed shutdown endpoint', async () => {
  const source = await read('launcher/runtime-controller.mjs');
  assert.match(source, /url\.pathname === '\/api\/shutdown'/);
  assert.match(source, /await libreChatRuntime\.stop\(\)/);
  for (const service of ['ai_terminal', 'demo_gate', 'live_gate', 'decision_service', 'research_supervisor', 'quote_bridge', 'panel']) assert.match(source, new RegExp(`['"]${service}['"]`));
});

test('runtime supervisor keeps explicitly started execution gates alive without overlapping maintenance', async () => {
  const source = await read('launcher/runtime-controller.mjs');
  assert.match(source, /if \(shuttingDown \|\| maintenanceBusy\) return/);
  assert.match(source, /state\.demo_gate\?\.user_started === true/);
  assert.match(source, /state\.live_gate\?\.user_started === true/);
  assert.match(source, /state\.demo_gate = \{ \.\.\.state\.demo_gate, user_started: true \}/);
});

test('runtime controller and Demo gate agree on the compatible build version', async () => {
  const [controller, demoGate] = await Promise.all([read('launcher/runtime-controller.mjs'), read('bridge/demo-execution-gate.mjs')]);
  const controllerVersion = controller.match(/const demoGateBuildVersion = '([^']+)'/)?.[1];
  const gateVersion = demoGate.match(/const buildVersion = '([^']+)'/)?.[1];
  assert.ok(controllerVersion, 'controller Demo build version missing');
  assert.equal(controllerVersion, gateVersion, 'a mismatch makes every recovery request restart a healthy Demo gate');
});

test('Demo and live close-all controls use the guarded close route', async () => {
  const [demo, live, consoleSource] = await Promise.all([read('app/demo-execution-panel.tsx'), read('app/live-trading-panel.tsx'), read('app/command-center.tsx')]);
  assert.match(demo, /ticket: 0, confirmation: 'DEMO'/);
  assert.match(live, /ticket: 0, confirmation: 'LIVE', envMarker:/);
  assert.match(consoleSource, /closeDemoAll/);
  assert.match(consoleSource, /closeLiveAll/);
});

test('live entries fail closed on the formal server-side preflight', async () => {
  const source = await read('bridge/live-execution-gate.mjs');
  for (const check of ['enablement', 'emergency-stop', 'ea-account-snapshot', 'snapshot-freshness', 'account-lock', 'broker-lock', 'daily-loss-budget', 'model-link', 'event-risk', 'database-writable', 'safety-backup']) {
    assert.match(source, new RegExp(`id: '${check}'`));
  }
  assert.match(source, /if \(!preflight\.ready\) throw new Error/);
  assert.match(source, /snapshotAgeSeconds <= 15/);
  assert.match(source, /policy\.policy_id !== ticket\.policyId/);
  assert.match(source, /normal_policy_suspended === true/);
});

test('live MT4 outcomes preserve policy and request identity for learning', async () => {
  const [gate, ea, panel] = await Promise.all([
    read('bridge/live-execution-gate.mjs'), read('bridge/EnkeiLiveExecutionGate.mq4'), read('app/live-trading-panel.tsx'),
  ]);
  assert.match(gate, /policyId/); assert.match(gate, /requestId/);
  assert.match(gate, /M1 cannot produce an order/);
  assert.match(ea, /live-policy-map\.csv/);
  assert.match(ea, /SavePolicyMap\(orderTicket, policyId, requestId, timeframe, spreadPips, openPrice, OrderOpenPrice\(\)\)/);
  assert.match(ea, /spread_pips/);
  assert.match(ea, /slippage_pips/);
  assert.match(ea, /closed_positions/);
  assert.match(panel, /environment: 'live'/);
  assert.match(panel, /policy_id: position\.policy_id/);
});

test('emergency stop blocks entries but preserves authenticated close-only path', async () => {
  const [gate, ea, panel] = await Promise.all([read('bridge/live-execution-gate.mjs'), read('bridge/EnkeiLiveExecutionGate.mq4'), read('app/live-trading-panel.tsx')]);
  const closeSection = gate.slice(gate.indexOf('async function submitClose'), gate.indexOf('async function writeEnablement'));
  assert.doesNotMatch(closeSection, /Kill switch is active/);
  const eaCloseSection = ea.slice(ea.indexOf('void ProcessCloseAction'), ea.indexOf('void ProcessTicket'));
  assert.doesNotMatch(eaCloseSection, /if\(FileIsExist\(KillFile/);
  assert.doesNotMatch(panel, /!positions\.length \|\| gate\?\.killed \|\| gate\?\.close_pending/);
});

test('Demo emergency stop also preserves authenticated close-only path', async () => {
  const gate = await read('bridge/demo-execution-gate.mjs');
  const ea = await read('bridge/EnkeiDemoExecutionGate.mq4');
  const closeFn = gate.slice(gate.indexOf('async function submitClose'), gate.indexOf('await mkdir'));
  assert.doesNotMatch(closeFn, /Kill switch is active/);
  const eaClose = ea.slice(ea.indexOf('void ProcessCloseAction'), ea.indexOf('void ProcessTicket'));
  assert.doesNotMatch(eaClose, /FileIsExist\(KillFile/);
});
