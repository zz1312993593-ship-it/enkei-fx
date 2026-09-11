// 批9：Monte Carlo 重抽样测试（编译产物由 npm test / CI 先生成 tests/.build）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMonteCarlo } from './.build/backtest.js';

const R = [1, -1, 2.1, -1, 0.5, -1, 1, -1, 2.1, -1]; // 近似 RR=2.1、胜率 40% 的交易序列

test('deterministic: same seed reproduces the same distribution', () => {
  const a = runMonteCarlo(R, { riskPerTradePct: 1, runs: 300, seed: 42 });
  const b = runMonteCarlo(R, { riskPerTradePct: 1, runs: 300, seed: 42 });
  assert.deepEqual(a, b);
});

test('percentiles are ordered and drawdown is reported', () => {
  const mc = runMonteCarlo(R, { riskPerTradePct: 1, runs: 500, seed: 7 });
  assert.ok(mc.p5ReturnPct <= mc.p50ReturnPct, `p5 ${mc.p5ReturnPct} <= p50 ${mc.p50ReturnPct}`);
  assert.ok(mc.p50ReturnPct <= mc.p95ReturnPct, `p50 ${mc.p50ReturnPct} <= p95 ${mc.p95ReturnPct}`);
  assert.ok(mc.p95MaxDrawdownPct > 0, 'p95 drawdown should be positive for risky sequences');
});

test('all-winning trades never hit ruin, all-losing always hit ruin', () => {
  const winners = runMonteCarlo([1, 1, 1, 1], { riskPerTradePct: 1, runs: 100, seed: 1 });
  assert.equal(winners.ruinProbabilityPct, 0);
  // 40 笔连续 -1R、单笔 1% 风险：权益 ≈ 0.99^40 → 回撤 ~33% ≥ 30% 破产线
  const losers = runMonteCarlo(Array(40).fill(-1), { riskPerTradePct: 1, runs: 100, seed: 1 });
  assert.equal(losers.ruinProbabilityPct, 100);
});

test('empty trade list yields a neutral, non-crashing result', () => {
  const mc = runMonteCarlo([], { riskPerTradePct: 1, runs: 10, seed: 3 });
  assert.equal(mc.p50ReturnPct, 0);
  assert.equal(mc.ruinProbabilityPct, 0);
});
