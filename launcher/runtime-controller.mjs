import { appendFile, access, mkdir, readFile, stat, rename, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { createLibreChatRuntime } from './librechat-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = path.join(root, 'enkei-startup-diagnostic.log');
const statePath = path.join(root, '.enkei-runtime.json');
const panelLogPath = path.join(root, 'enkei-panel-runtime.log');
const controlPort = 8787;
const allowedOrigins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const commonDirectory = path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const pairingPath = path.join(commonDirectory, 'enkei', 'demo-execution', 'pairing-session.json');
const livePairingPath = path.join(commonDirectory, 'enkei', 'live-execution', 'pairing-session.json');
const liveEnablementPath = path.join(commonDirectory, 'enkei', 'live-execution', 'live-enablement.json');
const npmCli = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;
const demoGateBuildVersion = '1.7.0';
const liveGateBuildVersion = '1.6.2';
// —— 内置 AI 终端：由程序内部按钮启停；端口可识别、可配置，不写死 ——
const aiTerminalDir = path.join(root, 'ai-terminal');
const defaultAiTerminalPort = 8710;
const aiTerminalPython = process.platform === 'win32'
  ? path.join(aiTerminalDir, '.venv', 'Scripts', 'python.exe')
  : path.join(aiTerminalDir, '.venv', 'bin', 'python');
// —— 内置决策服务（P1–P3）：包内 venv 独立于 AI 终端，端口 8792 ——
const decisionServiceDir = path.join(root, 'decision-service');
const decisionServicePort = 8792;
const decisionServicePython = process.platform === 'win32'
  ? path.join(decisionServiceDir, '.venv', 'Scripts', 'python.exe')
  : path.join(decisionServiceDir, '.venv', 'bin', 'python');
const decisionServiceRuntimeLog = path.join(root, 'enkei-decision-service-runtime.log');

async function log(code, message) { await appendFile(logPath, `${new Date().toISOString()} [${code}] ${message}\n`, 'utf8'); }
const libreChatRuntime = createLibreChatRuntime({ root, log });
let shuttingDown = false;
let maintenanceBusy = false;

// —— 日志轮转：仅在（重）启动子进程前执行，此时旧进程已退出、文件不被占用。——
const LOG_ROTATE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_ROTATE_KEEP = 2;
async function rotateLogIfNeeded(logFile) {
  try {
    const info = await stat(logFile).catch(() => null);
    if (!info || info.size < LOG_ROTATE_MAX_BYTES) return;
    for (let index = LOG_ROTATE_KEEP - 1; index >= 1; index -= 1) {
      await rename(`${logFile}.${index}`, `${logFile}.${index + 1}`).catch(() => {});
    }
    await rename(logFile, `${logFile}.1`).catch(() => {});
    await log('E000', `运行日志超过 ${Math.round(LOG_ROTATE_MAX_BYTES / 1024 / 1024)}MB，已轮转为 .1（保留 ${LOG_ROTATE_KEEP} 份）。`);
  } catch {
    // 轮转失败不应阻止启动；旧日志会继续追加。
  }
}
async function readState() { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return {}; } }
async function saveState(state) { await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function portOpen(port) { return new Promise((resolve) => { const socket = net.createConnection({ host: '127.0.0.1', port }); const done = (result) => { socket.destroy(); resolve(result); }; socket.setTimeout(350, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); }); }
function spawnDetached(command, args, writeOutput = false, cwd = null, extraEnv = {}) {
  const output = writeOutput ? openSync(typeof writeOutput === 'string' ? writeOutput : panelLogPath, 'a') : null;
  const child = spawn(command, args, { cwd: cwd ?? root, detached: true, windowsHide: true, stdio: output === null ? 'ignore' : ['ignore', output, output], env: { ...process.env, ...extraEnv } });
  if (output !== null) closeSync(output);
  child.once('error', (error) => { void log('E123', `面板进程无法启动：${error.message}`); });
  child.unref();
  return child.pid ?? 0;
}
async function fileExists(file) { try { await access(file); return true; } catch { return false; } }
async function aiTerminalSourceReady() {
  const required = [
    'run_terminal.py',
    'requirements.txt',
    path.join('app', 'main.py'),
    path.join('app', 'schemas.py'),
    path.join('app', 'evaluator.py'),
    path.join('app', 'research.py'),
  ];
  const missing = [];
  for (const relative of required) if (!(await fileExists(path.join(aiTerminalDir, relative)))) missing.push(relative);
  return { ready: missing.length === 0, missing };
}
async function aiTerminalDependenciesReady() {
  return new Promise((resolve) => {
    const child = spawn(aiTerminalPython, ['-c', 'import fastapi,uvicorn,jsonschema,httpx'], {
      cwd: aiTerminalDir,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}
async function decisionServiceSourceReady() {
  const required = [
    'app.py',
    'config.py',
    'decision_schema.py',
    'enkei_adapter.py',
    'ta_runner.py',
    'enkei_warehouse.py',
    path.join('research', 'run_backtest.py'),
    path.join('research', 'strategies.py'),
    path.join('vendor', 'tradingagents', 'pyproject.toml'),
  ];
  const missing = [];
  for (const relative of required) if (!(await fileExists(path.join(decisionServiceDir, relative)))) missing.push(relative);
  return { ready: missing.length === 0, missing };
}
async function decisionServiceDependenciesReady() {
  return new Promise((resolve) => {
    const child = spawn(decisionServicePython, ['-c', 'import fastapi,uvicorn,jsonschema,httpx,pandas,matplotlib,tabulate; import tradingagents'], {
      cwd: decisionServiceDir,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}
async function killTree(pid) {
  await new Promise((resolve) => {
    const args = process.platform === 'win32' ? ['/PID', String(pid), '/T', '/F'] : ['-p', String(pid)];
    const command = process.platform === 'win32' ? 'taskkill.exe' : 'kill';
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve()); child.once('exit', () => resolve());
  });
}
function gateBuild(port = 8790) {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}/api/status`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body).build_version ?? null); } catch { resolve(null); } });
    });
    request.setTimeout(700, () => { request.destroy(); resolve(null); });
    request.once('error', () => resolve(null));
  });
}
async function stopPreviousGate(gateMarker) {
  if (process.platform !== 'win32') return;
  const rootMarker = root.replaceAll("'", "''");
  // gateMarker is a compile-time regex-safe marker (e.g. 'demo-execution-gate\\.mjs').
  // Only a Node process launched as Enkei's own gate matches. This does not
  // touch MT4, existing positions, or unrelated local Node services.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$targets = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object {",
    "  $cmd = $_.CommandLine",
    `  $cmd -and ($cmd -like '*${rootMarker}*') -and ($cmd -match 'bridge[\\\\/]${gateMarker}')`,
    "}",
    "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "exit 0",
  ].join('; ');
  await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve()); child.once('exit', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}
async function stopPreviousDemoGate() { await stopPreviousGate('demo-execution-gate\\.mjs'); }
async function stopPreviousLiveGate() { await stopPreviousGate('live-execution-gate\\.mjs'); }
async function stopPreviousAiTerminal() {
  if (process.platform !== 'win32') return;
  const rootMarker = root.replaceAll("'", "''");
  // The AI terminal is a Python process detached from the controller.  A
  // stale PID in .enkei-runtime.json used to leave that process alive after
  // the user pressed Stop, making the page look as if it had restarted.  The
  // root marker keeps this limited to this Enkei installation's run_terminal.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$targets = Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" | Where-Object {",
    "  $cmd = $_.CommandLine",
    `  $cmd -and ($cmd -like '*${rootMarker}*') -and ($cmd -match 'run_terminal\\.py')`,
    "}",
    "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "exit 0",
  ].join('; ');
  await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve()); child.once('exit', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}
async function startService(name, command, args, port = null) {
  const state = await readState();
  if (port && await portOpen(port)) {
    // Earlier releases deliberately kept the confirmation gate running during
    // upgrades.  That leaves its old response schema on port 8790. Replace
    // only an older Enkei gate so the dashboard and MT4 snapshot agree.
    // A gate that is up but not yet answering /api/status returns null from
    // gateBuild().  Treating null as "old build" let the polling dashboard
    // kill every running gate (including a freshly spawned one), leaving
    // port 8790 permanently down while the panel kept retrying.  Only an
    // explicitly detected older build is replaced; an unresponsive-but-
    // present gate is left untouched.
    if (name === 'demo_gate') {
      const build = await gateBuild(8790);
      if (build !== null && build !== demoGateBuildVersion) await stopPreviousDemoGate();
      else return { status: 'already-running', pid: state[name]?.pid ?? null };
    } else if (name === 'live_gate') {
      const build = await gateBuild(8791);
      if (build !== null && build !== liveGateBuildVersion) await stopPreviousLiveGate();
      else return { status: 'already-running', pid: state[name]?.pid ?? null };
    } else return { status: 'already-running', pid: state[name]?.pid ?? null };
  }
  if (!port && alive(state[name]?.pid)) return { status: 'already-running', pid: state[name].pid };
  if (name === 'panel') {
    await rotateLogIfNeeded(panelLogPath);
    await appendFile(panelLogPath, `${new Date().toISOString()} [E000] 正在启动圆衡网页面板。\n`, 'utf8');
  }
  const pid = spawnDetached(
    command,
    args,
    name === 'panel',
    null,
    name === 'panel' ? { ENKEI_LOCAL_DESKTOP: '1' } : {},
  );
  state[name] = { pid, started_at: new Date().toISOString() };
  await saveState(state);
  await log('E000', `${name} 已由本机控制中心启动（PID ${pid}）。`);
  return { status: 'started', pid };
}
async function ensureCore() {
  await startService('quote_bridge', process.execPath, ['bridge/server.mjs'], 8788);
  await startService('research_supervisor', process.execPath, ['bridge/research-supervisor.mjs']);
  // The packaged desktop runtime serves the already-built production bundle.
  // Development mode can spend minutes rebuilding dependencies after a clean
  // install and also enables file watchers that ordinary users do not need.
  // Explicit loopback binding prevents the local financial dashboard from
  // being exposed to the LAN by vinext's production default (0.0.0.0).
  const panelArgs = ['run', 'start', '--', '--hostname', '127.0.0.1'];
  await startService('panel', npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...panelArgs] : panelArgs, 3000);
  await startDecisionService();
}
let decisionServiceReadyCache = null;
async function startDecisionService() {
  if (decisionServiceReadyCache === null) {
    const source = await decisionServiceSourceReady();
    if (!source.ready) {
      decisionServiceReadyCache = 'unavailable';
      await log('E130', `决策服务源码不完整：${source.missing.join('、')}，请重新下载完整分发包。`);
      return { status: 'unavailable', reason: `missing: ${source.missing.join('、')}` };
    }
    if (!(await fileExists(decisionServicePython))) {
      decisionServiceReadyCache = 'unavailable';
      await log('E130', '决策服务环境未安装；重新运行“Start-Enkei.cmd”将自动补装。');
      return { status: 'unavailable', reason: 'venv-not-installed' };
    }
    if (!(await decisionServiceDependenciesReady())) {
      decisionServiceReadyCache = 'unavailable';
      await log('E130', '决策服务依赖不完整；请重新运行“Start-Enkei.cmd”。');
      return { status: 'unavailable', reason: 'deps-incomplete' };
    }
    decisionServiceReadyCache = 'ready';
  }
  if (decisionServiceReadyCache !== 'ready') return { status: 'unavailable', reason: decisionServiceReadyCache };
  if (await portOpen(decisionServicePort)) {
    return { status: 'running', pid: (await readState()).decision_service?.pid ?? null };
  }
  const state = await readState();
  const lastAttempt = Date.parse(state.decision_service?.started_at ?? '');
  if (!await portOpen(decisionServicePort) && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 60_000) {
    return { status: 'starting', pid: state.decision_service?.pid ?? null };
  }
  await rotateLogIfNeeded(decisionServiceRuntimeLog);
  const pid = spawnDetached(decisionServicePython, [
    '-m', 'uvicorn', 'app:app',
    '--app-dir', path.join(root, 'decision-service'),
    '--host', '127.0.0.1', '--port', String(decisionServicePort),
  ], decisionServiceRuntimeLog, decisionServiceDir);
  state.decision_service = { pid, started_at: new Date().toISOString() };
  await saveState(state);
  await log('E000', `decision_service 已由本机控制中心启动（PID ${pid}）。`);
  return { status: 'started', pid };
}
async function ensureCompatibleDemoGate() {
  if (!(await portOpen(8790))) return;
  if (await gateBuild() === demoGateBuildVersion) return;
  await stopPreviousDemoGate();
  await startService('demo_gate', process.execPath, ['bridge/demo-execution-gate.mjs'], 8790);
  await log('E000', `已将旧版 Demo 确认服务更新为 ${demoGateBuildVersion}；MT4 持仓不会被改动。`);
}
async function ensureCompatibleLiveGate() {
  if (!(await portOpen(8791))) return;
  if (await gateBuild(8791) === liveGateBuildVersion) return;
  await stopPreviousLiveGate();
  await startService('live_gate', process.execPath, ['bridge/live-execution-gate.mjs'], 8791);
  await log('E000', `已将旧版实盘确认服务更新为 ${liveGateBuildVersion}。`);
}
async function maintainBackgroundServices() {
  if (shuttingDown || maintenanceBusy) return;
  maintenanceBusy = true;
  try {
  // These are read-only services.  A restart never creates a trade and avoids
  // leaving an otherwise healthy long-running dashboard without its market
  // bridge or research supervisor after a transient process exit.
  await startService('quote_bridge', process.execPath, ['bridge/server.mjs'], 8788);
  await startService('research_supervisor', process.execPath, ['bridge/research-supervisor.mjs']);
  await startDecisionService();
  // The live gate only stays alive while the user has explicitly started it.
  // A transient crash is auto-restored; a stale record can never start it.
  const state = await readState();
  if (state.demo_gate?.user_started === true) {
    await startService('demo_gate', process.execPath, ['bridge/demo-execution-gate.mjs'], 8790);
  }
  if (state.live_gate?.user_started === true) {
    await startService('live_gate', process.execPath, ['bridge/live-execution-gate.mjs'], 8791);
  }
  } finally {
    maintenanceBusy = false;
  }
}
// —— 内置 AI 终端：默认随圆衡启动；用户主动关闭后才保持关闭 ——
function validLocalPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}
function aiEndpoint(port) { return `http://127.0.0.1:${port}`; }
async function terminalHealthAt(port) {
  return new Promise((resolve) => {
    const request = get(`${aiEndpoint(port)}/health`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(body);
          resolve(response.statusCode === 200 && payload?.service === 'ok' ? { port, endpoint: aiEndpoint(port), health: payload } : null);
        } catch { resolve(null); }
      });
    });
    // /health intentionally includes gateway/model availability.  On a busy
    // local model host it may take longer than a bare socket probe, so a
    // sub-second timeout would incorrectly classify a healthy terminal as
    // missing and cause the supervisor to launch a duplicate instance.
    request.setTimeout(2_500, () => { request.destroy(); resolve(null); });
    request.once('error', () => resolve(null));
  });
}
async function discoverAiTerminal(state = null) {
  const currentState = state ?? await readState();
  // 已登记的运行时只能探测登记端口；不要让遗留/其他项目的终端被扫描后抢走 UI。
  const saved = validLocalPort(currentState.ai_terminal?.port);
  const candidates = saved ? [saved] : [defaultAiTerminalPort, ...Array.from({ length: 21 }, (_, index) => 8700 + index)];
  const results = await Promise.all(candidates.map((port) => terminalHealthAt(port)));
  return results.filter(Boolean);
}
async function startAiTerminal(requestedPort = null) {
  const state = await readState();
  const explicitlyRequested = validLocalPort(requestedPort);
  let aiTerminalPort = explicitlyRequested ?? validLocalPort(state.ai_terminal?.port) ?? defaultAiTerminalPort;
  let existing = await terminalHealthAt(aiTerminalPort);
  if (existing) {
    state.ai_terminal = { ...state.ai_terminal, auto_start: true, port: aiTerminalPort, endpoint: aiEndpoint(aiTerminalPort), last_start_error: null, last_start_error_at: null };
    await saveState(state);
    if (alive(state.ai_terminal?.pid)) return { status: 'already-running', pid: state.ai_terminal.pid, ...existing };
    return { status: 'already-running', pid: null, ...existing, note: `已识别到本机 AI 终端：${existing.endpoint}` };
  }
  // 首次安装没有保存端口时，才允许发现已有终端。已保存端口失效时必须在
  // 该端口重启，不能静默接管旧会话或另一安装的 8700–8740 服务。
  const hasSavedPort = Boolean(validLocalPort(state.ai_terminal?.port));
  if (!explicitlyRequested && !hasSavedPort) {
    const candidates = [...new Set([defaultAiTerminalPort, ...Array.from({ length: 41 }, (_, index) => 8700 + index)])];
    const discovered = await Promise.all(candidates.map((port) => terminalHealthAt(port)));
    const healthy = discovered.find(Boolean);
    if (healthy) {
      state.ai_terminal = { ...state.ai_terminal, auto_start: true, port: healthy.port, endpoint: healthy.endpoint, last_start_error: null, last_start_error_at: null };
      await saveState(state);
      return { status: 'already-running', pid: null, ...healthy, note: `已自动识别本机 AI 终端：${healthy.endpoint}` };
    }
  }
  if (await portOpen(aiTerminalPort)) {
    // A button press with a typed port must remain predictable.  Background
    // startup, however, should not get stuck forever because another local
    // Python service happened to use the historical default 8710.
    if (explicitlyRequested) return { status: 'error', error: `端口 ${aiTerminalPort} 已被其他本机程序占用，不能启动 AI 终端。请改用其他端口。` };
    return { status: 'error', error: `受管 AI 终端端口 ${aiTerminalPort} 被其他程序占用，未接管该程序。请通过“一键配装”修复或选择明确的新端口。` };
  }
  const terminalSource = await aiTerminalSourceReady();
  if (!terminalSource.ready) {
    return { status: 'error', code: 'E206', error: `AI 终端源码不完整：缺少 ${terminalSource.missing.join('、')}。请重新运行“一键配装”。` };
  }
  if (!(await fileExists(aiTerminalPython))) {
    return { status: 'error', code: 'E207', error: 'AI 终端尚未完成首次安装。请重新运行程序根目录的“Start-Enkei.cmd”。' };
  }
  if (!(await aiTerminalDependenciesReady())) {
    return { status: 'error', code: 'E208', error: 'AI 终端运行组件不完整。请重新运行程序根目录的“Start-Enkei.cmd”；不要反复点击启动按钮。' };
  }
  const aiTerminalRuntimeLog = path.join(root, 'enkei-ai-terminal-runtime.log');
  await rotateLogIfNeeded(aiTerminalRuntimeLog);
  const pid = spawnDetached(aiTerminalPython, ['run_terminal.py'], aiTerminalRuntimeLog, aiTerminalDir, { ENKEI_AI_TERMINAL_PORT: String(aiTerminalPort) });
  state.ai_terminal = { pid, port: aiTerminalPort, endpoint: aiEndpoint(aiTerminalPort), auto_start: true, started_at: new Date().toISOString(), last_start_error: null, last_start_error_at: null };
  await saveState(state);
  await log('E000', `AI 终端启动指令已发出（PID ${pid}）。`);
  for (let attempt = 0; attempt < 40 && !(await portOpen(aiTerminalPort)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 300));
  const ready = await terminalHealthAt(aiTerminalPort);
  return ready
    ? { status: 'started', pid, ...ready }
    : { status: 'starting', pid, note: '启动已发起，端口尚未就绪（首次加载模型环境需要时间）' };
}
async function stopAiTerminal() {
  let state = await readState();
  const aiTerminalPort = validLocalPort(state.ai_terminal?.port) ?? defaultAiTerminalPort;
  const stoppedAt = new Date().toISOString();
  // Persist intent before touching a process.  The 15-second maintenance pass
  // may already be running; this marker prevents a later pass from bringing a
  // terminal back after an explicit user stop.
  state.ai_terminal = { ...state.ai_terminal, port: aiTerminalPort, endpoint: aiEndpoint(aiTerminalPort), auto_start: false, stopped_at: stoppedAt };
  await saveState(state);
  if (aiTerminalMaintenanceTask) await aiTerminalMaintenanceTask.catch(() => {});
  state = await readState();
  const pid = state.ai_terminal?.pid;
  if (pid && alive(pid)) {
    await killTree(pid);
  }
  // PID ownership can be stale after a controller restart.  Clean only this
  // installation's detached terminal process; unrelated Python processes are
  // never considered.
  await stopPreviousAiTerminal();
  for (let attempt = 0; attempt < 20 && (await portOpen(aiTerminalPort)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  // Re-write the marker after any in-flight maintenance pass has completed.
  // This is the final authority for an explicit Stop action.
  state = await readState();
  state.ai_terminal = { ...state.ai_terminal, pid: null, port: aiTerminalPort, endpoint: aiEndpoint(aiTerminalPort), auto_start: false, stopped_at: stoppedAt };
  await saveState(state);
  const stillOpen = await portOpen(aiTerminalPort);
  await log('E000', `AI 终端关闭指令已执行（PID ${pid ?? 'unknown'}，端口${stillOpen ? '仍占用' : '已释放'}）。`);
  return stillOpen ? { status: 'stopping', note: '端口尚未释放，稍后重试' } : { status: 'stopped' };
}
let aiTerminalMaintenanceTask = null;
async function maintainAiTerminal() {
  if (shuttingDown) return;
  // The initial bootstrap, the 15-second supervisor and a manual retry can
  // overlap.  Serialise them so they cannot each select a different fallback
  // port and launch duplicate terminal processes.
  if (aiTerminalMaintenanceTask) return aiTerminalMaintenanceTask;
  aiTerminalMaintenanceTask = (async () => {
    const state = await readState();
    if (state.ai_terminal?.auto_start === false) return;
    const launchingPort = validLocalPort(state.ai_terminal?.port);
    const launchedAt = Date.parse(state.ai_terminal?.started_at ?? '');
    // Uvicorn can take several seconds to create its listening socket on a
    // first launch.  During that grace period a port may be open before health
    // is answerable; do not mistake it for a foreign service and create a new
    // terminal on every background pass.
    if (launchingPort && Number.isFinite(launchedAt) && Date.now() - launchedAt < 60_000 && await portOpen(launchingPort)) return;
    const result = await startAiTerminal();
    if (result.status === 'error') {
      const previous = state.ai_terminal?.last_start_error;
      state.ai_terminal = { ...state.ai_terminal, auto_start: true, last_start_error: result.error, last_start_error_at: new Date().toISOString() };
      await saveState(state);
      // Do not fill the diagnostic log every 15 seconds with the same missing
      // dependency message.  It is still exposed through /api/status.
      if (previous !== result.error) await log(result.code ?? 'E209', `AI 终端未自动启动：${result.error}`);
    }
  })().finally(() => { aiTerminalMaintenanceTask = null; });
  return aiTerminalMaintenanceTask;
}
async function readPairingCode() {
  try {
    const parsed = JSON.parse(await readFile(pairingPath, 'utf8'));
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch { return null; }
}
async function readLiveEnablement() {
  try {
    const parsed = JSON.parse(await readFile(liveEnablementPath, 'utf8'));
    return { enabled: parsed.live_trading === true, env_marker: parsed.env_marker ?? '', broker_name: parsed.broker_name ?? '', account_number: parsed.account_number ?? '' };
  } catch { return { enabled: false, env_marker: '', broker_name: '', account_number: '' }; }
}
async function readLivePairingCode() {
  try {
    const parsed = JSON.parse(await readFile(livePairingPath, 'utf8'));
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch { return null; }
}
async function stopLiveGate() {
  const state = await readState();
  const pid = state.live_gate?.pid;
  if (pid && alive(pid)) await killTree(pid);
  await stopPreviousLiveGate();
  for (let attempt = 0; attempt < 20 && (await portOpen(8791)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  state.live_gate = { ...state.live_gate, user_started: false, stopped_at: new Date().toISOString() };
  await saveState(state);
  const stillOpen = await portOpen(8791);
  await log('E000', `实盘确认网关关闭指令已执行（PID ${pid ?? 'unknown'}${stillOpen ? '，端口仍占用' : ''}）。`);
  return stillOpen ? { status: 'stopping', note: '端口尚未释放，稍后重试' } : { status: 'stopped' };
}
function json(response, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) { headers['Access-Control-Allow-Origin'] = origin; headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'; headers['Access-Control-Allow-Headers'] = 'Content-Type'; }
  response.writeHead(status, headers); response.end(JSON.stringify(body));
}

async function shutdownAll() {
  shuttingDown = true;
  let state = await readState();
  const stoppedAt = new Date().toISOString();
  state.ai_terminal = { ...state.ai_terminal, auto_start: false, stopped_at: stoppedAt };
  state.live_gate = { ...state.live_gate, user_started: false, stopped_at: stoppedAt };
  state.shutdown = { requested_at: stoppedAt, status: 'stopping' };
  await saveState(state);
  await libreChatRuntime.stop().catch((error) => log('E156', `LibreChat 关闭异常：${error instanceof Error ? error.message : String(error)}`));
  state = await readState();
  const managedNames = ['ai_terminal', 'demo_gate', 'live_gate', 'decision_service', 'research_supervisor', 'quote_bridge', 'panel'];
  const managedPids = [...new Set(managedNames.map((name) => Number(state[name]?.pid)).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  for (const pid of managedPids) if (alive(pid)) await killTree(pid);
  await stopPreviousAiTerminal();
  await stopPreviousDemoGate();
  await stopPreviousLiveGate();
  state = await readState();
  for (const name of managedNames) state[name] = { ...state[name], pid: null, stopped_at: stoppedAt };
  state.shutdown = { requested_at: stoppedAt, completed_at: new Date().toISOString(), status: 'stopped' };
  await saveState(state);
  await log('E000', '用户执行“一键关闭应用”：圆衡受管进程已全部停止。');
}
function allowed(request) { return !request.headers.origin || allowedOrigins.has(request.headers.origin); }
async function requestJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

await mkdir(path.dirname(statePath), { recursive: true });
await ensureCore();
await ensureCompatibleDemoGate();
await ensureCompatibleLiveGate();
void maintainAiTerminal().catch((error) => void log('E125', `AI 终端自动启动失败：${error instanceof Error ? error.message : String(error)}`));
void libreChatRuntime.maintain({ force: true }).catch((error) => void log('E155', `LibreChat 后台恢复失败：${error instanceof Error ? error.message : String(error)}`));
setInterval(() => {
  void maintainBackgroundServices().catch((error) => void log('E124', `后台服务守护失败：${error instanceof Error ? error.message : String(error)}`));
  void maintainAiTerminal().catch((error) => void log('E125', `AI 终端后台守护失败：${error instanceof Error ? error.message : String(error)}`));
}, 15_000);
setInterval(() => {
  void libreChatRuntime.maintain().catch((error) => void log('E155', `LibreChat 后台守护失败：${error instanceof Error ? error.message : String(error)}`));
}, 60_000);
createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === 'OPTIONS') return json(response, 204, {}, origin);
  if (!allowed(request)) return json(response, 403, { error: 'Local panel origin required.' }, origin);
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${controlPort}`);
  if (url.pathname === '/api/status' && request.method === 'GET') {
    const state = await readState(); const aiPort = validLocalPort(state.ai_terminal?.port) ?? defaultAiTerminalPort; const ai = await terminalHealthAt(aiPort); const source = await aiTerminalSourceReady(); const liveEnablement = await readLiveEnablement();
    return json(response, 200, { mode: 'local-runtime-controller', services: { quote_bridge: await portOpen(8788), panel: await portOpen(3000), demo_gate: await portOpen(8790), live_gate: await portOpen(8791), decision_service: await portOpen(decisionServicePort), supervisor: alive(state.research_supervisor?.pid), ai_terminal: Boolean(ai), librechat: libreChatRuntime.status().ready }, ai_terminal: { endpoint: ai?.endpoint ?? state.ai_terminal?.endpoint ?? aiEndpoint(aiPort), port: ai?.port ?? aiPort, running: Boolean(ai), auto_start: state.ai_terminal?.auto_start !== false, source_ready: source.ready, missing_source: source.missing, last_start_error: state.ai_terminal?.last_start_error ?? null }, librechat: libreChatRuntime.status(), safety: { live_trading: liveEnablement.enabled, demo_gate_default: 'off', auto_demo_gate_start: true, manual_emergency_stop_never_auto_released: true }, live_enablement: liveEnablement }, origin);
  }
  if (url.pathname === '/api/ai/discover' && request.method === 'GET') return json(response, 200, { terminals: await discoverAiTerminal() }, origin);
  if (url.pathname === '/api/ai/start' && request.method === 'POST') { const body = await requestJson(request); return json(response, 200, await startAiTerminal(body.port), origin); }
  if (url.pathname === '/api/ai/stop' && request.method === 'POST') return json(response, 200, await stopAiTerminal(), origin);
  if (url.pathname === '/api/shutdown' && request.method === 'POST') {
    if (shuttingDown) return json(response, 202, { status: 'stopping' }, origin);
    json(response, 202, { status: 'stopping', note: '圆衡正在关闭全部受管进程与应用。' }, origin);
    setTimeout(() => { void shutdownAll().finally(() => process.exit(0)); }, 150);
    return;
  }
  if (url.pathname === '/api/librechat/retry' && request.method === 'POST') return json(response, 200, await libreChatRuntime.maintain({ force: true }), origin);
  if (url.pathname === '/api/demo/start' && request.method === 'POST') {
    const service = await startService('demo_gate', process.execPath, ['bridge/demo-execution-gate.mjs'], 8790);
    for (let attempt = 0; attempt < 10 && !(await portOpen(8790)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    if (service.status === 'started' || service.status === 'already-running') {
      const state = await readState();
      state.demo_gate = { ...state.demo_gate, user_started: true };
      await saveState(state);
    }
    return json(response, 200, { ...service, pairing_code: await readPairingCode(), mode: 'demo-only', note: 'Demo gate starts locked. Pairing alone cannot place an order.' }, origin);
  }
  if (url.pathname === '/api/live/start' && request.method === 'POST') {
    const service = await startService('live_gate', process.execPath, ['bridge/live-execution-gate.mjs'], 8791);
    for (let attempt = 0; attempt < 10 && !(await portOpen(8791)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    if (service.status === 'started' || service.status === 'already-running') {
      const state = await readState();
      state.live_gate = { ...state.live_gate, user_started: true, started_at: new Date().toISOString() };
      await saveState(state);
      await log('E000', '实盘确认网关已启动。下单仍被全局锁定，直到启用匹配账户。');
    }
    const enablement = await readLiveEnablement();
    return json(response, 200, { ...service, pairing_code: await readLivePairingCode(), mode: 'live-only', safety: enablement, note: 'Live gate serves only the locally paired EA; it stays locked until a matching broker/account is armed.' }, origin);
  }
  if (url.pathname === '/api/live/stop' && request.method === 'POST') return json(response, 200, await stopLiveGate(), origin);
  if (url.pathname === '/api/live/status' && request.method === 'GET') return json(response, 200, { running: await portOpen(8791), safety: await readLiveEnablement(), mode: 'live-only' }, origin);
  return json(response, 404, { error: 'Not found.' }, origin);
}).listen(controlPort, '127.0.0.1', () => { void log('E000', `本机控制中心已就绪：http://127.0.0.1:${controlPort}`); });
