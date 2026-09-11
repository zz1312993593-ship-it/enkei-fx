#!/usr/bin/env node
// 本地 CI（清单 4.5）：lint、TypeScript、前端构建、Python 单测、数据对抗测试、
// 依赖漏洞扫描、许可证清单生成。无外部 CI 依赖，可被任何计划任务定期执行。
// 用法：npm run ci
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';
const npx = windows ? 'npx.cmd' : 'npx';
const py = windows
  ? path.join(root, 'ai-terminal', '.venv', 'Scripts', 'python.exe')
  : path.join(root, 'ai-terminal', '.venv', 'bin', 'python');
const results = [];
let failed = false;
const pythonTestRoot = mkdtempSync(path.join(tmpdir(), 'enkei-ci-'));
const pythonTestEnv = {
  ...process.env,
  ENKEI_DATA_DIR: path.join(pythonTestRoot, 'data'),
  ENKEI_PRIVATE_CONFIG_DIR: path.join(pythonTestRoot, 'private-config'),
};

function step(name, command, args, opts = {}) {
  process.stdout.write(`▶ ${name}\n`);
  const started = Date.now();
  // Windows 上 npm/npx 是 .cmd，必须经 shell 调起；输出统一 String 化避免 Buffer/null。
  const proc = spawnSync(command, args, { encoding: 'utf8', shell: windows, ...opts });
  const duration = ((Date.now() - started) / 1000).toFixed(1);
  const ok = proc.status === 0;
  if (!ok) failed = true;
  const output = String(proc.stdout ?? '') + String(proc.stderr ?? '');
  results.push({ name, ok, duration_s: Number(duration), output: output.slice(-4000) });
  console.log(`  ${ok ? '✓' : '✗'} ${duration}s`);
  return ok;
}

step('eslint', npm, ['run', 'lint'], { cwd: root });
step('tsc --noEmit', npx, ['tsc', '--noEmit', '--incremental', 'false'], { cwd: root });
step('build', npm, ['run', 'build'], { cwd: root });

// 前端 CSV 解析单测：先单文件编译 csv-history.ts 再 node --test
step('compile csv-history for tests', npx,
  ['tsc', 'lib/csv-history.ts', '--outDir', 'tests/.build', '--target', 'es2020', '--module', 'esnext', '--skipLibCheck'],
  { cwd: root });
step('full JavaScript test suite', npm, ['test'], { cwd: root });

if (existsSync(py)) {
  step('ai-terminal unittest', py, ['-B', '-m', 'unittest', 'discover', '-p', 'test_*.py'],
    { cwd: path.join(root, 'ai-terminal'), env: pythonTestEnv });
  step('decision-service contract tests', py, ['-B', '-m', 'unittest', 'test_delivery_review', '-v'],
    { cwd: path.join(root, 'decision-service'), env: pythonTestEnv });
} else {
  results.push({ name: 'ai-terminal unittest', ok: false, duration_s: 0, output: 'venv python not found; run Start-Enkei.cmd first' });
  failed = true;
}

step('npm audit (omit=dev)', npm, ['audit', '--omit=dev', '--json'], { cwd: root });

// —— 许可证清单 ——
try {
  const ls = spawnSync(npm, ['ls', '--omit=dev', '--json', '--long'], { cwd: root, encoding: 'utf8', shell: windows });
  const prod = JSON.parse(String(ls.stdout || '{}'));
  const rows = [];
  const walk = (deps, depth) => {
    if (!deps || depth > 4) return;
    for (const [name, info] of Object.entries(deps)) {
      rows.push({ name, version: info.version, license: info.license ?? 'unknown', homepage: info.homepage ?? '' });
      walk(info.dependencies, depth + 1);
    }
  };
  walk(prod.dependencies, 0);
  const vendors = [];
  const vendorDir = path.join(root, 'decision-service', 'vendor', 'tradingagents');
  if (existsSync(path.join(vendorDir, 'LICENSE'))) {
    const pkg = existsSync(path.join(vendorDir, 'pyproject.toml')) ? readFileSync(path.join(vendorDir, 'pyproject.toml'), 'utf8') : '';
    const nameMatch = pkg.match(/name\s*=\s*"([^"]+)"/);
    vendors.push({ name: nameMatch?.[1] ?? 'tradingagents', path: 'decision-service/vendor/tradingagents', license: 'Apache-2.0 (LICENSE included)' });
  }
  const docDir = path.join(root, 'docs');
  mkdirSync(docDir, { recursive: true });
  writeFileSync(path.join(docDir, '依赖与许可证清单.json'), JSON.stringify({ generatedAt: new Date().toISOString(), npm_prod_packages: rows, vendored: vendors }, null, 2));
  console.log(`  ✓ license inventory: ${rows.length} npm packages, ${vendors.length} vendored`);
  results.push({ name: 'license inventory', ok: true, duration_s: 0, output: `${rows.length} packages` });
} catch (error) {
  results.push({ name: 'license inventory', ok: false, duration_s: 0, output: String(error) });
  failed = true;
}

mkdirSync(path.join(root, 'docs'), { recursive: true });
writeFileSync(path.join(root, 'docs', 'CI_最近运行结果.json'), JSON.stringify({
  ranAt: new Date().toISOString(), failed,
  steps: results,
}, null, 2));

console.log(failed ? '\nCI FAILED — details in results above.' : '\nCI PASSED.');
process.exit(failed ? 1 : 0);
