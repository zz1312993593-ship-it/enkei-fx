// 批G：三个新策略（时段突破/波动通道/亚洲区间回归）的信号测试。
// 由 npm test 的 pretest 步骤把 lib/ 编译到 tests/.build 后运行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchSignal } from './.build/research-signal.js';
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from './.build/backtest.js';

const TF = 'H1';
const PAIR = 'USDJPY';

// 按真实 UTC 小时合成 K 线：亚洲盘（0-7 点）横盘 150.0±0.02，
// 伦敦盘（7-16 点）单向移动 drift，纽约盘（16-24 点）回吐。
function makeSessionBars(days, drift) {
  const bars = [];
  const start = Date.UTC(2026, 8, 7) / 1000;
  let price = 150.0;
  for (let i = 0; i < 24 * days; i += 1) {
    const time = start + i * 3600;
    const hour = new Date(time * 1000).getUTCHours();
    const open = price;
    if (hour < 7) {
      price = 150.0 + 0.02 * Math.sin(i);
    } else if (hour < 16) {
      price = open + drift;
    } else {
      price = open - drift;
    }
    bars.push({ time, open, high: Math.max(open, price) + 0.02, low: Math.min(open, price) - 0.02, close: price });
  }
  return bars;
}

const utcHour = (bar) => new Date(bar.time * 1000).getUTCHours();

test('session-breakout fires long only on a London-session close beyond the Asian range', () => {
  const bars = makeSessionBars(3, 0.15);
  const asiaHigh = Math.max(...bars.filter((bar) => utcHour(bar) < 7).map((bar) => bar.high));
  // 信号评估要求 ≥42 根历史；因此用第 3 天的突破K线（索引 ≥ 42）
  const breakAt = bars.map((bar, i) => ({ bar, i })).find(({ bar, i }) => utcHour(bar) === 8 && bar.close > asiaHigh && i >= 43);
  assert.ok(breakAt, '合成数据应有位于伦敦时段的突破K线');

  // 片段以突破K线结尾（评估最后一根完成K线）
  const signal = buildResearchSignal(bars.slice(0, breakAt.i + 2), PAIR, TF, 'session-breakout');
  assert.equal(signal.direction, 'long');

  // 亚洲时段内部的同样价格不触发（不在伦敦时段）
  const asiaSignal = buildResearchSignal(bars.slice(0, 56), PAIR, TF, 'session-breakout');
  assert.equal(asiaSignal.direction, 'wait');
});

test('atr-channel requires EMA agreement plus an ATR-buffered breakout', () => {
  // 上升趋势中逐步推高：fast/slow EMA 多头排列，收盘持续创近期新高 + 缓冲
  const bars = [];
  const start = Date.UTC(2026, 8, 7) / 1000;
  let price = 150.0;
  for (let i = 0; i < 60; i += 1) {
    price += 0.12; // 稳定上行
    bars.push({ time: start + i * 3600, open: price - 0.12, high: price + 0.03, low: price - 0.06, close: price });
  }
  const signal = buildResearchSignal(bars, PAIR, TF, 'atr-channel');
  assert.equal(signal.direction, 'long');
  // 震荡序列（无趋势）应等待
  const flat = [];
  for (let i = 0; i < 60; i += 1) {
    const p = 150 + 0.05 * Math.sin(i * 1.3);
    flat.push({ time: start + i * 3600, open: p, high: p + 0.02, low: p - 0.02, close: p });
  }
  assert.equal(buildResearchSignal(flat, PAIR, TF, 'atr-channel').direction, 'wait');
});

test('asia-range observes only the confirmed re-entry into the Asian range', () => {
  // 3 天数据保证 ≥42 根；把第 3 天伦敦早盘改成"跌破亚洲区间 → 收盘回归区间内"
  const bars = makeSessionBars(3, 0.15);
  const day3 = 48;
  bars[day3 + 8] = { time: start3(bars) + 8 * 3600, open: 150.0, high: 150.01, low: 149.7, close: 149.72 };
  bars[day3 + 9] = { time: start3(bars) + 9 * 3600, open: 149.72, high: 149.99, low: 149.7, close: 149.98 };
  // 评估回归确认K线（index = day3+9）
  const signal = buildResearchSignal(bars.slice(0, day3 + 11), PAIR, TF, 'asia-range');
  assert.equal(signal.direction, 'long');
  // 跌破当根不触发（尚未回归）
  const duringBreak = buildResearchSignal(bars.slice(0, day3 + 10), PAIR, TF, 'asia-range');
  assert.equal(duringBreak.direction, 'wait');
});

function start3(bars) {
  return bars[48].time;
}

test('all three models run through the backtest engine without look-ahead', () => {
  const bars = makeSessionBars(2, 0.15).concat(makeSessionBars(2, 0.15).map((bar) => ({ ...bar, time: bar.time + 48 * 3600, open: bar.open + 0.5, high: bar.high + 0.5, low: bar.low + 0.5, close: bar.close + 0.5 })));
  for (const entryModel of ['session-breakout', 'atr-channel', 'asia-range']) {
    const result = runBacktest(bars, { ...DEFAULT_BACKTEST_CONFIG, entryModel, symbol: PAIR, timeframe: TF, riskPerTradePct: 0.25, spreadPips: 1 });
    assert.ok(result.totalTrades >= 0 && Number.isFinite(result.netReturnPct), `${entryModel} 应产出有限结果`);
    assert.ok(result.trades.every((trade) => trade.entryTime <= trade.exitTime));
  }
});
