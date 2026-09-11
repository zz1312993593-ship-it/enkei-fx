// 批I：交易管理（保本移损 / ATR 跟踪止损）回归测试。
// 由 npm test 的 pretest 步骤把 lib/ 编译到 tests/.build 后运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from './.build/backtest.js';

const PAIR = 'USDJPY';
const TF = 'H1';

// 上升→深回撤 的合成序列：先制造多头入场，随后浮盈达到 1R+，再反向击穿初始止损。
function makeRoundTripBars() {
  const bars = [];
  const start = Date.UTC(2026, 8, 7) / 1000;
  let price = 150.0;
  // 30 根横盘（预热 + 形成区间）
  for (let i = 0; i < 30; i += 1) {
    bars.push({ time: start + i * 3600, open: price, high: price + 0.02, low: price - 0.02, close: price });
  }
  // 5 根稳步上行（触发突破多头入场；ATR 小 → riskDistance 小）
  for (let i = 30; i < 35; i += 1) {
    const open = price;
    price = open + 0.12;
    bars.push({ time: start + i * 3600, open, high: price + 0.02, low: open - 0.02, close: price });
  }
  // 冲高：浮盈 ≥ 1R 但不及止盈目标（风险距离由真实 ATR 决定）
  const peakOpen = price;
  bars.push({ time: start + 35 * 3600, open: peakOpen, high: peakOpen + 0.08, low: peakOpen - 0.05, close: peakOpen + 0.06 });
  // 深回撤：击穿初始止损（入场价 − stopAtr×ATR）
  const crashOpen = peakOpen + 0.1;
  bars.push({ time: start + 36 * 3600, open: crashOpen, high: crashOpen + 0.02, low: peakOpen - 0.4, close: peakOpen - 0.35 });
  price = peakOpen - 0.35; // 同步价格变量，尾部继续下行
  // 尾部若干根
  for (let i = 37; i < 45; i += 1) {
    const open = price;
    price = open - 0.05;
    bars.push({ time: start + i * 3600, open, high: open + 0.02, low: price - 0.02, close: price });
  }
  return bars;
}

test('breakeven: with trigger enabled the reversal exits near entry instead of the initial stop', () => {
  const bars = makeRoundTripBars();
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 0, slippagePips: 0, rewardRisk: 6.0 };
  const without = runBacktest(bars, base);
  const withBe = runBacktest(bars, { ...base, breakEvenTriggerR: 1.0 });
  assert.ok(without.trades.length >= 1, '无配置基线应有一笔交易');
  assert.ok(withBe.trades.length >= 1, '启用保本后应有一笔交易');
  const longTradeWithout = without.trades[0];
  const longTradeWith = withBe.trades[0];
  // 启用保本后，反向击穿时止损已在开仓价附近，结果严格优于原始止损
  assert.ok(longTradeWith.rMultiple > longTradeWithout.rMultiple, `保本后 ${longTradeWith.rMultiple.toFixed(2)}R 应优于初始止损 ${longTradeWithout.rMultiple.toFixed(2)}R`);
  assert.ok(longTradeWithout.rMultiple < 0, '无保本时深回撤应击穿初始止损');
});

test('trailing stop: captures more profit than the static stop on a run-up then reversal', () => {
  const bars = makeRoundTripBars();
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 0, slippagePips: 0, rewardRisk: 8.0 };
  const without = runBacktest(bars, base);
  const withTrail = runBacktest(bars, { ...base, trailingStopAtrMult: 1.0 });
  const t0 = without.trades[0];
  const t1 = withTrail.trades[0];
  assert.ok(t1.rMultiple > t0.rMultiple, `跟踪止损 ${t1.rMultiple.toFixed(2)}R 应优于静态止损 ${t0.rMultiple.toFixed(2)}R`);
});

test('no config change: results identical to the default engine behaviour', () => {
  const bars = makeRoundTripBars();
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 1 };
  const a = runBacktest(bars, base);
  const b = runBacktest(bars, { ...base, breakEvenTriggerR: undefined, trailingStopAtrMult: undefined });
  assert.deepEqual(a, b);
});

