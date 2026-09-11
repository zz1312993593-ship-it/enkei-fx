#!/usr/bin/env node
// 批O：用本机 MT4 真实历史（只读 CSV）对全部策略做回测扫描。
// 输出：docs/策略扫描报告_YYYYMMDD.md + docs/策略扫描数据_YYYYMMDD.json
// 性质：研究快照。参数未优化、单一 OOS 切分有运气成分；不构成收益承诺。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { asBar, supportedSymbols } from '../bridge/history-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commonDir = process.env.ENKEI_MT4_COMMON_DIR
  ?? path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const historyDir = path.join(commonDir, 'enkei', 'history');
const outDir = path.join(root, 'docs');
const NOW = new Date();
const stamp = `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}${String(NOW.getDate()).padStart(2, '0')}`;

const { runBacktest, DEFAULT_BACKTEST_CONFIG } = await import('../tests/.build/backtest.js');
const { RESEARCH_MODELS } = await import('../tests/.build/model-catalog.js');
const MODELS = RESEARCH_MODELS.map((m) => m.id);
const TIMEFRAMES = [
  { tf: 'M15', spread: 1.2, minBars: 400 },
  { tf: 'H1', spread: 1.0, minBars: 400 },
  { tf: 'H4', spread: 1.5, minBars: 300 },
  { tf: 'D1', spread: 2.0, minBars: 250 },
  { tf: 'W1', spread: 3.0, minBars: 200 },
];

function loadCsv(symbol, tf) {
  const file = path.join(historyDir, `${symbol}-${tf}.csv`);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/).slice(1).filter((line) => line.trim());
  const bars = lines.map(asBar).filter(Boolean);
  const unique = Array.from(new Map(bars.map((bar) => [bar.time, bar])).values()).sort((a, b) => a.time - b.time);
  return { bars: unique, mtime: existsSync(file) ? 'see-bridge' : '' };
}

const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const results = [];
const coverage = [];

for (const symbol of [...supportedSymbols]) {
  for (const { tf, spread, minBars } of TIMEFRAMES) {
    const loaded = loadCsv(symbol, tf);
    if (!loaded || loaded.bars.length < minBars) {
      coverage.push({ symbol, tf, bars: loaded?.bars.length ?? 0, scanned: false, reason: loaded ? `bars < ${minBars}` : 'file missing' });
      continue;
    }
    const bars = loaded.bars;
    const first = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
    const last = new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 16).replace('T', ' ');
    coverage.push({ symbol, tf, bars: bars.length, first, last, scanned: true });
    const oosStart = Math.floor(bars.length * 0.7);
    for (const model of MODELS) {
      const base = { ...DEFAULT_BACKTEST_CONFIG, entryModel: model, symbol, timeframe: tf, riskPerTradePct: 0.25, spreadPips: spread };
      const full = runBacktest(bars, base);
      const oos = runBacktest(bars, { ...base, startIndex: oosStart });
      const passed = oos.trades.length >= 8 && oos.netReturnPct > 0 && oos.profitFactor > 1;
      results.push({
        symbol, tf, model, bars: bars.length,
        full: { trades: full.trades.length, net: Number(full.netReturnPct.toFixed(2)), dd: Number(full.maxDrawdownPct.toFixed(2)), pf: Number.isFinite(full.profitFactor) ? Number(full.profitFactor.toFixed(2)) : null },
        oos: { trades: oos.trades.length, net: Number(oos.netReturnPct.toFixed(2)), dd: Number(oos.maxDrawdownPct.toFixed(2)), pf: Number.isFinite(oos.profitFactor) ? Number(oos.profitFactor.toFixed(2)) : null },
        gate: passed ? 'pass' : oos.trades.length < 8 ? 'few-trades' : 'fail',
      });
    }
  }
}

// ---- 汇总 ----
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `策略扫描数据_${stamp}.json`), JSON.stringify({ generatedAt: NOW.toISOString(), dataThrough: 'Friday close (local MT4, read-only)', coverage, results }, null, 2));

const scanCount = coverage.filter((c) => c.scanned).length;
const passRows = results.filter((r) => r.gate === 'pass');
let md = `# 策略扫描报告（${stamp}）\n\n`;
md += `> 研究快照：本机 MT4 只读历史（数据截至周五收盘）。参数未做任何优化；70/30 单次样本外切分存在运气成分。\n`;
md += `> **不构成收益承诺**；通过闸门 ≠ 可以交易，仅代表进入下一阶段研究（前向验证候选）。\n\n`;
md += `## 数据覆盖\n\n| 货币对 | 周期 | K线数 | 起点 | 最新K线 |\n|---|---|---|---|---|\n`;
for (const c of coverage.filter((x) => x.scanned)) md += `| ${c.symbol} | ${c.tf} | ${c.bars.toLocaleString()} | ${c.first} | ${c.last} |\n`;
for (const c of coverage.filter((x) => !x.scanned)) md += `| ${c.symbol} | ${c.tf} | ${c.bars} | — | 未扫描：${c.reason} |\n`;

md += `\n## 闸门通过（样本外：交易≥8 且 净收益>0 且 PF>1）\n\n`;
if (passRows.length === 0) {
  md += `本轮扫描**没有**组合通过闸门。这是正常的研究结论——不应该为此放宽标准或强行挑选赢家。\n`;
} else {
  md += `| 货币对 | 周期 | 策略 | OOS交易 | OOS净收益 | OOS PF | OOS回撤 |\n|---|---|---|---|---|---|---|\n`;
  for (const r of [...passRows].sort((a, b) => b.oos.net - a.oos.net)) {
    md += `| ${r.symbol} | ${r.tf} | ${r.model} | ${r.oos.trades} | ${fmtPct(r.oos.net)} | ${r.oos.pf ?? '—'} | ${r.oos.dd.toFixed(2)}% |\n`;
  }
}

for (const { tf } of TIMEFRAMES) {
  const rows = results.filter((r) => r.tf === tf);
  if (!rows.length) continue;
  md += `\n## ${tf}｜样本外明细（按 OOS 净收益排序，仅展示 OOS 交易 ≥ 8 的组合）\n\n`;
  md += `| 货币对 | 策略 | OOS交易 | OOS净收益 | OOS PF | OOS回撤 | 全样本净收益 | 闸门 |\n|---|---|---|---|---|---|---|---|\n`;
  const visible = rows.filter((r) => r.oos.trades >= 8).sort((a, b) => b.oos.net - a.oos.net);
  if (!visible.length) { md += `*（本周期无 OOS 交易 ≥ 8 的组合）*\n`; continue; }
  for (const r of visible) {
    md += `| ${r.symbol} | ${r.model} | ${r.oos.trades} | ${fmtPct(r.oos.net)} | ${r.oos.pf ?? '—'} | ${r.oos.dd.toFixed(2)}% | ${fmtPct(r.full.net)} | ${r.gate} |\n`;
  }
}

md += `\n## 统计\n\n- 扫描组合：${results.length}（${scanCount} 个数据集 × ${MODELS.length} 策略）\n- 闸门通过：${passRows.length}；样本不足：${results.filter((r) => r.gate === 'few-trades').length}；未通过：${results.filter((r) => r.gate === 'fail').length}\n- 下一步：通过组合进入前向验证观察（研究 → 前向验证）；未通过组合不做参数粉饰，留待数据更新后复查。\n`;

writeFileSync(path.join(outDir, `策略扫描报告_${stamp}.md`), md);
console.log(`scanned ${results.length} combos across ${scanCount} datasets; gate pass: ${passRows.length}`);
console.log(`report: docs/策略扫描报告_${stamp}.md`);
