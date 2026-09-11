// 批5：桥接历史解析对抗测试（离线，不起网络服务）。
// 覆盖：缺字段、重复行、乱序、负价格、异常放大价格、OHLC 倒挂、Y1 聚合、报价规范化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateYears, asBar, normaliseQuote } from '../bridge/history-core.mjs';

test('asBar rejects rows with missing or non-numeric fields', () => {
  assert.equal(asBar('1700000000,1.10,1.11,1.09'), null);            // 少一列
  assert.equal(asBar('1700000000,1.10,1.11,,1.10'), null);           // 空字段
  assert.equal(asBar('not-a-time,1.10,1.11,1.09,1.10'), null);       // 时间非法
  // 多余列被忽略：仍按前五列解析（记录既有行为，避免无意变更）
  assert.deepEqual(asBar('1700000000,1.10,1.11,1.09,1.10,extra'),
    { time: 1700000000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 });
});

test('asBar rejects non-positive and absurd prices', () => {
  assert.equal(asBar('1700000000,-1.10,-1.09,-1.11,-1.10'), null);   // 负价格
  assert.equal(asBar('1700000000,0,0,0,0'), null);                   // 零价格
  assert.equal(asBar('1700000000,1e12,1e12,1e11,1e12'), null);       // 异常放大
  assert.deepEqual(asBar('1700000000,150.00,150.10,149.90,150.05'),
    { time: 1700000000, open: 150.0, high: 150.1, low: 149.9, close: 150.05 });
});

test('asBar rejects inverted OHLC', () => {
  assert.equal(asBar('1700000000,1.12,1.11,1.09,1.10'), null);       // high < max(open,close)
  assert.equal(asBar('1700000000,1.10,1.11,1.11,1.10'), null);       // low > min(open,close)
});

test('readHistory pipeline semantics: dedupe keeps last, output sorted', () => {
  const lines = [
    '1700000100,1.10,1.11,1.09,1.105',
    '1700000000,1.10,1.11,1.09,1.10',
    '1700000100,1.10,1.11,1.09,1.108', // 重复时间戳：后值生效
    'garbage,line',
  ];
  const bars = lines.map(asBar).filter(Boolean);
  const unique = Array.from(new Map(bars.map((bar) => [bar.time, bar])).values()).sort((a, b) => a.time - b.time);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].time, 1700000000);
  assert.equal(unique[1].close, 1.108);
});

test('aggregateYears merges to yearly candles without losing extremes', () => {
  const years = aggregateYears([
    { time: Date.UTC(2023, 0, 10) / 1000, open: 1.05, high: 1.12, low: 1.02, close: 1.10 },
    { time: Date.UTC(2023, 6, 10) / 1000, open: 1.10, high: 1.15, low: 1.04, close: 1.08 },
    { time: Date.UTC(2024, 2, 10) / 1000, open: 1.08, high: 1.14, low: 1.06, close: 1.13 },
  ]);
  assert.equal(years.length, 2);
  assert.equal(years[0].high, 1.15);
  assert.equal(years[0].low, 1.02);
  assert.equal(years[0].close, 1.08);
  assert.equal(years[1].close, 1.13);
});

test('normaliseQuote rejects malformed quotes', () => {
  assert.equal(normaliseQuote({ symbol: 'USDJPY', bid: 0, ask: 150.01, digits: 3 }), null);
  assert.equal(normaliseQuote({ symbol: 'USDJPY', bid: 'x', ask: 150.01, digits: 3 }), null);
  assert.equal(normaliseQuote({ symbol: 'USDJPY', bid: 150, ask: 150.01, digits: 9 }), null); // digits 越界
  assert.deepEqual(normaliseQuote({ symbol: 'USDJPY', bid: 150.0, ask: 150.01, digits: 3, tick_time: 1700000000 }),
    { symbol: 'USDJPY', bid: 150.0, ask: 150.01, digits: 3, tick_time: 1700000000 });
});
