'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type LineData,
  TickMarkType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { OhlcBar, PairSymbol, Timeframe } from '../lib/market-data';
import { decimalsFor, TIMEFRAME_SECONDS } from '../lib/market-data';

type Language = 'zh' | 'ja' | 'en';

export interface LiveQuote {
  bid: number;
  ask: number;
  at: number;
}

interface FxChartProps {
  bars: OhlcBar[];
  symbol: PairSymbol;
  timeframe: Timeframe;
  source?: 'demo' | 'mt4' | 'unavailable';
  timeZone?: string;
  locale?: string;
  language?: Language;
  liveQuote?: LiveQuote | null;
  theme?: 'light' | 'dark';
  costBasis?: number | null;
}

// 暗色主题调色（指挥控制台用）：与亮色同构，仅换色。
const CHART_THEMES = {
  light: { background: '#fffefa', textColor: '#4f5953', gridVert: '#eeebe4', gridHorz: '#e9e6de', border: '#dedbd2', crosshair: '#8a938e', up: '#115d44', down: '#b5483f' },
  dark: { background: '#0d1310', textColor: '#8fa39a', gridVert: '#16201b', gridHorz: '#131b17', border: '#22302a', crosshair: '#4d6a5c', up: '#35d08c', down: '#ff6b6b' },
} as const;

function asEpochSeconds(time: Time) {
  if (typeof time === 'number') return Math.floor(time);
  if (typeof time === 'string') return Math.floor(new Date(time).getTime() / 1000);
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
}

function normaliseBar(bar: OhlcBar): OhlcBar | null {
  const time = Math.floor(Number(bar.time));
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  if (![time, open, high, low, close].every(Number.isFinite) || time <= 0) return null;
  return { time, open, high, low, close };
}

function formatDisplayTime(time: Time, timeZone: string, locale: string, showSeconds = false) {
  return new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: showSeconds ? '2-digit' : undefined, hourCycle: 'h23' }).format(new Date(asEpochSeconds(time) * 1000));
}

function formatAxisTime(time: Time, kind: TickMarkType, timeZone: string, locale: string) {
  const date = new Date(asEpochSeconds(time) * 1000);
  if (kind === TickMarkType.Year) return new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric' }).format(date);
  if (kind === TickMarkType.Month) return new Intl.DateTimeFormat(locale, { timeZone, year: '2-digit', month: '2-digit' }).format(date);
  if (kind === TickMarkType.DayOfMonth) return new Intl.DateTimeFormat(locale, { timeZone, month: '2-digit', day: '2-digit' }).format(date);
  return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', second: kind === TickMarkType.TimeWithSeconds ? '2-digit' : undefined, hourCycle: 'h23' }).format(date);
}

function simpleMovingAverage(bars: OhlcBar[], period: number): LineData<UTCTimestamp>[] {
  const rows: LineData<UTCTimestamp>[] = [];
  bars.forEach((bar, index) => {
    if (index < period - 1) return;
    const value = bars.slice(index - period + 1, index + 1).reduce((sum, item) => sum + item.close, 0) / period;
    rows.push({ time: bar.time as UTCTimestamp, value });
  });
  return rows;
}

function exponentialMovingAverage(bars: OhlcBar[], period: number): LineData<UTCTimestamp>[] {
  const factor = 2 / (period + 1);
  let previous = bars[0]?.close ?? 0;
  return bars.map((bar, index): LineData<UTCTimestamp> => {
    previous = index === 0 ? bar.close : bar.close * factor + previous * (1 - factor);
    return { time: bar.time as UTCTimestamp, value: previous };
  });
}

