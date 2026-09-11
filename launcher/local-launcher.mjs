import { appendFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

// The root comes from this file's physical location, not the current command
// window.  That keeps a freshly extracted package runnable even when Windows
// launches it from a different directory.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = path.join(root, 'enkei-startup-diagnostic.log');
const runtimePath = path.join(root, 'launcher', 'runtime-controller.mjs');
const selfCheckPath = path.join(root, 'public', 'runtime-self-check.json');
const vinextLockPath = path.join(root, '.vinext', 'dev', 'lock.json');
const npmCli = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;

async function log(code, message) {
  const line = `${new Date().toISOString()} [${code}] ${message}\n`;
  await appendFile(logPath, line, 'utf8');
  process.stdout.write(line);
}

async function startupSelfCheck() {
  // Only runtime dependencies belong in the blocking check.  Documentation is
  // intentionally optional so a trimmed release does not fail to start.
  const required = ['package.json', 'app/dashboard.tsx', 'bridge/server.mjs', 'bridge/research-supervisor.mjs', 'bridge/demo-execution-gate.mjs', 'ai-terminal/run_terminal.py', 'ai-terminal/requirements.txt', 'ai-terminal/app/evaluator.py', 'ai-terminal/app/research.py'];
  const checks = await Promise.all(required.map(async (name) => {
    try { await stat(path.join(root, name)); return { name, ok: true }; } catch { return { name, ok: false }; }
  }));
  const report = { version: '1.6.0-first-run', checkedAt: new Date().toISOString(), status: checks.every((item) => item.ok) ? 'passed' : 'failed', checks };
  // A clean release archive may not retain an otherwise empty `public`
  // directory.  Create it before emitting the diagnostic instead of making
  // first launch fail with ENOENT.
  await mkdir(path.dirname(selfCheckPath), { recursive: true });
  await writeFile(selfCheckPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await log(report.status === 'passed' ? 'E000' : 'E121', report.status === 'passed' ? '启动自检通过：运行组件完整。' : '启动自检未通过：请查看 runtime-self-check.json。');
  return report.status === 'passed';
}

function run(command, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
      child.once('error', () => resolve(127));
      child.once('exit', (code) => resolve(code ?? 1));
    } catch { resolve(127); }
  });
}

function requestPanel() {
  return new Promise((resolve) => {
    const request = http.get('http://127.0.0.1:3000/', (response) => {
      response.resume();
      resolve(response.statusCode && response.statusCode < 500);
    });
    request.setTimeout(900, () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
      response.resume();
      resolve(true);
    });
    request.setTimeout(500, () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

async function waitForRuntimePortsToClose() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const occupied = await Promise.all([3000, 8710, 8787, 8788, 8792].map(portOpen));
    if (occupied.every((value) => !value)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitForPanel() {
  // A fresh local installation can spend more than 45 seconds compiling the
  // first browser bundle after `npm ci`. Do not report a false startup failure
  // while that one-time preparation is still running.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await requestPanel()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function openBrowser() {
  const url = 'http://127.0.0.1:3000/';
  let command = 'xdg-open';
  let args = [url];
  if (process.platform === 'win32') {
    const browser = [
      path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].find((candidate) => candidate && existsSync(candidate));
    command = browser ?? 'rundll32.exe';
    args = browser ? [url] : ['url.dll,FileProtocolHandler', url];
  }
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.once('error', (error) => { void log('E141', `Browser could not be opened automatically: ${error.message}`); });
  child.unref();
}

// A previous extracted release can keep its panel alive from a sibling version
// directory. Stop only Enkei's own panel/controller/bridge/supervisor processes;
// never touch the Demo execution gate or unrelated Node applications.
async function stopPreviousEnkeiRuntime() {
  if (process.platform !== 'win32') return;
  const familyMarker = path.dirname(root).replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$portPids = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(3000, 8710, 8787, 8788, 8792) } | Select-Object -ExpandProperty OwningProcess -Unique)",
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  $cmd = $_.CommandLine",
    `  $isEnkeiFamily = $cmd -and ($cmd -like '*${familyMarker}*')`,
    "  $isKnownPythonPort = ($_.Name -eq 'python.exe') -and ($portPids -contains $_.ProcessId) -and (@(8710, 8792) -contains [int](Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId | Select-Object -First 1 -ExpandProperty LocalPort))",
    "  $isRuntime = (($_.Name -in @('node.exe', 'cmd.exe', 'python.exe')) -and ($cmd -match 'launcher[\\\\/]runtime-controller\\.mjs|bridge[\\\\/]server\\.mjs|bridge[\\\\/]research-supervisor\\.mjs|node_modules[\\\\/].*vinext.*cli\\.js|ai-terminal.*app\\.main|decision-service.*app:app')) -or $isKnownPythonPort",
    "  $isRuntime -and ($isEnkeiFamily -or ($portPids -contains $_.ProcessId))",
    "}",
    "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "exit 0",
  ].join('; ');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (!(await waitForRuntimePortsToClose())) {
    await log('E142', '旧版本仍占用本机端口 3000、8710、8787、8788 或 8792；为避免混用旧服务，本次启动已停止。');
    process.exit(1);
  }
}

// Vinext records the development server PID in this local lock.  Windows can
// leave that file behind when the prior Enkei panel is stopped during an
// upgrade, which makes a healthy new panel incorrectly refuse to start.
async function clearStoppedPanelLock() {
  try {
    await unlink(vinextLockPath);
    await log('E000', '已清理旧版面板残留启动锁。');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      await log('E122', '无法清理旧版面板启动锁；将继续尝试启动。');
    }
  }
}

