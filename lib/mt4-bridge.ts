export interface Mt4QuoteSnapshot {
  symbol: string;
  bid: number;
  ask: number;
  digits: number;
  server_time: string;
  server_epoch?: number | null;
  gmt_epoch?: number | null;
  server_gmt_offset_seconds?: number;
  history_time_adjustment_seconds?: number;
  clock_status?: 'aligned' | 'offset-corrected' | 'unresolved';
  age_ms: number;
  mode: 'read-only-mt4-demo';
  quotes?: Mt4Quote[];
}

export interface Mt4Quote {
  symbol: string;
  bid: number;
  ask: number;
  digits: number;
  tick_time?: number;
}

export interface Mt4HistorySnapshot {
  symbol: string;
  timeframe: 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1' | 'W1' | 'MN1' | 'Y1';
  bars: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  total_bars: number;
  file_updated_at: string;
  file_age_ms: number;
  latest_bar_time: number | null;
  raw_latest_bar_time: number | null;
  clock: { status: 'aligned' | 'offset-corrected' | 'unresolved' | 'unavailable'; server_gmt_offset_seconds: number; history_time_adjustment_seconds: number };
  source: 'mt4-local-history-read-only';
  mode: 'read-only-mt4-demo';
}

export interface Mt4HistoryCoverage {
  symbol: string;
  coverage: Array<{ timeframe: Mt4HistorySnapshot['timeframe']; ready: boolean; bytes: number; age_ms: number | null }>;
}

export interface Mt4SupervisorSnapshot {
  version?: string;
  mode?: 'read-only-background-research';
  status: 'waiting-for-mt4' | 'clock-not-verified' | 'history-building' | 'research-watch-ready' | 'waiting';
  updated_at?: string;
  file_age_ms?: number;
  cycle?: number;
  interval_seconds?: number;
  ready_market_count?: number;
  alerts?: string[];
  snapshot?: { fresh?: boolean; clock_status?: string; quote_count?: number };
  safety?: { orders?: boolean; account_reads?: boolean; credential_storage?: boolean; broker_connection?: boolean };
  message?: string;
}

export function isMatchingSymbol(snapshot: Mt4QuoteSnapshot | null, symbol: string) {
  return findMt4Quote(snapshot, symbol) !== null;
}

export function findMt4Quote(snapshot: Mt4QuoteSnapshot | null, symbol: string): Mt4Quote | null {
  const target = symbol.replace('/', '').replace(/[^A-Z]/g, '');
  const candidates = snapshot?.quotes ?? (snapshot ? [snapshot] : []);
  return candidates.find((quote) => quote.symbol.replace(/[^A-Z]/g, '') === target) ?? null;
}
