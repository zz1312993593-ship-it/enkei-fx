#!/usr/bin/env node
// 稳健性复核：对扫描闸门通过的组合，做 多OOS切分点 × 点差敏感性 矩阵测试。
// 目的：剔除"单次切分运气"，找出在多数条件下仍存活的真稳健组合。
// 产出：docs/稳健性复核_YYYYMMDD.md + JSON。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const outDir = path.join(root, 'docs');
const NOW = new Date();
const stamp = `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, '0')}${String(NOW.getDate()).padStart(2, '0')}`;

// 复用扫描数据里的通过组合与其数据集参数
const sweep = JSON.parse(readFileSync(path.join(outDir, `策略扫描数据_${stamp}.json`), 'utf8'));
const gatePass = sweep.results.filter((r) => r.gate === 'pass');

const { runBacktest, DEFAULT_BACKTEST_CONFIG } = await import('../tests/.build/backtest.js');
const commonDir = process.env.ENKEI_MT4_COMMON_DIR
  ?? path.join(process.env.APPDATA ?? '', 'MetaQuotes', 'Terminal', 'Common', 'Files');
const historyDir = path.join(commonDir, 'enkei', 'history');

// 与首轮扫描一致的点差基准（按周期）
const BASE_SPREAD = { M15: 1.2, H1: 1.0, H4: 1.5, D1: 2.0, W1: 3.0 };
const SPLITS = [0.5, 0.6, 0.7, 0.8];
const SPREAD_MULTS = [1, 1.5, 2];

function loadBars(symbol, tf) {
  const file = path.join(historyDir, `${symbol}-${tf}.csv`);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter((line) => line.trim());
  const bars = lines.map((line) => {
    const [t, o, h, l, c] = line.split(',').map((v) => Number(v.trim()));
    return { time: t, open: o, high: h, low: l, close: c };
  }).filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.time > 0 && Math.min(bar.open, bar.high, bar.low, bar.close) > 0);
  return Array.from(new Map(bars.map((bar) => [bar.time, bar])).values()).sort((a, b) => a.time - b.time);
}

const rows = [];
let cacheKey = '';
let cachedBars = null;
for (const r of gatePass) {
  const key = `${r.symbol}|${r.tf}`;
  if (cacheKey !== key) { cachedBars = loadBars(r.symbol, r.tf); cacheKey = key; }
  const bars = cachedBars;
  if (!bars || bars.length < 200) { rows.push({ ...r, robustness: 0, survived: 0, total: SPLITS.length * SPREAD_MULTS.length, note: 'data unavailable' }); continue; }
  const baseSpread = BASE_SPREAD[r.tf] ?? 1.0;
  let survived = 0;
  let total = 0;
  const detail = [];
  for (const split of SPLITS) {
    for (const mult of SPREAD_MULTS) {
      const startIndex = Math.floor(bars.length * split);
      if (bars.length - startIndex < 60) continue; // 切分后样本太薄不计
      const result = runBacktest(bars, {
        ...DEFAULT_BACKTEST_CONFIG, entryModel: r.model, symbol: r.symbol, timeframe: r.tf,
        riskPerTradePct: 0.25, spreadPips: baseSpread * mult, startIndex,
      });
      const ok = result.trades.length >= 8 && result.netReturnPct > 0 && result.profitFactor > 1;
      detail.push({ split, spreadMult: mult, trades: result.trades.length, net: Number(result.netReturnPct.toFixed(2)), ok });
      if (ok) survived += 1;
      total += 1;
    }
  }
  const robustness = total ? Math.round((survived / total) * 100) : 0;
  rows.push({ ...r, robustness, survived, total, detail });
}

rows.sort((a, b) => b.robustness - a.robustness || b.oos.net - a.oos.net);
const band = (pct) => pct >= 75 ? '稳健' : pct >= 50 ? '中等' : '切分运气';

writeFileSync(path.join(outDir, `稳健性复核数据_${stamp}.json`), JSON.stringify({ generatedAt: NOW.toISOString(), method: '4 OOS splits × 3 spread levels; gate = trades>=8 & net>0 & PF>1', rows }, null, 2));

let md = `# 稳健性复核报告（${stamp}）\n\n`;
md += `> 对首轮扫描闸门通过的 ${gatePass.length} 个组合做 **4 个 OOS 切分点（50/60/70/80%）× 3 档点差（×1/×1.5/×2）** 矩阵复核。\n`;
md += `> 复核通过标准与首轮相同（交易≥8 且 净收益>0 且 PF>1）。**稳健 = ≥75% 条件下存活**。\n`;
md += `> 这是为了剔除"单次切分运气"——MQL5 上大量声称高胜率的策略就死在这一关。\n\n`;

const robust = rows.filter((r) => r.robustness >= 75);
const mid = rows.filter((r) => r.robustness >= 50 && r.robustness < 75);
const luck = rows.filter((r) => r.robustness < 50);
md += `## 结论\n\n- **稳健存活：${robust.length} / ${rows.length}**（首轮"通过"里只有这些扛住了全矩阵）\n- 中等（50–74%）：${mid.length}；切分运气（<50%）：${luck.length}\n\n`;

md += `## 稳健存活组合（按存活率、OOS 净收益排序）\n\n| 货币对 | 周期 | 策略 | 存活率 | 存活/总数 | 首轮 OOS 净收益 | 首轮 OOS PF |\n|---|---|---|---|---|---|---|\n`;
for (const r of robust) {
  md += `| ${r.symbol} | ${r.tf} | ${r.model} | ${band(r.robustness)} ${r.robustness}% | ${r.survived}/${r.total} | +${r.oos.net}% | ${r.oos.pf ?? '—'} |\n`;
}

if (mid.length) {
  md += `\n## 中等（继续观察，不淘汰）\n\n| 货币对 | 周期 | 策略 | 存活率 |\n|---|---|---|---|\n`;
  for (const r of mid) md += `| ${r.symbol} | ${r.tf} | ${r.model} | ${r.robustness}% |\n`;
}

md += `\n## 周一开市后的动作\n\n1. 把"稳健存活"组合按顺序登记进 研究 → 前向验证 的候选队列（每市场/策略组合一条）。\n2. 前向验证只记录已收盘K线与人工复核结论；观察期、复核数、不一致率达标前不谈实盘。\n3. 若某组合第一周逻辑不一致率明显劣于回测，优先怀疑过拟合，而不是调参数救它。\n`;

writeFileSync(path.join(outDir, `稳健性复核报告_${stamp}.md`), md);
console.log(`robustness: ${robust.length} robust / ${mid.length} mid / ${luck.length} luck of ${rows.length}`);
console.log(`report: docs/稳健性复核报告_${stamp}.md`);
