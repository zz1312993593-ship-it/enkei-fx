import type { OhlcBar, PairSymbol, Timeframe } from './market-data';
import type { ResearchModel } from './model-catalog';

export type EntryModel = ResearchModel;

export interface BacktestConfig {
  symbol: PairSymbol;
  timeframe: Timeframe;
  startingEquity: number;
  riskPerTradePct: number;
  fastEma: number;
  slowEma: number;
  breakoutLookback: number;
  atrPeriod: number;
  stopAtr: number;
  rewardRisk: number;
  maxHoldingBars: number;
  spreadPips: number;
  slippagePips: number;
  entryModel: EntryModel;
  startIndex?: number;
  /** 保本移损：浮盈达到该 R 倍数后，把止损移到开仓价（基于已完成K线判定）。未设置则不启用。 */
  breakEvenTriggerR?: number;
  /** ATR 跟踪止损：以已完成K线收盘 ∓ ATR×该倍数动态收紧止损（只收紧、不放松）。未设置则不启用。 */
  trailingStopAtrMult?: number;
  /** 部分平仓：浮盈触及该 R 倍数价位时了结一定比例（限价语义：触及即成交）。未设置则不启用。 */
  takePartialAtR?: number;
  /** 部分平仓比例（0–1）。默认 0.5。仅在 takePartialAtR 启用时生效。 */
  partialCloseFraction?: number;
  /** 连续止损保护：连续亏损 N 笔后暂停开仓 M 根K线（freqtrade StoplossGuard 同思路）。未设置则不启用。 */
  pauseAfterLosses?: { losses: number; pauseBars: number };
}

export interface BacktestTrade {
  id: number;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  rMultiple: number;
  pnlPct: number;
  exitReason: 'stop' | 'target' | 'time' | 'end';
  /** 部分平仓记录（批M）：各段 {加权前的 R 倍数, 占位比例}；rMultiple 已按段加权合成。 */
  partials?: Array<{ rMultiple: number; fraction: number }>;
}

export interface EquityPoint {
  time: number;
  value: number;
}

export interface BacktestResult {
  endingEquity: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  totalTrades: number;
  averageR: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
}

export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, 'symbol' | 'timeframe' | 'riskPerTradePct' | 'spreadPips'> = {
  startingEquity: 1_000_000,
  fastEma: 12,
  slowEma: 30,
  breakoutLookback: 18,
  atrPeriod: 14,
  stopAtr: 1.6,
  rewardRisk: 2.1,
  maxHoldingBars: 32,
  slippagePips: 0.2,
  entryModel: 'trend-breakout',
};

export interface MonteCarloConfig {
  riskPerTradePct: number;
  runs?: number;
  seed?: number;
  ruinDrawdownPct?: number;
}

export interface MonteCarloResult {
  runs: number;
  p5ReturnPct: number;
  p50ReturnPct: number;
  p95ReturnPct: number;
  p95MaxDrawdownPct: number;
  ruinProbabilityPct: number;
}

// 确定性伪随机（mulberry32）：同一 seed + 同一交易序列必然复现，
// 满足版本治理"结果可复现"的要求，且不依赖 Math.random 的不可复现性。
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runMonteCarlo(rMultiples: number[], config: MonteCarloConfig): MonteCarloResult {
  const runs = Math.max(1, Math.round(config.runs ?? 500));
  const ruinDrawdownPct = config.ruinDrawdownPct ?? 30;
  const rng = mulberry32(config.seed ?? 20260906);
  const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  const returns: number[] = [];
  const drawdowns: number[] = [];
  let ruinRuns = 0;
  if (rMultiples.length === 0) {
    return { runs, p5ReturnPct: 0, p50ReturnPct: 0, p95ReturnPct: 0, p95MaxDrawdownPct: 0, ruinProbabilityPct: 0 };
  }
  for (let run = 0; run < runs; run += 1) {
    let equity = 100;
    let peak = equity;
    let maxDrawdownPct = 0;
    // 有放回重抽样本次序（bootstrap）：保持单笔 R 分布不变，只重排出现顺序，
    // 用于观察"同样的交易，坏运气叠加时的回撤/收益分布"，不是收益承诺。
    for (let i = 0; i < rMultiples.length; i += 1) {
      const r = rMultiples[Math.floor(rng() * rMultiples.length)];
      equity *= 1 + (config.riskPerTradePct * r) / 100;
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    }
    const netReturnPct = equity - 100;
    returns.push(netReturnPct);
    drawdowns.push(maxDrawdownPct);
    if (maxDrawdownPct >= ruinDrawdownPct) ruinRuns += 1;
  }
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const sortedDrawdowns = [...drawdowns].sort((a, b) => a - b);
  return {
    runs,
    p5ReturnPct: percentile(sortedReturns, 0.05),
    p50ReturnPct: percentile(sortedReturns, 0.5),
    p95ReturnPct: percentile(sortedReturns, 0.95),
    p95MaxDrawdownPct: percentile(sortedDrawdowns, 0.95),
    ruinProbabilityPct: (ruinRuns / runs) * 100,
  };
}

