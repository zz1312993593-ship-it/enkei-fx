import type { OhlcBar, PairSymbol, StrategySignal, Timeframe } from './market-data';
import type { ResearchModel } from './model-catalog';

export type { ResearchModel } from './model-catalog';

function ema(values: number[], period: number) {
  const factor = 2 / (period + 1);
  return values.reduce<number[]>((result, value, index) => {
    result.push(index === 0 ? value : value * factor + result[index - 1] * (1 - factor));
    return result;
  }, []);
}

function atrValue(bars: OhlcBar[], index: number, period = 14) {
  if (index <= 0) return 0;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, index - period + 1); i <= index; i += 1) {
    const previousClose = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - previousClose), Math.abs(bars[i].low - previousClose));
    count += 1;
  }
  return count ? sum / count : 0;
}

// 会话按 UTC 时间划分：亚洲 00:00–07:00，伦敦 07:00–16:00。bar.time 为 epoch 秒。
function utcHour(timeSeconds: number) {
  return new Date(timeSeconds * 1000).getUTCHours();
}

/** 最近一个已完成的亚洲时段（UTC 0–7 点）区间；返回 null 表示当日亚洲段数据不足。 */
function asianRangeBefore(bars: OhlcBar[], index: number): { high: number; low: number } | null {
  const dayStart = Math.floor(bars[index].time / 86400) * 86400;
  const asiaStart = dayStart;
  const asiaEnd = dayStart + 7 * 3600;
  const window = bars.filter((bar) => bar.time >= asiaStart && bar.time < asiaEnd);
  if (window.length < 4) return null;
  return {
    high: Math.max(...window.map((bar) => bar.high)),
    low: Math.min(...window.map((bar) => bar.low)),
  };
}

/**
 * A read-only observation based only on completed bars. It does not submit an
 * order and deliberately returns wait unless a complete breakout is present.
 */
export function buildResearchSignal(bars: OhlcBar[], symbol: PairSymbol, timeframe: Timeframe, model: ResearchModel = 'trend-breakout'): StrategySignal {
  const fallback: StrategySignal = {
    symbol, timeframe, direction: 'wait', score: 0, trend: 'neutral', momentum: 'neutral', spreadState: 'normal', validUntil: '', strategyVersion: `${model}/0.4-research`,
  };
  if (bars.length < 42) return fallback;
  const closes = bars.map((bar) => bar.close);
  const fast = ema(closes, 12);
  const slow = ema(closes, 30);
  const index = bars.length - 2;
  const range = bars.slice(Math.max(0, index - 18), index);
  if (range.length < 18) return fallback;
  const close = bars[index].close;
  const highest = Math.max(...range.map((bar) => bar.high));
  const lowest = Math.min(...range.map((bar) => bar.low));
  const bullish = fast[index] > slow[index];
  const bearish = fast[index] < slow[index];
  const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
  const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
  const pulledBackUp = bullish && bars[index - 1].close <= fast[index - 1] && close > fast[index];
  const pulledBackDown = bearish && bars[index - 1].close >= fast[index - 1] && close < fast[index];
  const recentRange = Math.max(...bars.slice(Math.max(0, index - 10), index + 1).map((bar) => bar.high)) - Math.min(...bars.slice(Math.max(0, index - 10), index + 1).map((bar) => bar.low));
  const meanDistance = close - slow[index];
  const rangeReversionLong = Math.abs(fast[index] - slow[index]) <= Math.max(recentRange * 0.18, Math.abs(close) * 0.00005) && close <= lowest && meanDistance < 0;
  const rangeReversionShort = Math.abs(fast[index] - slow[index]) <= Math.max(recentRange * 0.18, Math.abs(close) * 0.00005) && close >= highest && meanDistance > 0;
  const momentumDistance = close - bars[Math.max(0, index - 5)].close;
  const momentumLong = momentumDistance > recentRange * 0.36 && close > fast[index];
  const momentumShort = momentumDistance < -recentRange * 0.36 && close < fast[index];
  // 批G：公开域经典思想的自研实现（时段突破 / 波动通道 / 亚洲区间回归）。
  const atr = atrValue(bars, index);
  const hour = utcHour(bars[index].time);
  const asian = asianRangeBefore(bars, index);
  const londonSession = hour >= 7 && hour < 16;
  const sessionLong = Boolean(asian) && londonSession && close > (asian as { high: number }).high;
  const sessionShort = Boolean(asian) && londonSession && close < (asian as { low: number }).low;
  const atrLong = bullish && close > highest + atr * 0.1;
  const atrShort = bearish && close < lowest - atr * 0.1;
  const asiaReversionLong = Boolean(asian) && close >= (asian as { low: number }).low && bars[index - 1].close < (asian as { low: number }).low;
  const asiaReversionShort = Boolean(asian) && close <= (asian as { high: number }).high && bars[index - 1].close > (asian as { high: number }).high;
  const direction = model === 'ema-cross'
    ? crossedUp ? 'long' : crossedDown ? 'short' : 'wait'
    : model === 'trend-pullback'
      ? pulledBackUp ? 'long' : pulledBackDown ? 'short' : 'wait'
      : model === 'range-reversion'
        ? rangeReversionLong ? 'long' : rangeReversionShort ? 'short' : 'wait'
        : model === 'momentum-pulse'
          ? momentumLong ? 'long' : momentumShort ? 'short' : 'wait'
          : model === 'session-breakout'
            ? sessionLong ? 'long' : sessionShort ? 'short' : 'wait'
            : model === 'atr-channel'
              ? atrLong ? 'long' : atrShort ? 'short' : 'wait'
              : model === 'asia-range'
                ? asiaReversionLong ? 'long' : asiaReversionShort ? 'short' : 'wait'
                : bullish && close > highest ? 'long' : bearish && close < lowest ? 'short' : 'wait';
  const separation = Math.abs(fast[index] - slow[index]) / Math.max(Math.abs(close) * 0.0001, 0.000001);
  const score = direction === 'wait' ? Math.min(58, 34 + Math.round(separation * 3)) : Math.min(88, 62 + Math.round(separation * 4));
  return {
    symbol,
    timeframe,
    direction,
    score,
    trend: bullish ? 'bullish' : bearish ? 'bearish' : 'neutral',
    momentum: direction === 'long' ? 'bullish' : direction === 'short' ? 'bearish' : 'neutral',
    spreadState: 'normal',
    validUntil: new Date((bars[index].time + 1) * 1000).toISOString(),
    strategyVersion: `${model}/0.4-research`,
  };
}