export default function FxChart({ bars, symbol, timeframe, source = 'demo', timeZone = 'Asia/Tokyo', locale = 'ja-JP', language = 'zh', liveQuote = null, theme = 'light', costBasis = null }: FxChartProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const smaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const emaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const costLineRef = useRef<IPriceLine | null>(null);
  const previousMarketRef = useRef('');
  const sourceBarsRef = useRef<OhlcBar[]>([]);
  const chartBarsRef = useRef<OhlcBar[]>([]);
  const liveBarRef = useRef<OhlcBar | null>(null);
  const lastAppliedTimeRef = useRef<number | null>(null);
  const [showSma, setShowSma] = useState(true);
  const [showEma, setShowEma] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [displayBar, setDisplayBar] = useState<OhlcBar | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const palette = CHART_THEMES[theme];
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: palette.background }, textColor: palette.textColor, fontFamily: 'Consolas, monospace', fontSize: 12 },
      localization: { locale, timeFormatter: (time: Time) => formatDisplayTime(time, timeZone, locale, timeframe === 'M1') },
      grid: { vertLines: { color: palette.gridVert }, horzLines: { color: palette.gridHorz } },
      crosshair: { vertLine: { color: palette.crosshair, labelBackgroundColor: theme === 'dark' ? '#1f5c40' : '#115d44' }, horzLine: { color: palette.crosshair, labelBackgroundColor: theme === 'dark' ? '#1f5c40' : '#115d44' } },
      rightPriceScale: { borderColor: palette.border },
      timeScale: {
        borderColor: palette.border, timeVisible: true, secondsVisible: timeframe === 'M1',
        tickMarkFormatter: (time: Time, kind: TickMarkType) => formatAxisTime(time, kind, timeZone, locale),
        // Re-renders and quote ticks must not pull a manually inspected view
        // back to the first/last historical bar.
        shiftVisibleRangeOnNewBar: false, rightBarStaysOnScroll: false,
        lockVisibleTimeRangeOnResize: true, fixLeftEdge: true, minBarSpacing: 1.5,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;
    candleRef.current = chart.addSeries(CandlestickSeries, { upColor: palette.up, downColor: palette.down, borderUpColor: palette.up, borderDownColor: palette.down, wickUpColor: palette.up, wickDownColor: palette.down });
    smaRef.current = chart.addSeries(LineSeries, { color: '#b08a43', lineWidth: 2, priceLineVisible: false, visible: true });
    emaRef.current = chart.addSeries(LineSeries, { color: '#4b7d9c', lineWidth: 2, priceLineVisible: false, visible: false });
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; };
  }, [locale, timeZone, timeframe, theme]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: { locale, timeFormatter: (time: Time) => formatDisplayTime(time, timeZone, locale, timeframe === 'M1') },
      timeScale: { secondsVisible: timeframe === 'M1', tickMarkFormatter: (time: Time, kind: TickMarkType) => formatAxisTime(time, kind, timeZone, locale) },
    });
  }, [timeZone, locale, timeframe]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    if (costLineRef.current) {
      candles.removePriceLine(costLineRef.current);
      costLineRef.current = null;
    }
    if (costBasis !== null && Number.isFinite(costBasis) && costBasis > 0) {
      costLineRef.current = candles.createPriceLine({
        price: costBasis,
        color: '#d6a43b',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: language === 'zh' ? '成本' : language === 'ja' ? 'コスト' : 'Cost',
      });
    }
  }, [costBasis, language, theme]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles || bars.length === 0) return;
    // Lightweight Charts only accepts timestamps that are strictly ordered.
    // MT4 history is normally numeric, but normalising here also protects the
    // view if a restarted local bridge returns a serialized timestamp.
    const normalizedBars = bars
      .map(normaliseBar)
      .filter((bar): bar is OhlcBar => bar !== null)
      .sort((left, right) => left.time - right.time)
      .filter((bar, index, rows) => index === 0 || bar.time !== rows[index - 1].time);
    if (normalizedBars.length === 0) return;
    const marketKey = `${symbol}-${timeframe}`;
    const sameMarket = previousMarketRef.current === marketKey;
    const previousRange = sameMarket ? chart.timeScale().getVisibleLogicalRange() : null;
    sourceBarsRef.current = normalizedBars;
    chartBarsRef.current = normalizedBars;
    liveBarRef.current = null;
    lastAppliedTimeRef.current = normalizedBars[normalizedBars.length - 1].time;
    candles.applyOptions({ priceFormat: { type: 'price', precision: decimalsFor(symbol), minMove: symbol.endsWith('/JPY') ? 0.001 : 0.00001 } });
    candles.setData(normalizedBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })) as CandlestickData[]);
    smaRef.current?.setData(simpleMovingAverage(normalizedBars, 20));
    emaRef.current?.setData(exponentialMovingAverage(normalizedBars, 50));
    smaRef.current?.applyOptions({ visible: showSma });
    emaRef.current?.applyOptions({ visible: showEma });
    if (!sameMarket) {
      previousMarketRef.current = marketKey;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, normalizedBars.length - 180), to: normalizedBars.length + 6 });
    } else if (previousRange) {
      const width = previousRange.to - previousRange.from;
      const from = Math.max(0, Math.min(previousRange.from, normalizedBars.length - 1));
      chart.timeScale().setVisibleLogicalRange({ from, to: Math.min(normalizedBars.length + 6, from + width) });
    }
  }, [bars, symbol, timeframe, showSma, showEma]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles || !liveQuote || !Number.isFinite(liveQuote.bid) || !Number.isFinite(liveQuote.ask)) return;
    const interval = TIMEFRAME_SECONDS[timeframe];
    const quoteEpochSeconds = Math.floor(Number(liveQuote.at) / 1000);
    if (!Number.isFinite(quoteEpochSeconds) || quoteEpochSeconds <= 0) return;
    const bucket = Math.floor(quoteEpochSeconds / interval) * interval;
    const price = (liveQuote.bid + liveQuote.ask) / 2;
    const latestSource = sourceBarsRef.current[sourceBarsRef.current.length - 1];
    const previous = liveBarRef.current;
    const seed = previous?.time === bucket
      ? previous
      : latestSource?.time === bucket
        ? latestSource
        : { time: bucket, open: latestSource?.close ?? price, high: latestSource?.close ?? price, low: latestSource?.close ?? price, close: latestSource?.close ?? price };
    const next = { time: bucket, open: seed.open, high: Math.max(seed.high, price), low: Math.min(seed.low, price), close: price };
    liveBarRef.current = next;
    setDisplayBar(next);
    // A history refresh can temporarily be ahead of the PC clock.  Updating
    // an older bar would crash the chart, so keep the live quote visible and
    // wait until its candle becomes the newest chart candle instead.
    const currentChartBars = chartBarsRef.current;
    const lastChartTime = currentChartBars[currentChartBars.length - 1]?.time ?? null;
    const lastAppliedTime = lastAppliedTimeRef.current ?? lastChartTime;
    if ((lastChartTime !== null && bucket < lastChartTime) || (lastAppliedTime !== null && bucket < lastAppliedTime)) return;

    // `update` is fast, but Lightweight Charts rejects any older timestamp.
    // Keep our own strictly ordered buffer and rebuild the series if the
    // library still rejects a tick (for example after a history refresh race).
    const nextChartBars = lastChartTime === bucket
      ? [...currentChartBars.slice(0, -1), next]
      : [...currentChartBars, next];
    try {
      candles.update({ ...next, time: Number(next.time) as UTCTimestamp });
    } catch {
      candles.setData(nextChartBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })) as CandlestickData[]);
    }
    chartBarsRef.current = nextChartBars;
    lastAppliedTimeRef.current = nextChartBars[nextChartBars.length - 1]?.time ?? bucket;
    const completed = sourceBarsRef.current.filter((bar) => bar.time < bucket);
    const tail = [...completed.slice(-19), next];
    if (tail.length >= 20) {
      smaRef.current?.update({ time: next.time as UTCTimestamp, value: tail.reduce((sum, item) => sum + item.close, 0) / tail.length });
    }
  }, [liveQuote, timeframe]);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const toggleFullscreen = async () => {
    if (!shellRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shellRef.current.requestFullscreen();
  };

  const label = (zh: string, ja: string, en: string) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const digits = decimalsFor(symbol);

  return <div className={`chart-shell ${isFullscreen ? 'fullscreen' : ''} ${liveQuote ? 'has-live-quote' : ''}`} ref={shellRef}>
    {liveQuote && <div className="live-quote-strip" aria-live="polite">
      <div><strong>{source === 'mt4' ? 'MT4' : label('本机', 'ローカル', 'Local')}</strong><span>{label('每秒更新', '毎秒更新', '1-second updates')}</span></div>
      <div className="live-quote-prices"><span>Bid {liveQuote.bid.toFixed(digits)}</span><span>Ask {liveQuote.ask.toFixed(digits)}</span></div>
      {displayBar && <div className="live-quote-ohlc">O {displayBar.open.toFixed(digits)} · H {displayBar.high.toFixed(digits)} · L {displayBar.low.toFixed(digits)} · C {displayBar.close.toFixed(digits)}</div>}
    </div>}
    <div className="live-chart">
      <div className="chart-tools">
        <label><input type="checkbox" checked={showSma} onChange={(event) => setShowSma(event.target.checked)} />MA20</label>
        <label><input type="checkbox" checked={showEma} onChange={(event) => setShowEma(event.target.checked)} />EMA50</label>
        <button onClick={toggleFullscreen}>{isFullscreen ? label('退出全屏', '全画面を終了', 'Exit fullscreen') : label('全屏查看', '全画面表示', 'Fullscreen')}</button>
      </div>
      <div className="chart-canvas" ref={containerRef} aria-label={`${symbol} ${source === 'mt4' ? 'MT4 local historical' : source === 'demo' ? 'demo' : 'waiting for calibrated MT4 history'} candlestick chart`} />
      {source === 'unavailable' && <div className="chart-data-empty" role="status"><b>{label('等待已校准的 MT4 历史', '補正済みMT4履歴を待機', 'Waiting for calibrated MT4 history')}</b><span>{label('不会使用演示K线替代真实图表。市场恢复并写入本周期历史后会自动显示。', 'デモ足で実チャートを代替しません。市場再開後、この時間足の履歴が書き込まれると自動表示されます。', 'Demo bars are not substituted for a real chart. It will appear automatically when this timeframe is written by MT4.')}</span></div>}
    </div>
  </div>;
}