function ema(values: number[], period: number) {
  const factor = 2 / (period + 1);
  const result: number[] = [];
  values.forEach((value, index) => {
    result.push(index === 0 ? value : value * factor + result[index - 1] * (1 - factor));
  });
  return result;
}

function atr(bars: OhlcBar[], period: number) {
  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  const values: number[] = [];
  trueRanges.forEach((value, index) => {
    if (index === 0) values.push(value);
    else values.push((values[index - 1] * (period - 1) + value) / period);
  });
  return values;
}

function pipSize(symbol: PairSymbol) {
  return symbol.endsWith('/JPY') ? 0.01 : 0.0001;
}

// 批G：会话/区间辅助（与 research-signal 同口径：亚洲 UTC0–7，伦敦 UTC7–16）。
function utcHourOf(timeSeconds: number) {
  return new Date(timeSeconds * 1000).getUTCHours();
}

function asianRangeUpto(bars: OhlcBar[], signalIndex: number): { high: number; low: number } | null {
  const dayStart = Math.floor(bars[signalIndex].time / 86400) * 86400;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let count = 0;
  for (let i = signalIndex; i >= 0; i -= 1) {
    const bar = bars[i];
    if (bar.time < dayStart) break;
    if (utcHourOf(bar.time) < 7) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      count += 1;
    }
  }
  return count >= 4 ? { high, low } : null;
}

