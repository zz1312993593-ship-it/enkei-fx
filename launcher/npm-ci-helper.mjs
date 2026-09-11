#!/usr/bin/env node
/**
 * 圆衡 Enkei 1.6.0 · npm 依赖安装助手
 * 由统一启动器的首次安装流程调用：定位 npm CLI 并执行 npm ci（与 local-launcher 相同的定位逻辑）。
 * 用法：node launcher\npm-ci-helper.mjs
 * 退出码：0 成功 / 非 0 失败
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;

function run(command, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
      child.once('error', () => resolve(127));
      child.once('exit', (code) => resolve(code ?? 1));
    } catch { resolve(127); }
  });
}

const code = npmCli ? await run(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund']) : await run('npm', ['ci', '--no-audit', '--no-fund']);
process.exit(code);
