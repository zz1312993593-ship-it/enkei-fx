// 批5：前端 CSV 解析对抗测试。测试目标为 lib/csv-history.ts（编译产物），
// 由 scripts/ci.mjs 先执行 tsc 编译到 tests/.build 再运行本文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOhlcCsv, inspectHistory } from './.build/csv-history.js';

const HEADER = 'Date,Time,Open,High,Low,Close\n';

test('parses standard MT4 CSV and skips the header row', () => {
  const result = parseOhlcCsv(HEADER + '2026.01.05,10:00,150.00,150.10,149.90,150.05\n');
  assert.equal(result.bars.length, 1);
  assert.equal(result.skippedRows, 0);
});

test('rejects missing fields, non-numeric values and inverted OHLC', () => {
  const csv = HEADER
    + '2026.01.05,10:00,150.00,150.10,149.90\n'          // 少一列
    + '2026.01.05,10:01,abc,150.10,149.90,150.00\n'      // 非数值
    + '2026.01.05,10:02,150.20,150.10,149.90,150.00\n'   // OHLC 倒挂
    + '2026.01.05,10:03,150.00,150.10,149.90,150.00\n';
  const result = parseOhlcCsv(csv);
  assert.equal(result.bars.length, 1);
  assert.equal(result.skippedRows, 3);
});

test('rejects negative, zero and absurd prices', () => {
  const csv = HEADER
    + '2026.01.05,10:00,-150.00,-150.10,-149.90,-150.00\n'
    + '2026.01.05,10:01,0,0,0,0\n'
    + '2026.01.05,10:02,1000000000,1000000001,999999999,1000000000\n'
    + '2026.01.05,10:03,150.00,150.10,149.90,150.00\n';
  const result = parseOhlcCsv(csv);
  assert.equal(result.bars.length, 1);
  assert.equal(result.skippedRows, 3);
});

test('deduplicates timestamps and sorts out-of-order rows', () => {
  const csv = HEADER
    + '2026.01.05,10:02,150.20,150.30,150.10,150.25\n'
    + '2026.01.05,10:00,150.00,150.10,149.90,150.05\n'
    + '2026.01.05,10:02,150.20,150.30,150.10,150.28\n'; // 重复时间戳，后值生效
  const result = parseOhlcCsv(csv);
  assert.equal(result.bars.length, 2);
  assert.equal(result.duplicateRows, 1);
  assert.ok(result.bars[0].time < result.bars[1].time);
  assert.equal(result.bars[1].close, 150.28);
});

test('handles embedded datetime and semicolon delimiters', () => {
  const result = parseOhlcCsv('2026-01-05 10:00;150.00;150.10;149.90;150.05\n');
  assert.equal(result.bars.length, 1);
  assert.ok(Number.isFinite(result.bars[0].time));
});

test('inspectHistory reports gaps instead of hiding them', () => {
  const t = (minutes) => 1700000000 + minutes * 60;
  const bars = [
    { time: t(0), open: 1, high: 1, low: 1, close: 1 },
    { time: t(1), open: 1, high: 1, low: 1, close: 1 },
    { time: t(2), open: 1, high: 1, low: 1, close: 1 },
    { time: t(9), open: 1, high: 1, low: 1, close: 1 }, // 7 分钟缺口
  ];
  const quality = inspectHistory(bars);
  assert.equal(quality.dominantIntervalSeconds, 60);
  assert.equal(quality.gapCount, 1);
  assert.equal(quality.maxGapSeconds, 420);
});