export function runBacktest(bars: OhlcBar[], config: BacktestConfig): BacktestResult {
  const fast = ema(bars.map((bar) => bar.close), config.fastEma);
  const slow = ema(bars.map((bar) => bar.close), config.slowEma);
  const volatility = atr(bars, config.atrPeriod);
  const trades: BacktestTrade[] = [];
  const warmup = Math.max(config.slowEma, config.breakoutLookback, config.atrPeriod) + 2;
  const firstTradingIndex = Math.max(warmup, config.startIndex ?? warmup);
  const equityCurve: EquityPoint[] = [{ time: bars[firstTradingIndex]?.time ?? bars[0]?.time ?? 0, value: config.startingEquity }];
  let equity = config.startingEquity;
  let peak = equity;
  let maxDrawdownPct = 0;
  let position: {
    side: 'long' | 'short';
    entryIndex: number;
    entryTime: number;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    riskDistance: number;
    remainingFraction: number;
    partials: Array<{ rMultiple: number; fraction: number }>;
    partialTaken: boolean;
  } | null = null;
  let lossStreak = 0;
  let pauseUntilIndex = -1;

  const closePosition = (exitIndex: number, exitPrice: number, reason: BacktestTrade['exitReason']) => {
    if (!position) return;
    const sign = position.side === 'long' ? 1 : -1;
    const grossR = sign * (exitPrice - position.entryPrice) / position.riskDistance;
    const costPrice = (config.spreadPips + config.slippagePips) * pipSize(config.symbol);
    const netR = grossR - costPrice / position.riskDistance;
    // 部分平仓核算：各段 R 按其占位比例加权（近似：忽略段间复利，研究用途足够）。
    const weightedR = position.partials.reduce((sum, part) => sum + part.rMultiple * part.fraction, netR * position.remainingFraction);
    const pnlPct = config.riskPerTradePct * weightedR;
    equity *= 1 + pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    // 批N：连续亏损保护——按加权 R 记亏损连击，达到阈值后暂停开仓若干根。
    if (config.pauseAfterLosses) {
      if (weightedR < 0) {
        lossStreak += 1;
        if (lossStreak >= config.pauseAfterLosses.losses) {
          pauseUntilIndex = exitIndex + config.pauseAfterLosses.pauseBars;
          lossStreak = 0;
        }
      } else {
        lossStreak = 0;
      }
    }
    trades.push({
      id: trades.length + 1,
      side: position.side,
      entryTime: position.entryTime,
      exitTime: bars[exitIndex].time,
      entryPrice: position.entryPrice,
      exitPrice,
      rMultiple: weightedR,
      pnlPct,
      exitReason: reason,
      partials: position.partials.length ? [...position.partials] : undefined,
    });
    equityCurve.push({ time: bars[exitIndex].time, value: equity });
    position = null;
  };

  for (let index = firstTradingIndex; index < bars.length; index += 1) {
    const bar = bars[index];

    if (position) {
      const holdingBars = index - position.entryIndex;
      // 批I：交易管理（源自 MQL5 生态标准做法）——只用已完成K线判定，杜绝K线内未来信息。
      const previous = bars[index - 1];
      const previousAtr = volatility[index - 1];
      if (config.breakEvenTriggerR !== undefined && holdingBars >= 1) {
        if (position.side === 'long') {
          const profitR = (previous.high - position.entryPrice) / position.riskDistance;
          if (profitR >= config.breakEvenTriggerR && position.stopPrice < position.entryPrice) position.stopPrice = position.entryPrice;
        } else {
          const profitR = (position.entryPrice - previous.low) / position.riskDistance;
          if (profitR >= config.breakEvenTriggerR && position.stopPrice > position.entryPrice) position.stopPrice = position.entryPrice;
        }
      }
      if (config.trailingStopAtrMult !== undefined && holdingBars >= 1) {
        if (position.side === 'long') {
          const trail = previous.close - previousAtr * config.trailingStopAtrMult;
          if (trail > position.stopPrice) position.stopPrice = trail; // 只收紧
        } else {
          const trail = previous.close + previousAtr * config.trailingStopAtrMult;
          if (trail < position.stopPrice) position.stopPrice = trail; // 只收紧
        }
      }
      // 批M：部分平仓（限价语义：价格触及预设 R 水平即成交，非未来信息）。
      if (config.takePartialAtR !== undefined && !position.partialTaken) {
        const fraction = Math.min(0.9, Math.max(0.1, config.partialCloseFraction ?? 0.5));
        if (position.side === 'long') {
          const triggerPrice = position.entryPrice + position.riskDistance * config.takePartialAtR;
          if (bar.high >= triggerPrice) {
            position.partials.push({ rMultiple: config.takePartialAtR, fraction });
            position.remainingFraction = 1 - fraction;
            position.partialTaken = true;
          }
        } else {
          const triggerPrice = position.entryPrice - position.riskDistance * config.takePartialAtR;
          if (bar.low <= triggerPrice) {
            position.partials.push({ rMultiple: config.takePartialAtR, fraction });
            position.remainingFraction = 1 - fraction;
            position.partialTaken = true;
          }
        }
      }
      if (position.side === 'long') {
        if (bar.low <= position.stopPrice) closePosition(index, position.stopPrice, 'stop');
        else if (bar.high >= position.targetPrice) closePosition(index, position.targetPrice, 'target');
        else if (holdingBars >= config.maxHoldingBars) closePosition(index, bar.close, 'time');
      } else {
        if (bar.high >= position.stopPrice) closePosition(index, position.stopPrice, 'stop');
        else if (bar.low <= position.targetPrice) closePosition(index, position.targetPrice, 'target');
        else if (holdingBars >= config.maxHoldingBars) closePosition(index, bar.close, 'time');
      }
      if (position) continue;
    }

    // 批N：连续止损保护——暂停期内不开新仓。
    if (config.pauseAfterLosses && index <= pauseUntilIndex) continue;

    const signalIndex = index - 1;
    const rangeStart = Math.max(0, signalIndex - config.breakoutLookback);
    const comparisonBars = bars.slice(rangeStart, signalIndex);
    const highest = Math.max(...comparisonBars.map((item) => item.high));
    const lowest = Math.min(...comparisonBars.map((item) => item.low));
    const signalClose = bars[signalIndex].close;
    const riskDistance = volatility[signalIndex] * config.stopAtr;
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) continue;

    const previousFast = fast[Math.max(0, signalIndex - 1)];
    const previousSlow = slow[Math.max(0, signalIndex - 1)];
    const longBreakout = fast[signalIndex] > slow[signalIndex] && signalClose > highest;
    const shortBreakout = fast[signalIndex] < slow[signalIndex] && signalClose < lowest;
    const longCross = fast[signalIndex] > slow[signalIndex] && previousFast <= previousSlow;
    const shortCross = fast[signalIndex] < slow[signalIndex] && previousFast >= previousSlow;
    const longPullback = fast[signalIndex] > slow[signalIndex] && bars[signalIndex].low <= fast[signalIndex] && signalClose > fast[signalIndex];
    const shortPullback = fast[signalIndex] < slow[signalIndex] && bars[signalIndex].high >= fast[signalIndex] && signalClose < fast[signalIndex];
    const recentRange = highest - lowest;
    const flatMarket = Math.abs(fast[signalIndex] - slow[signalIndex]) <= Math.max(recentRange * 0.18, Math.abs(signalClose) * 0.00005);
    const longReversion = flatMarket && signalClose <= lowest && signalClose < slow[signalIndex];
    const shortReversion = flatMarket && signalClose >= highest && signalClose > slow[signalIndex];
    const momentumMove = signalClose - bars[Math.max(0, signalIndex - 5)].close;
    const longMomentum = momentumMove > recentRange * 0.36 && signalClose > fast[signalIndex];
    const shortMomentum = momentumMove < -recentRange * 0.36 && signalClose < fast[signalIndex];
    // 批G：公开域经典思想的自研实现（时段突破 / 波动通道 / 亚洲区间回归）。
    const hour = utcHourOf(bars[signalIndex].time);
    const asian = asianRangeUpto(bars, signalIndex);
    const atrBuffer = volatility[signalIndex] * 0.1;
    const longSession = asian !== null && hour >= 7 && hour < 16 && signalClose > asian.high;
    const shortSession = asian !== null && hour >= 7 && hour < 16 && signalClose < asian.low;
    const longAtr = fast[signalIndex] > slow[signalIndex] && signalClose > highest + atrBuffer;
    const shortAtr = fast[signalIndex] < slow[signalIndex] && signalClose < lowest - atrBuffer;
    const longAsia = asian !== null && signalClose >= asian.low && bars[signalIndex - 1].close < asian.low;
    const shortAsia = asian !== null && signalClose <= asian.high && bars[signalIndex - 1].close > asian.high;
    const longSignal = config.entryModel === 'trend-breakout' ? longBreakout
      : config.entryModel === 'ema-cross' ? longCross
        : config.entryModel === 'trend-pullback' ? longPullback
          : config.entryModel === 'range-reversion' ? longReversion
            : config.entryModel === 'session-breakout' ? longSession
              : config.entryModel === 'atr-channel' ? longAtr
                : config.entryModel === 'asia-range' ? longAsia
                  : longMomentum;
    const shortSignal = config.entryModel === 'trend-breakout' ? shortBreakout
      : config.entryModel === 'ema-cross' ? shortCross
        : config.entryModel === 'trend-pullback' ? shortPullback
          : config.entryModel === 'range-reversion' ? shortReversion
            : config.entryModel === 'session-breakout' ? shortSession
              : config.entryModel === 'atr-channel' ? shortAtr
                : config.entryModel === 'asia-range' ? shortAsia
                  : shortMomentum;

    if (longSignal) {
      position = {
        side: 'long',
        entryIndex: index,
        entryTime: bar.time,
        entryPrice: bar.open,
        stopPrice: bar.open - riskDistance,
        targetPrice: bar.open + riskDistance * config.rewardRisk,
        riskDistance,
        remainingFraction: 1,
        partials: [],
        partialTaken: false,
      };
    } else if (shortSignal) {
      position = {
        side: 'short',
        entryIndex: index,
        entryTime: bar.time,
        entryPrice: bar.open,
        stopPrice: bar.open + riskDistance,
        targetPrice: bar.open - riskDistance * config.rewardRisk,
        riskDistance,
        remainingFraction: 1,
        partials: [],
        partialTaken: false,
      };
    }
  }

  if (position && bars.length) closePosition(bars.length - 1, bars[bars.length - 1].close, 'end');

  const wins = trades.filter((trade) => trade.rMultiple > 0);
  const losses = trades.filter((trade) => trade.rMultiple < 0);
  const grossProfit = wins.reduce((total, trade) => total + trade.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((total, trade) => total + trade.rMultiple, 0));
  const totalR = trades.reduce((total, trade) => total + trade.rMultiple, 0);

  return {
    endingEquity: equity,
    netReturnPct: ((equity / config.startingEquity) - 1) * 100,
    maxDrawdownPct,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    totalTrades: trades.length,
    averageR: trades.length ? totalR / trades.length : 0,
    trades,
    equityCurve,
  };
}