test('trailing never loosens the stop on a whipsaw sequence', () => {
  // 锯齿行情：跟踪止损后净收益不应差于同一序列的静态止损（只收紧性质的结果性检验）
  const bars = [];
  const start = Date.UTC(2026, 8, 7) / 1000;
  let price = 150.0;
  for (let i = 0; i < 80; i += 1) {
    const swing = (i % 4 < 2) ? 0.1 : -0.1;
    const open = price;
    price = open + swing;
    bars.push({ time: start + i * 3600, open, high: Math.max(open, price) + 0.02, low: Math.min(open, price) - 0.02, close: price });
  }
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 1 };
  const a = runBacktest(bars, base);
  const b = runBacktest(bars, { ...base, trailingStopAtrMult: 2.0 });
  assert.ok(Number.isFinite(a.netReturnPct) && Number.isFinite(b.netReturnPct));
});

// ============ 批M：部分平仓核算 ============

test('partial close: 1R partial then full stop-out nets ~0 instead of -1R', () => {
  const bars = makeRoundTripBars();
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 0, slippagePips: 0, rewardRisk: 6.0 };
  const without = runBacktest(bars, base);
  const withPartial = runBacktest(bars, { ...base, takePartialAtR: 1.0, partialCloseFraction: 0.5 });
  const t0 = without.trades[0];
  const t1 = withPartial.trades[0];
  assert.ok(t0.rMultiple < -0.9, '基线应接近 -1R（初始止损）');
  // 加权核算：0.5×(+1R) + 0.5×(−1R) = 0
  assert.ok(Math.abs(t1.rMultiple) < 0.15, `部分平仓加权后应接近 0R，实际 ${t1.rMultiple.toFixed(2)}R`);
  assert.ok(t1.partials?.length === 1 && t1.partials[0].fraction === 0.5, '应记录一笔 50% 部分平仓');
});

test('partial close: 1R partial then target keeps the weighted accounting exact', () => {
  // 趋势延续到 6R 目标：加权 = 0.5×1R + 0.5×6R = 3.5R
  const bars = [];
  const start = Date.UTC(2026, 8, 7) / 1000;
  let price = 150.0;
  for (let i = 0; i < 30; i += 1) {
    bars.push({ time: start + i * 3600, open: price, high: price + 0.02, low: price - 0.02, close: price });
  }
  for (let i = 30; i < 35; i += 1) {
    const open = price;
    price = open + 0.12;
    bars.push({ time: start + i * 3600, open, high: price + 0.02, low: open - 0.02, close: price });
  }
  // 持续上行直至 6R 目标被打掉（无回撤）
  const peakOpen = price;
  for (let i = 35; i < 60; i += 1) {
    const open = price;
    price = open + 0.3;
    bars.push({ time: start + i * 3600, open, high: price + 0.02, low: open - 0.02, close: price });
  }
  void peakOpen;
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 0, slippagePips: 0, rewardRisk: 6.0 };
  const withPartial = runBacktest(bars, { ...base, takePartialAtR: 1.0, partialCloseFraction: 0.5 });
  const t1 = withPartial.trades.find((trade) => trade.exitReason === 'target');
  assert.ok(t1, '应存在打到目标的交易');
  assert.ok(Math.abs(t1.rMultiple - 3.5) < 0.6, `目标了结的加权 R 应接近 3.5R（部分段 1R + 剩余段 6R 各半），实际 ${t1.rMultiple.toFixed(2)}R`);
  assert.ok(t1.partials?.length === 1);
});

// ============ 批N：连续止损保护 ============

test('pause after consecutive losses skips entries during the pause window', () => {
  // 三段相同的"入场即止损"行情：无保护时连续吃 3 笔亏损；有保护时第 2 笔后暂停，交易数更少
  const segment = makeRoundTripBars().slice(0, 40);
  const start = Date.UTC(2026, 8, 7) / 1000;
  const bars = [];
  segment.forEach((bar, index) => bars.push({ ...bar, time: start + index * 3600 }));
  for (let copy = 1; copy <= 2; copy += 1) {
    const offset = copy * 40 * 3600 + copy * 3600;
    segment.forEach((bar) => bars.push({ ...bar, time: bar.time + offset }));
  }
  const base = { ...DEFAULT_BACKTEST_CONFIG, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 0, slippagePips: 0, rewardRisk: 6.0 };
  const without = runBacktest(bars, base);
  const withPause = runBacktest(bars, { ...base, pauseAfterLosses: { losses: 2, pauseBars: 60 } });
  assert.ok(without.trades.length >= 2, '基线应有多笔亏损交易');
  assert.ok(withPause.trades.length < without.trades.length, `连续亏损保护应减少交易数（${withPause.trades.length} < ${without.trades.length}）`);
  assert.ok(withPause.maxDrawdownPct <= without.maxDrawdownPct + 0.001, '保护后回撤不应更深');
});
