'use client';

import { useMemo } from 'react';
import { inspectHistory } from '../lib/csv-history';
import { findMt4Quote, type Mt4HistoryCoverage, type Mt4HistorySnapshot, type Mt4QuoteSnapshot } from '../lib/mt4-bridge';
import { QUOTES, type PairSymbol, type Timeframe } from '../lib/market-data';

const expectedSeconds: Record<Timeframe, number> = {
  M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2629800, Y1: 31557600,
};

function matchesPeriod(timeframe: Timeframe, seconds: number) {
  if (timeframe === 'MN1') return seconds >= 2_419_200 && seconds <= 2_678_400;
  if (timeframe === 'Y1') return seconds >= 31_536_000 && seconds <= 31_622_400;
  return seconds === expectedSeconds[timeframe];
}

export default function DataHealthPanel({
  language,
  symbol,
  timeframe,
  snapshot,
  history,
  coverage,
  bridgeState,
  displayTimeZone = 'Asia/Tokyo',
}: {
  language: 'zh' | 'ja' | 'en';
  symbol: PairSymbol;
  timeframe: Timeframe;
  snapshot: Mt4QuoteSnapshot | null;
  history: Mt4HistorySnapshot | null;
  coverage: Mt4HistoryCoverage | null;
  bridgeState: 'waiting' | 'live';
  displayTimeZone?: string;
}) {
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const quality = useMemo(() => history ? inspectHistory(history.bars) : null, [history]);
  const historyReady = history !== null && history.timeframe === timeframe && history.bars.length >= 100;
  const date = (time: number) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: displayTimeZone }).format(new Date(time * 1000));
  const age = Math.max(0, Math.round((snapshot?.age_ms ?? 0) / 1000));
  const intervalOk = Boolean(quality && matchesPeriod(timeframe, quality.dominantIntervalSeconds));
  const clock = history?.clock;
  const clockText = !clock ? '—' : clock.status === 'offset-corrected'
    ? t(`已校正 ${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}h`, `${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}時間を補正`, `Adjusted ${clock.history_time_adjustment_seconds >= 0 ? '+' : ''}${Math.round(clock.history_time_adjustment_seconds / 3600)}h`)
    : clock.status === 'aligned' ? t('已对齐', '整合済み', 'Aligned')
      : t('待核对', '要確認', 'Needs check');

  return <section className="data-health-panel" aria-label={t('数据质量中心', 'データ品質センター', 'Data quality centre')}>
    <div className="data-health-heading">
      <div><p className="eyebrow">DATA QUALITY · READ-ONLY</p><h3>{t('数据质量中心', 'データ品質センター', 'Data quality centre')}</h3></div>
      <span className={bridgeState === 'live' ? 'health-live' : 'health-wait'}>{bridgeState === 'live' ? t('本机报价在线', '端末レート接続中', 'Local quotes online') : t('等待 MT4', 'MT4待機', 'Waiting for MT4')}</span>
    </div>
    <div className="health-summary-grid">
      <article><span>{t('当前数据源', '現在のデータソース', 'Current data source')}</span><b className={historyReady ? 'positive' : ''}>{historyReady ? `MT4 ${timeframe}` : t('周期准备中', '時間足を準備中', 'Timeframe preparing')}</b><small>{historyReady ? t('本机历史，只读', '端末内履歴・読取専用', 'Local history, read-only') : t('未就绪时不用于研究结论', '未準備時は研究結論に不使用', 'Not used for research conclusions while not ready')}</small></article>
      <article><span>{t('报价新鲜度', 'レート鮮度', 'Quote freshness')}</span><b className={bridgeState === 'live' && age <= 5 ? 'positive' : ''}>{bridgeState === 'live' ? `${age}s` : '—'}</b><small>{t('只读桥接延迟', '読取ブリッジ遅延', 'Read-only bridge latency')}</small></article>
      <article><span>{t('历史覆盖范围', '履歴カバー範囲', 'History coverage')}</span><b className={historyReady && quality ? 'positive' : ''}>{historyReady && quality ? `${date(quality.firstTime)} → ${date(quality.lastTime)}` : '—'}</b><small>{historyReady ? `${history?.total_bars.toLocaleString()} ${t('根K线', '本', 'candles')}` : t('等待该周期文件', '該当時間足ファイルを待機', 'Waiting for this timeframe file')}</small></article>
      <article><span>{t('周期与缺口', '時間足と欠損', 'Timeframe & gaps')}</span><b className={intervalOk && quality?.gapCount === 0 ? 'positive' : ''}>{historyReady && quality ? `${intervalOk ? timeframe : t('周期不符', '不一致', 'Timeframe mismatch')} · ${quality.gapCount}` : '—'}</b><small>{t('最后数字为发现的缺口数', '末尾の数字は検出した欠損数', 'The last number is the detected gap count')}</small></article>
      <article><span>{t('MT4 时间校准', 'MT4時刻補正', 'MT4 clock calibration')}</span><b className={clock?.status === 'aligned' || clock?.status === 'offset-corrected' ? 'positive' : 'negative'}>{clockText}</b><small>{clock?.status === 'offset-corrected' ? t('以 MT4 服务器与 GMT 差值校正', 'MT4サーバーとGMTの差で補正', 'Calibrated by the MT4 server-to-GMT offset') : t('未对齐时禁止通过验收', '未整合では検収不可', 'Acceptance is blocked while unaligned')}</small></article>
    </div>
    <div className="health-market-grid">
      {QUOTES.map((pair) => {
        const quote = findMt4Quote(snapshot, pair.symbol);
        return <div key={pair.symbol} className={quote ? 'health-pair live' : 'health-pair'}><b>{pair.symbol}</b><span>{quote ? t('报价在线', 'レート在線', 'Quotes online') : t('未接入', '未接続', 'Not connected')}</span></div>;
      })}
    </div>
    <div className="health-timeframe-row" aria-label={t('周期覆盖', '時間足カバー', 'Timeframe coverage')}>
      {(['M1', 'M5', 'M15', 'H1', 'H4', 'D1', 'W1', 'MN1', 'Y1'] as Timeframe[]).map((item) => {
        const itemCoverage = coverage?.coverage.find((entry) => entry.timeframe === item);
        return <span key={item} className={itemCoverage?.ready ? 'ready' : ''}>{item}</span>;
      })}
    </div>
    <p className="health-note">{historyReady && clock?.status !== 'unresolved' && clock?.status !== 'unavailable'
      ? t(`${symbol} 的 ${timeframe} 数据已通过本机来源与周期检查；缺口会保留显示，不能被策略结果忽略。`, `${symbol}の${timeframe}データは端末内ソースと時間足を確認済みです。欠損は表示を残し、戦略結果で無視しません。`, `${symbol} ${timeframe} data passed the local source and timeframe checks; gaps stay visible and cannot be ignored by strategy results.`)
      : t(`${symbol} 的 ${timeframe} 历史或 MT4 时钟尚未通过核对。此时不能作为真实回测样本，也不能进入第一、二阶段验收。`, `${symbol}の${timeframe}履歴またはMT4時刻は未確認です。この間は実データの検証や第1・第2段階の検収には使用しません。`, `${symbol} ${timeframe} history or the MT4 clock has not passed verification yet. It cannot serve as real backtest samples or enter stage-1/2 acceptance.`)}</p>
  </section>;
}
