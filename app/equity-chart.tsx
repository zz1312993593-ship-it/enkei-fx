'use client';

import { useEffect, useRef } from 'react';
import { ColorType, createChart, LineSeries, type LineData, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { EquityPoint } from '../lib/backtest';

const earliestSafeEpoch = Date.UTC(2000, 0, 1) / 1000;
const latestSafeEpoch = Date.UTC(2101, 0, 1) / 1000;

function safeChartTime(value: number, index: number, total: number) {
  if (Number.isFinite(value) && value >= earliestSafeEpoch && value < latestSafeEpoch) return Math.floor(value);
  if (Number.isFinite(value) && value >= earliestSafeEpoch * 1000 && value < latestSafeEpoch * 1000) return Math.floor(value / 1000);
  // Never allow malformed timestamps to create fictional historical years.
  return Math.floor(Date.now() / 1000) - (total - index) * 86400;
}

function asEpochSeconds(time: Time) {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}

function formatDisplayTime(time: Time, timeZone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(asEpochSeconds(time) * 1000));
}

function normalizeEquityPoints(points: EquityPoint[]): LineData[] {
  // Lightweight Charts requires strictly ascending, unique timestamps. Multiple
  // completed trades may share one bar timestamp, so retain the final equity
  // value for that second instead of rendering an invalid duplicate point.
  const unique = new Map<number, number>();
  points.forEach((point, index) => unique.set(safeChartTime(point.time, index, points.length), point.value));
  return [...unique.entries()]
    .sort(([left], [right]) => left - right)
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export default function EquityChart({ points, timeZone = 'Asia/Tokyo', locale = 'ja-JP' }: { points: EquityPoint[]; timeZone?: string; locale?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || points.length === 0) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: '#fffefa' },
        textColor: '#4f5953',
        fontFamily: 'Consolas, monospace',
        fontSize: 12,
      },
      localization: { locale, timeFormatter: (time: Time) => formatDisplayTime(time, timeZone, locale) },
      grid: { vertLines: { color: '#eeebe4' }, horzLines: { color: '#e9e6de' } },
      rightPriceScale: { borderColor: '#dedbd2' },
      timeScale: { borderColor: '#dedbd2', timeVisible: true, tickMarkFormatter: (time: Time) => formatDisplayTime(time, timeZone, locale) },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false },
    });
    const series = chart.addSeries(LineSeries, { color: '#115d44', lineWidth: 3, priceLineVisible: false });
    series.setData(normalizeEquityPoints(points));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [points, timeZone, locale]);

  return <div className="equity-chart" ref={containerRef} aria-label="Backtest equity curve" />;
}
