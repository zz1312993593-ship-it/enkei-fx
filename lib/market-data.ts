export type PairSymbol =
  | 'USD/JPY'
  | 'EUR/USD'
  | 'EUR/JPY'
  | 'GBP/USD'
  | 'GBP/JPY'
  | 'AUD/JPY';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1' | 'W1' | 'MN1' | 'Y1';
export type TradingMode = 'readonly' | 'backtest' | 'paper' | 'demo' | 'live';
export type SignalDirection = 'long' | 'short' | 'wait';

export interface MarketQuote {
  symbol: PairSymbol;
  bid: number;
  ask: number;
  changePct: number;
  spreadPips: number;
  receivedAt: string;
  source: 'demo' | 'mt4';
}

export interface OhlcBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StrategySignal {
  symbol: PairSymbol;
  timeframe: Timeframe;
  direction: SignalDirection;
  score: number;
  trend: 'bullish' | 'neutral' | 'bearish';
  momentum: 'bullish' | 'neutral' | 'bearish';
  spreadState: 'normal' | 'wide';
  validUntil: string;
  strategyVersion: string;
}

export interface RiskConfig {
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxOpenPositions: number;
  maxSpreadPips: number;
  eventPauseMinutes: number;
  requireStopLoss: true;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPerTradePct: 0.25,
  dailyLossLimitPct: 1,
  // User-editable operating limit. The EA hard ceiling remains 10.
  maxOpenPositions: 2,
  maxSpreadPips: 2,
  eventPauseMinutes: 30,
  requireStopLoss: true,
};

export const QUOTES: MarketQuote[] = [
  { symbol: 'USD/JPY', bid: 146.284, ask: 146.292, changePct: 0.18, spreadPips: 0.8, receivedAt: '2026-08-26T05:32:06Z', source: 'demo' },
  { symbol: 'EUR/USD', bid: 1.16842, ask: 1.16848, changePct: -0.07, spreadPips: 0.6, receivedAt: '2026-08-26T05:32:06Z', source: 'demo' },
  { symbol: 'EUR/JPY', bid: 170.936, ask: 170.947, changePct: 0.11, spreadPips: 1.1, receivedAt: '2026-08-26T05:32:06Z', source: 'demo' },
  { symbol: 'GBP/USD', bid: 1.34751, ask: 1.34763, changePct: 0.09, spreadPips: 1.2, receivedAt: '2026-08-26T05:32:06Z', source: 'demo' },
  { symbol: 'GBP/JPY', bid: 197.121, ask: 197.136, changePct: 0.24, spreadPips: 1.5, receivedAt: '2026-08-26T05:32:06Z', source: 'demo' },
  { symbol: 'AUD/JPY', bid: 95.638, ask: 95.650, changePct: -0.13, spreadPips: 1.2, receivedAt: '2026-08-26T05:32:06Z', source: 'demo' },
];

const BASE_PRICE: Record<PairSymbol, number> = {
  'USD/JPY': 145.94,
  'EUR/USD': 1.1698,
  'EUR/JPY': 170.56,
  'GBP/USD': 1.3448,
  'GBP/JPY': 196.41,
  'AUD/JPY': 95.84,
};

const PRICE_SCALE: Record<PairSymbol, number> = {
  'USD/JPY': 0.065,
  'EUR/USD': 0.00042,
  'EUR/JPY': 0.071,
  'GBP/USD': 0.00055,
  'GBP/JPY': 0.088,
  'AUD/JPY': 0.039,
};

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 604800,
  MN1: 2629800,
  Y1: 31557600,
};

// Synthetic data is only a visual fallback.  Do not fabricate centuries of
// candles when the user opens a long timeframe (for example, 900 annual bars).
// Real MT4 history is never capped here.
const DEMO_BAR_LIMIT: Record<Timeframe, number> = {
  M1: 20000,
  M5: 12000,
  M15: 8000,
  H1: 5000,
  H4: 2500,
  D1: 1260,
  W1: 520,
  MN1: 240,
  Y1: 50,
};

export function buildDemoBars(symbol: PairSymbol, timeframe: Timeframe, length = 96): OhlcBar[] {
  const step = TIMEFRAME_SECONDS[timeframe];
  const safeLength = Math.max(2, Math.min(Math.floor(length), DEMO_BAR_LIMIT[timeframe]));
  // Demo bars must end near the present and stay within a believable span.
  // This prevents long-period views from drawing fictional years such as 1149.
  const start = Math.floor(Date.now() / 1000) - Math.max(0, safeLength - 1) * step;
  const base = BASE_PRICE[symbol];
  const scale = PRICE_SCALE[symbol] * ({ M1: 0.3, M5: 0.55, M15: 0.8, H1: 1.25, H4: 1.75, D1: 2.2, W1: 3.3, MN1: 4.6, Y1: 6.5 }[timeframe]);

  return Array.from({ length: safeLength }, (_, index) => {
    const regime = Math.sin(index * 0.037) * scale * 2.4;
    const trend = index * scale * 0.018 + regime;
    const wave = Math.sin(index * 0.31) * scale + Math.sin(index * 0.11) * scale * 0.65;
    const open = base + trend + wave;
    const close = open + Math.sin(index * 0.77) * scale * 0.42;
    const wick = scale * (0.42 + Math.abs(Math.cos(index * 0.43)) * 0.34);
    return {
      time: start + index * step,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick * 0.82,
      close,
    };
  });
}

export function buildSignal(symbol: PairSymbol, timeframe: Timeframe): StrategySignal {
  const isUsdJpy = symbol === 'USD/JPY';
  const isNegative = symbol === 'EUR/USD' || symbol === 'AUD/JPY';
  return {
    symbol,
    timeframe,
    direction: isUsdJpy ? 'wait' : isNegative ? 'short' : 'long',
    score: isUsdJpy ? 62 : isNegative ? 71 : 68,
    trend: isNegative ? 'bearish' : 'bullish',
    momentum: isUsdJpy ? 'neutral' : isNegative ? 'bearish' : 'bullish',
    spreadState: 'normal',
    validUntil: '2026-08-26T05:45:00Z',
    strategyVersion: 'trend-breakout/0.1.0-demo',
  };
}

export function decimalsFor(symbol: PairSymbol) {
  return symbol.endsWith('/JPY') ? 3 : 5;
}
