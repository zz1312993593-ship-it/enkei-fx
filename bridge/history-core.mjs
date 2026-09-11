// 桥接历史数据的纯解析核心。供 server.mjs 引用，也可被离线测试直接导入。
// 规则：缺字段/非数值/时间非法/价格非正/OHLC 倒挂一律拒绝（不静默修饰）；
// 重复时间戳去重、乱序排序，保证输出单调递增。

export const supportedSymbols = new Set(['USDJPY', 'EURUSD', 'EURJPY', 'GBPUSD', 'GBPJPY', 'AUDJPY']);
export const supportedTimeframes = new Set(['M1', 'M5', 'M15', 'H1', 'H4', 'D1', 'W1', 'MN1', 'Y1']);

export function normaliseSymbol(value) {
  return String(value ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
}

export function historyPathFor(commonDirectory, symbol, timeframe) {
  const key = normaliseSymbol(symbol);
  if (!supportedSymbols.has(key)) return null;
  const interval = String(timeframe ?? '').toUpperCase();
  if (!supportedTimeframes.has(interval)) return null;
  return path.join(commonDirectory, `${key}-${interval === 'Y1' ? 'MN1' : interval}.csv`);
}

import path from 'node:path';

export function normaliseQuote(quote) {
  const symbol = String(quote?.symbol ?? '');
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const digits = Number(quote?.digits);
  const tickTime = Number(quote?.tick_time);
  if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || !Number.isInteger(digits) || digits < 0 || digits > 8) return null;
  return { symbol, bid, ask, digits, ...(Number.isFinite(tickTime) && tickTime > 0 ? { tick_time: tickTime } : {}) };
}

export function asBar(line) {
  const [timeText, openText, highText, lowText, closeText] = line.split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
  const time = Number(timeText);
  const open = Number(openText);
  const high = Number(highText);
  const low = Number(lowText);
  const close = Number(closeText);
  // 价格必须为正、有限且在本桥接支持的 FX/贵金属量级内：负值、零、
  // 以及异常放大一个量级以上的数值都视为坏数据，拒绝而不是修饰。
  const MAX_FX_PRICE = 1_000_000;
  const prices = [open, high, low, close];
  if (![time, ...prices].every(Number.isFinite) || time <= 0) return null;
  if (Math.min(...prices) <= 0 || Math.max(...prices) > MAX_FX_PRICE) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return { time, open, high, low, close };
}

export function aggregateYears(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const year = new Date(bar.time * 1000).getUTCFullYear();
    const current = groups.get(year);
    if (!current) groups.set(year, { ...bar });
    else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
    }
  }
  return [...groups.values()].sort((left, right) => left.time - right.time);
}