try {
  await writeFile(logPath, `${new Date().toISOString()} [E000] 圆衡启动诊断开始。\n`, 'utf8');
  await stat(path.join(root, 'node_modules', 'vinext', 'package.json'));
} catch {
  await log('E110', 'Preparing local components / ローカル実行環境を準備中 / 正在准备本地运行组件。First launch may take a few minutes.');
  const installCode = npmCli ? await run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund']) : await run('npm', ['ci', '--no-audit', '--no-fund']);
  if (installCode !== 0) {
    await log('E111', `Local component setup failed / コンポーネントの準備に失敗 / 本地组件准备失败（exit ${installCode}）。Please check the network and retry.`);
    process.exit(1);
  }
}

// `npm run start` serves the `dist` production bundle. A clean archive has
// dependencies after npm ci but no bundle yet, so build it automatically
// instead of waiting for port 3000 until the startup timeout expires.
try {
  await stat(path.join(root, 'dist', 'server'));
} catch {
  await log('E112', 'Building local interface / ローカル画面を構築中 / 正在生成本机界面。完成后将自动打开中文、日本語、English 语言选择。');
  const buildCode = npmCli ? await run(process.execPath, [npmCli, 'run', 'build']) : await run('npm', ['run', 'build']);
  if (buildCode !== 0) {
    await log('E113', `Local interface build failed / 画面構築に失敗 / 本机界面构建失败（exit ${buildCode}）。See enkei-panel-runtime.log.`);
    process.exit(1);
  }
}

await log('E010', `本地启动器已运行，Node ${process.version}。`);
if (!(await startupSelfCheck())) process.exit(1);
await stopPreviousEnkeiRuntime();
await clearStoppedPanelLock();
await log('E000', '旧版圆衡面板已清理，正在启动当前版本。');
const controller = spawn(process.execPath, [runtimePath], { cwd: root, detached: true, windowsHide: true, stdio: 'ignore' });
controller.unref();
const panelReady = await waitForPanel();
if (!panelReady) {
  await log('E140', 'Local panel did not become ready within 120 seconds / 120 秒以内に画面が起動しませんでした / 等待本地面板超过 120 秒。See enkei-panel-runtime.log and enkei-startup-diagnostic.log.');
  process.exit(1);
}
await log('E000', '本地面板已就绪，正在打开浏览器。');
openBrowser();
