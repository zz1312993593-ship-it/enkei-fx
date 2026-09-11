import type { AiMarketSummary, AiPolicy, AiTimeframe } from './ai-terminal';
import { toTerminalSymbol } from './ai-terminal';
import type { MarketQuote, OhlcBar, PairSymbol } from './market-data';

function ema(values: number[], period: number) {
  const factor = 2 / (period + 1);
  return values.reduce<number[]>((result, value, index) => {
    result.push(index === 0 ? value : value * factor + result[index - 1] * (1 - factor));
    return result;
  }, []);
}

export function buildAiMarketSummary(input: {
  symbol: PairSymbol;
  timeframe: AiTimeframe;
  quote: Pick<MarketQuote, 'bid' | 'ask' | 'spreadPips' | 'receivedAt'>;
  bars: OhlcBar[];
  selectedRuleModel: string;
  positions: Array<{ side: 'long' | 'short'; lots: number; open_price: number; profit: number }>;
  previousPolicy: AiPolicy | null;
}): AiMarketSummary | null {
  const bars = input.bars
    .filter((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
    .slice(-120);
  if (
    bars.length < 20 ||
    !Number.isFinite(input.quote.bid) ||
    !Number.isFinite(input.quote.ask) ||
    !Number.isFinite(input.quote.spreadPips)
  ) return null;
  const closes = bars.map((bar) => bar.close);
  const fast = ema(closes, 12).at(-1) ?? closes.at(-1) ?? 0;
  const slow = ema(closes, 30).at(-1) ?? closes.at(-1) ?? 0;
  const recent = bars.slice(-20);
  const high = Math.max(...recent.map((bar) => bar.high));
  const low = Math.min(...recent.map((bar) => bar.low));
  const pip = input.symbol.endsWith('/JPY') ? 0.01 : 0.0001;
  // Keep this literal identical to enkei-market-summary/v1.  Do not add UI,
  // account, ticket, credential, or terminal-only fields here.
  return {
    version: 'enkei-market-summary/v1',
    generated_at: new Date().toISOString(),
    symbol: toTerminalSymbol(input.symbol),
    timeframe: input.timeframe,
    quote: { bid: input.quote.bid, ask: input.quote.ask, spread_pips: input.quote.spreadPips, received_at: input.quote.receivedAt || new Date().toISOString() },
    features: { ema_fast: fast, ema_slow: slow, momentum: closes.at(-1)! - closes[Math.max(0, closes.length - 6)], recent_high: high, recent_low: low, range_pips: (high - low) / pip },
    bars: bars.map((bar) => ({ time: new Date(bar.time * 1000).toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
    execution_context: {
      selected_rule_model: input.selectedRuleModel,
      positions: input.positions,
      previous_policy: input.previousPolicy ? { action_bias: input.previousPolicy.action_bias, expires_at: input.previousPolicy.expires_at } : null,
    },
  };
}
