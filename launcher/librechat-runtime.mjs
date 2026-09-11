import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function libreChatHomeCandidates(root, environment = process.env) {
  const configured = String(environment.ENKEI_LIBRECHAT_HOME ?? '').trim();
  return [...new Set([
    configured || null,
    path.join(root, 'librechat'),
    path.join(root, '..', 'LibreChat'),
    path.join(root, '..', '部署', 'LibreChat'),
    path.join(root, '..', '..', '部署', 'LibreChat'),
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

export async function resolveLibreChatDeployment(root, environment = process.env) {
  for (const home of libreChatHomeCandidates(root, environment)) {
    for (const composeName of ['deploy-compose.yml', 'docker-compose.yml', 'compose.yml']) {
      const composeFile = path.join(home, composeName);
      if (await exists(composeFile)) return { home, composeFile };
    }
  }
  return null;
}

export function dockerCliCandidates(environment = process.env) {
  return [...new Set([
    environment.ProgramFiles ? path.join(environment.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe') : null,
    environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Docker', 'resources', 'bin', 'docker.exe') : null,
    'docker.exe',
  ].filter(Boolean))];
}

export function dockerDesktopCandidates(environment = process.env) {
  return [...new Set([
    environment.ProgramFiles ? path.join(environment.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') : null,
    environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Docker', 'Docker Desktop.exe') : null,
  ].filter(Boolean))];
}

async function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve({ ok: false, code: 127, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    const collect = (chunk) => { output = `${output}${chunk}`.slice(-8_000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => finish({ ok: false, code: 127, output: error.message }));
    child.once('exit', (code) => finish({ ok: code === 0, code: code ?? 1, output: output.trim() }));
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, code: 124, output: `${output}\ncommand timed out`.trim() });
    }, options.timeoutMs ?? 10_000);
  });
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate === 'docker.exe' || await exists(candidate)) return candidate;
  }
  return null;
}

async function findDockerCli(environment) {
  for (const candidate of dockerCliCandidates(environment)) {
    if (candidate !== 'docker.exe' && !(await exists(candidate))) continue;
    const probe = await run(candidate, ['--version'], { timeoutMs: 5_000 });
    if (probe.ok) return candidate;
  }
  return null;
}

