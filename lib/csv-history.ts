import type { OhlcBar } from './market-data';

export interface CsvHistoryResult {
  bars: OhlcBar[];
  skippedRows: number;
  duplicateRows: number;
}

export interface HistoryQuality {
  firstTime: number;
  lastTime: number;
  dominantIntervalSeconds: number;
  gapCount: number;
  maxGapSeconds: number;
}

function numberValue(value: string) {
  return Number(value.trim().replace(',', '.'));
}

function timeValue(dateText: string, timeText?: string) {
  const normalizedDate = dateText.trim().replace(/\./g, '-').replace(/\//g, '-');
  const normalizedTime = (timeText ?? '00:00').trim();
  const timestamp = Date.parse(`${normalizedDate}T${normalizedTime.replace(/\s+/g, '')}+09:00`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Number.NaN;
}

export function parseOhlcCsv(content: string): CsvHistoryResult {
  const rows = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((row) => row.trim());
  const bars: OhlcBar[] = [];
  let skippedRows = 0;

  for (const row of rows) {
    const parts = row.split(row.includes(';') ? ';' : ',').map((part) => part.trim().replace(/^"|"$/g, ''));
    const looksLikeHeader = parts.some((part) => /date|time|open|high|low|close/i.test(part));
    if (looksLikeHeader) continue;

    const hasSeparateTime = parts.length >= 6 && /\d{1,2}:\d{2}/.test(parts[1]);
    const embedded = (parts[0] ?? '').match(/^(.+?)[ T](\d{1,2}:\d{2}(?::\d{2})?)$/);
    const offset = hasSeparateTime ? 2 : 1;
    const time = timeValue(embedded?.[1] ?? parts[0] ?? '', hasSeparateTime ? parts[1] : embedded?.[2]);
    const [open, high, low, close] = parts.slice(offset, offset + 4).map(numberValue);
    // 价格必须为正且在 FX/贵金属量级内；倒挂 OHLC 直接拒绝，不静默修饰。
    const MAX_FX_PRICE = 1_000_000;
    const prices = [open, high, low, close];
    const pricesSane = prices.every(Number.isFinite) && Math.min(...prices) > 0 && Math.max(...prices) <= MAX_FX_PRICE;
    if (![time, ...prices].every(Number.isFinite) || !pricesSane || high < Math.max(open, close) || low > Math.min(open, close)) {
      skippedRows += 1;
      continue;
    }
    bars.push({ time, open, high, low, close });
  }

  const uniqueSorted = Array.from(new Map(bars.map((bar) => [bar.time, bar])).values()).sort((a, b) => a.time - b.time);
  return { bars: uniqueSorted, skippedRows, duplicateRows: bars.length - uniqueSorted.length };
}

export function inspectHistory(bars: OhlcBar[]): HistoryQuality | null {
  if (bars.length < 2) return null;
  const intervals = bars.slice(1).map((bar, index) => bar.time - bars[index].time).filter((interval) => interval > 0);
  const counts = new Map<number, number>();
  intervals.forEach((interval) => counts.set(interval, (counts.get(interval) ?? 0) + 1));
  const dominantIntervalSeconds = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const gaps = intervals.filter((interval) => interval > dominantIntervalSeconds * 1.5);
  return {
    firstTime: bars[0].time,
    lastTime: bars[bars.length - 1].time,
    dominantIntervalSeconds,
    gapCount: gaps.length,
    maxGapSeconds: gaps.length ? Math.max(...gaps) : 0,
  };
}