async function httpReady(url, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode < 500));
    });
    request.setTimeout(timeoutMs, () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

async function dockerDesktopIsRunning() {
  if (process.platform !== 'win32') return false;
  const result = await run('tasklist.exe', ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/FO', 'CSV', '/NH'], { timeoutMs: 5_000 });
  return result.ok && /Docker Desktop\.exe/i.test(result.output);
}

export function createLibreChatRuntime({ root, log, environment = process.env }) {
  let current = {
    managed: false,
    status: 'checking',
    ready: false,
    endpoint: 'http://127.0.0.1:3080',
    detail: '正在检查统一分析体。',
    checked_at: null,
  };
  let running = null;
  let lastAttemptAt = 0;

  const update = (next) => {
    current = { ...current, ...next, checked_at: new Date().toISOString() };
    return current;
  };

  async function maintain({ force = false } = {}) {
    if (running) return running;
    const now = Date.now();
    if (!force && now - lastAttemptAt < 60_000) return current;
    lastAttemptAt = now;
    running = (async () => {
      const deployment = await resolveLibreChatDeployment(root, environment);
      if (await httpReady(current.endpoint)) {
        return update({ managed: Boolean(deployment), ready: true, status: 'ready', home: deployment?.home, compose_file: deployment?.composeFile, detail: 'LibreChat 统一分析体已就绪。' });
      }
      if (!deployment) {
        return update({ managed: false, ready: false, status: 'not-installed', detail: '未发现本机 LibreChat 部署；可继续使用已配置的远程网关或本地备用模型。' });
      }
      update({ managed: true, ready: false, status: 'docker-check', home: deployment.home, compose_file: deployment.composeFile, detail: '已发现 LibreChat，正在检查 Docker。' });

      const docker = await findDockerCli(environment);
      if (!docker) {
        await log('E150', '已发现 LibreChat，但未安装 Docker Desktop。请重新运行“一键配装”。');
        return update({ status: 'docker-missing', detail: '需要安装 Docker Desktop 后才能启动 LibreChat。' });
      }

      let engine = await run(docker, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000 });
      if (!engine.ok) {
        const alreadyStarting = await dockerDesktopIsRunning();
        if (!alreadyStarting) {
          const desktop = await firstExisting(dockerDesktopCandidates(environment));
          if (!desktop) {
            await log('E151', 'Docker CLI 已存在，但未找到 Docker Desktop 启动程序。');
            return update({ status: 'docker-unavailable', detail: 'Docker Desktop 不完整或无法启动，请运行安装修复。' });
          }
          spawn(desktop, [], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
          await log('E000', 'Docker Desktop 尚未运行，已启动一个实例并等待引擎。');
        } else {
          await log('E000', 'Docker Desktop 已在启动中；不会重复启动，正在等待引擎。');
        }
        update({ status: 'docker-starting', detail: 'Docker Desktop 正在启动。' });
        for (let attempt = 0; attempt < 45; attempt += 1) {
          await wait(2_000);
          engine = await run(docker, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000 });
          if (engine.ok) break;
        }
      }
      if (!engine.ok) {
        const socketHint = /sock|pipe|cannot be accessed|permission denied/i.test(engine.output);
        const detail = socketHint
          ? 'Docker 引擎未就绪，且检测到套接字或权限异常。请退出 Docker Desktop 后重新启动；圆衡不会删除 Docker 数据或恢复出厂。'
          : 'Docker 引擎在 90 秒内未就绪，请检查 WSL2、虚拟化或 Docker Desktop 提示。';
        await log('E152', `${detail} ${engine.output.slice(-500)}`);
        return update({ status: 'docker-error', detail });
      }

      update({ status: 'compose-starting', docker_version: engine.output, detail: 'Docker 已就绪，正在恢复 LibreChat 服务。' });
      const compose = await run(docker, ['compose', '-f', deployment.composeFile, 'up', '-d'], { cwd: deployment.home, timeoutMs: 120_000 });
      if (!compose.ok) {
        await log('E153', `LibreChat compose 启动失败（退出码 ${compose.code}）：${compose.output.slice(-700)}`);
        return update({ status: 'compose-error', detail: 'LibreChat 容器启动失败，请查看圆衡启动诊断日志。' });
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await httpReady(current.endpoint, 2_000)) {
          await log('E000', `LibreChat 统一分析体已恢复：${current.endpoint}`);
          return update({ status: 'ready', ready: true, detail: 'LibreChat 统一分析体已就绪。' });
        }
        await wait(2_000);
      }
      await log('E154', 'LibreChat 容器已启动，但 3080 在 120 秒内没有响应。');
      return update({ status: 'starting-timeout', ready: false, detail: 'LibreChat 容器已启动，但网页服务尚未就绪。' });
    })().finally(() => { running = null; });
    return running;
  }

  async function stop() {
    const deployment = await resolveLibreChatDeployment(root, environment);
    if (!deployment) return update({ managed: false, ready: false, status: 'stopped', detail: '未发现由圆衡管理的 LibreChat 部署。' });
    const docker = await findDockerCli(environment);
    if (!docker) return update({ managed: true, ready: false, status: 'stop-unavailable', detail: '未找到 Docker CLI，无法自动停止 LibreChat。' });
    const result = await run(docker, ['compose', '-f', deployment.composeFile, 'stop'], { cwd: deployment.home, timeoutMs: 60_000 });
    if (!result.ok) {
      await log('E156', `LibreChat 停止失败（退出码 ${result.code}）：${result.output.slice(-500)}`);
      return update({ managed: true, ready: false, status: 'stop-error', detail: 'LibreChat 自动停止失败，请检查 Docker Desktop。' });
    }
    await log('E000', 'LibreChat 统一分析体已随圆衡关闭。');
    return update({ managed: true, ready: false, status: 'stopped', detail: 'LibreChat 已停止，数据卷保持不变。' });
  }

  return { maintain, stop, status: () => ({ ...current }) };
}
