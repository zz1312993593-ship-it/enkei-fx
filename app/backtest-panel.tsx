'use client';

import { useEffect, useMemo, useState } from 'react';
import EquityChart from './equity-chart';
import { DEFAULT_BACKTEST_CONFIG, runBacktest, runMonteCarlo, type BacktestConfig, type EntryModel } from '../lib/backtest';
import { inspectHistory, parseOhlcCsv } from '../lib/csv-history';
import { buildDemoBars, type OhlcBar, type PairSymbol, type RiskConfig, type Timeframe } from '../lib/market-data';
import { RESEARCH_MODELS, type ResearchModel } from '../lib/model-catalog';

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

interface BacktestPanelProps {
  language: 'zh' | 'ja' | 'en';
  symbol: PairSymbol;
  timeframe: Timeframe;
  risk: RiskConfig;
  bridgeHistory: OhlcBar[] | null;
  bridgeHistoryTotal: number;
  onTimeframeChange: (timeframe: Timeframe) => void;
  displayTimeZone?: string;
  researchModel: ResearchModel;
  onResearchModelChange: (model: ResearchModel) => void;
}

type StrategySettings = Pick<BacktestConfig, 'fastEma' | 'slowEma' | 'breakoutLookback' | 'stopAtr' | 'rewardRisk' | 'maxHoldingBars'>;

const STRATEGY_LIMITS: Record<keyof StrategySettings, { min: number; max: number; step: number }> = {
  fastEma: { min: 2, max: 200, step: 1 }, slowEma: { min: 3, max: 400, step: 1 }, breakoutLookback: { min: 2, max: 250, step: 1 },
  stopAtr: { min: 0.2, max: 10, step: 0.1 }, rewardRisk: { min: 0.2, max: 10, step: 0.1 }, maxHoldingBars: { min: 2, max: 2000, step: 1 },
};

function settingsForProfile(profile: number): StrategySettings {
  const weight = Math.min(1, Math.max(0, profile / 100));
  const interpolate = (steady: number, flexible: number, decimals = 0) => {
    const value = steady + (flexible - steady) * weight;
    return decimals ? Number(value.toFixed(decimals)) : Math.round(value);
  };
  return {
    fastEma: interpolate(22, 6), slowEma: interpolate(58, 18), breakoutLookback: interpolate(32, 8),
    stopAtr: interpolate(2.4, 1.0, 1), rewardRisk: interpolate(1.5, 2.9, 1), maxHoldingBars: interpolate(72, 16),
  };
}

const BASELINE_PROFILE = 50;

const STRATEGY_MODELS = RESEARCH_MODELS.map((model) => ({ id: model.id, zh: model.zh, ja: model.ja, en: model.en, zhDetail: model.logicZh, jaDetail: model.logicJa, enDetail: model.logicEn }));

const SIMULATION_CANDIDATES: Array<{ id: string; model: EntryModel; profile: number; zh: string; ja: string; en: string; zhNote: string; jaNote: string; enNote: string }> = [
  { id: 'breakout-profile-50', model: 'trend-breakout', profile: 50, zh: '候选 A · 趋势突破', ja: '候補 A · トレンド・ブレイク', en: 'Candidate A · Trend breakout', zhNote: '风险谱位于 50；趋势延续时，收盘突破区间后才研究入场。', jaNote: 'リスクスペクトラム50。トレンド継続時にレンジを終値で抜けた後のみ検証します。', enNote: 'Risk spectrum 50; during trend continuation, entries are studied only after a close breaks the range.' },
  { id: 'cross-profile-25', model: 'ema-cross', profile: 25, zh: '候选 B · 均线交叉', ja: '候補 B · 移動平均クロス', en: 'Candidate B · Moving-average cross', zhNote: '风险谱位于 25；较低频率，观察均线交叉下的趋势转换。', jaNote: 'リスクスペクトラム25。頻度を抑え、移動平均クロスで転換を観測します。', enNote: 'Risk spectrum 25; lower-frequency trend transitions are observed through moving-average crosses.' },
  { id: 'pullback-profile-75', model: 'trend-pullback', profile: 75, zh: '候选 C · 趋势回踩', ja: '候補 C · トレンド押し目', en: 'Candidate C · Trend pullback', zhNote: '风险谱位于 75；趋势方向内的回踩确认，交易频率相对更高。', jaNote: 'リスクスペクトラム75。トレンド方向内の押し目を確認し、比較的頻度を高めます。', enNote: 'Risk spectrum 75; confirms pullbacks in the trend direction at a relatively higher frequency.' },
];

function toTimeZoneInput(seconds: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(seconds * 1000));
  const part = (kind: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === kind)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function fromTimeZoneInput(value: string, timeZone: string) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const desiredUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let epoch = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epoch));
    const valueFor = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === kind)?.value ?? 0);
    const zonedUtc = Date.UTC(valueFor('year'), valueFor('month') - 1, valueFor('day'), valueFor('hour'), valueFor('minute'));
    epoch += desiredUtc - zonedUtc;
  }
  return Math.floor(epoch / 1000);
}

export default function BacktestPanel({ language, symbol, timeframe, risk, bridgeHistory, bridgeHistoryTotal, onTimeframeChange, displayTimeZone = 'Asia/Tokyo', researchModel, onResearchModelChange }: BacktestPanelProps) {
  const [sampleSize, setSampleSize] = useState(900);
  const [spreadPips, setSpreadPips] = useState(risk.maxSpreadPips > 1.5 ? 0.8 : risk.maxSpreadPips);
  const [uploadedBars, setUploadedBars] = useState<OhlcBar[] | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadNotice, setUploadNotice] = useState('');
  const [riskProfile, setRiskProfile] = useState(BASELINE_PROFILE);
  const [strategyMode, setStrategyMode] = useState<'spectrum' | 'custom'>('spectrum');
  const [strategy, setStrategy] = useState<StrategySettings>(() => settingsForProfile(BASELINE_PROFILE));
  // 批I：交易管理开关（源自 MQL5 生态标准做法；缺省关闭，行为与旧版完全一致）
  const [breakevenEnabled, setBreakevenEnabled] = useState(false);
  const [breakevenR, setBreakevenR] = useState(1);
  const [trailingEnabled, setTrailingEnabled] = useState(false);
  const [trailingMult, setTrailingMult] = useState(1);
  const [partialEnabled, setPartialEnabled] = useState(false);
  const [partialR, setPartialR] = useState(1);
  const [partialFraction, setPartialFraction] = useState(0.5);
  const [lossStreakEnabled, setLossStreakEnabled] = useState(false);
  const [lossStreakCount, setLossStreakCount] = useState(3);
  const [lossStreakPause, setLossStreakPause] = useState(24);
  const entryModel: EntryModel = researchModel;
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [useFullHistory, setUseFullHistory] = useState(false);
  const [candidateNotes, setCandidateNotes] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(window.localStorage.getItem('enkei-candidate-notes') ?? '{}') as Record<string, string>; } catch { return {}; }
  });
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const demoBars = useMemo(() => buildDemoBars(symbol, timeframe, sampleSize), [symbol, timeframe, sampleSize]);
  const hasBridgeHistory = bridgeHistory !== null && bridgeHistory.length >= 100;
  const sourceBars = uploadedBars ?? (hasBridgeHistory ? bridgeHistory : null);
  const allBars = sourceBars ?? demoBars;
  const firstAvailableTime = allBars[0]?.time ?? 0;
  const lastAvailableTime = allBars.at(-1)?.time ?? 0;
  const startEpoch = fromTimeZoneInput(rangeStart, displayTimeZone);
  const endEpoch = fromTimeZoneInput(rangeEnd, displayTimeZone);
  const bars = useMemo(() => {
    const filtered = allBars.filter((bar) => (startEpoch === null || bar.time >= startEpoch) && (endEpoch === null || bar.time <= endEpoch));
    // 分钟线默认使用用户选择的研究样本，避免一次交互同步重复运行
    // 十余次全量回测。用户仍可通过“使用全部”显式运行全历史。
    return !useFullHistory && startEpoch === null && endEpoch === null ? filtered.slice(-sampleSize) : filtered;
  }, [allBars, endEpoch, sampleSize, startEpoch, useFullHistory]);
  const quality = useMemo(() => sourceBars ? inspectHistory(sourceBars) : null, [sourceBars]);
  const result = useMemo(() => runBacktest(bars, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...strategy,
    entryModel,
    symbol,
    timeframe,
    riskPerTradePct: risk.riskPerTradePct,
    spreadPips,
    ...(breakevenEnabled ? { breakEvenTriggerR: breakevenR } : {}),
    ...(trailingEnabled ? { trailingStopAtrMult: trailingMult } : {}),
    ...(partialEnabled ? { takePartialAtR: partialR, partialCloseFraction: partialFraction } : {}),
    ...(lossStreakEnabled ? { pauseAfterLosses: { losses: lossStreakCount, pauseBars: lossStreakPause } } : {}),
  }), [bars, risk.riskPerTradePct, spreadPips, strategy, entryModel, symbol, timeframe, breakevenEnabled, breakevenR, trailingEnabled, trailingMult, partialEnabled, partialR, partialFraction, lossStreakEnabled, lossStreakCount, lossStreakPause]);
  const monteCarlo = useMemo(() => runMonteCarlo(result.trades.map((trade) => trade.rMultiple), {
    riskPerTradePct: risk.riskPerTradePct,
    runs: 500,
    seed: 20260906,
  }), [result, risk.riskPerTradePct]);
  const baselineResult = useMemo(() => runBacktest(bars, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...settingsForProfile(BASELINE_PROFILE),
    entryModel,
    symbol,
    timeframe,
    riskPerTradePct: risk.riskPerTradePct,
    spreadPips,
  }), [bars, risk.riskPerTradePct, spreadPips, entryModel, symbol, timeframe]);
  const validationStartIndex = Math.floor(bars.length * 0.7);
  const validationResult = useMemo(() => sourceBars && bars.length >= 300 ? runBacktest(bars, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...strategy,
    entryModel,
    symbol,
    timeframe,
    riskPerTradePct: risk.riskPerTradePct,
    spreadPips,
    startIndex: validationStartIndex,
  }) : null, [bars, risk.riskPerTradePct, spreadPips, strategy, entryModel, symbol, timeframe, sourceBars, validationStartIndex]);
  const rollingResults = useMemo(() => {
    if (!sourceBars || bars.length < 600) return [];
    const windowSize = Math.floor(bars.length * 0.2);
    return [0.4, 0.6, 0.8].map((startRatio) => {
      const start = Math.floor(bars.length * startRatio);
      const segment = bars.slice(start, Math.min(bars.length, start + windowSize));
      return runBacktest(segment, { ...DEFAULT_BACKTEST_CONFIG, ...strategy, entryModel, symbol, timeframe, riskPerTradePct: risk.riskPerTradePct, spreadPips });
    });
  }, [bars, sourceBars, strategy, entryModel, symbol, timeframe, risk.riskPerTradePct, spreadPips]);
  const simulationTrials = useMemo(() => SIMULATION_CANDIDATES.map((candidate) => {
    const configuration = { ...DEFAULT_BACKTEST_CONFIG, ...settingsForProfile(candidate.profile), entryModel: candidate.model, symbol, timeframe, riskPerTradePct: risk.riskPerTradePct, spreadPips };
    const full = runBacktest(bars, configuration);
    const outOfSample = sourceBars && bars.length >= 300 ? runBacktest(bars, { ...configuration, startIndex: Math.floor(bars.length * 0.7) }) : null;
    const researchScore = outOfSample ? outOfSample.netReturnPct - outOfSample.maxDrawdownPct * 0.5 : null;
    return { candidate, full, outOfSample, researchScore };
  }).sort((left, right) => (right.researchScore ?? -Infinity) - (left.researchScore ?? -Infinity)), [bars, sourceBars, symbol, timeframe, risk.riskPerTradePct, spreadPips]);
  useEffect(() => { window.localStorage.setItem('enkei-candidate-notes', JSON.stringify(candidateNotes)); }, [candidateNotes]);
  const locale = language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US';
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });
  const date = (value: number) => new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone, hourCycle: 'h23' }).format(new Date(value * 1000));
  const profitFactor = Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : '∞';
  const dateOnly = (value: number) => new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: displayTimeZone }).format(new Date(value * 1000));
  const intervalLabel = (seconds: number) => seconds % 3600 === 0 ? `H${seconds / 3600}` : `M${seconds / 60}`;
  const expectedSeconds: Record<Timeframe, number> = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2629800, Y1: 31557600 };
  const dataMatchesTimeframe = Boolean(quality && (
    timeframe === 'MN1' ? quality.dominantIntervalSeconds >= 2_419_200 && quality.dominantIntervalSeconds <= 2_678_400
      : timeframe === 'Y1' ? quality.dominantIntervalSeconds >= 31_536_000 && quality.dominantIntervalSeconds <= 31_622_400
        : quality.dominantIntervalSeconds === expectedSeconds[timeframe]
  ));
  const hasEnoughData = bars.length >= 300;
  const hasMeaningfulOosTrades = Boolean(validationResult && validationResult.totalTrades >= 8);

  const exportReport = () => {
    downloadJson(`enkei-backtest-${symbol.replace('/', '')}-${timeframe}.json`, {
      reportType: 'research-only-backtest', symbol, timeframe,
      dataSource: uploadedBars ? 'local-csv' : hasBridgeHistory ? `mt4-local-${timeframe.toLowerCase()}-history` : 'deterministic-demo', fileName: uploadName || null,
      dataQuality: quality,
      configuration: { riskPerTradePct: risk.riskPerTradePct, spreadPips, slippagePips: DEFAULT_BACKTEST_CONFIG.slippagePips, riskProfile, strategyMode, entryModel, ...strategy },
      fullSample: result, outOfSample: validationResult, rollingWindows: rollingResults,
      disclaimer: 'Research report only. It does not constitute a trading signal, a broker order, or proof of future performance.',
    });
  };

  const updateRiskProfile = (value: number) => {
    const next = Math.max(0, Math.min(100, value));
    setRiskProfile(next);
    setStrategy(settingsForProfile(next));
    setStrategyMode('spectrum');
  };

  const recommendRange = () => {
    const recommendedStart = allBars[Math.max(0, allBars.length - sampleSize)]?.time ?? firstAvailableTime;
    setUseFullHistory(false); setRangeStart(toTimeZoneInput(recommendedStart, displayTimeZone));
    setRangeEnd(toTimeZoneInput(lastAvailableTime, displayTimeZone));
  };

  const updateStrategy = <K extends keyof StrategySettings>(key: K, value: StrategySettings[K]) => {
    setStrategyMode('custom');
    const limit = STRATEGY_LIMITS[key];
    const safeValue = Math.min(limit.max, Math.max(limit.min, Number.isFinite(value) ? value : limit.min)) as StrategySettings[K];
    setStrategy((current) => {
      const next = { ...current, [key]: safeValue };
      if (key === 'fastEma' && next.slowEma <= next.fastEma) next.slowEma = next.fastEma + 1;
      if (key === 'slowEma' && next.fastEma >= next.slowEma) next.fastEma = Math.max(STRATEGY_LIMITS.fastEma.min, next.slowEma - 1);
      return next;
    });
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseOhlcCsv(await file.text());
    if (parsed.bars.length < 100) {
      setUploadNotice(t('未读取到至少100根有效K线。请确认文件包含日期、时间、开高低收。', '有効なローソク足を100本以上読み取れませんでした。日付・時刻・始値・高値・安値・終値を確認してください。', 'Fewer than 100 valid candles were read. Check that the file contains date, time and OHLC columns.'));
      return;
    }
    setUploadedBars(parsed.bars);
    setUploadName(file.name);
    const discarded = parsed.skippedRows + parsed.duplicateRows;
    setUploadNotice(t(`已在本机读取 ${parsed.bars.length.toLocaleString()} 根K线${discarded ? `；忽略 ${discarded} 行无效或重复数据` : ''}。`, `${parsed.bars.length.toLocaleString()}本の足を端末内で読み込みました${discarded ? `（無効・重複 ${discarded}行を除外）` : ''}。`, `Read ${parsed.bars.length.toLocaleString()} candles locally${discarded ? `; skipped ${discarded} invalid or duplicate rows` : ''}.`));
  };

  return (
    <section className="phase-panel backtest-panel">
      <div className="phase-heading">
        <div><p className="eyebrow">WALK-FORWARD READY ENGINE</p><h3>{t('策略回测', 'ストラテジー検証', 'Strategy backtest')} <span>{symbol} · {timeframe}</span></h3></div>
        <div className="backtest-actions"><span className="demo-badge">{t('成本已计入', 'コスト反映済み', 'Costs included')}</span><button className="report-export" onClick={exportReport}>{t('导出报告', 'レポート出力', 'Export report')}</button></div>
      </div>

      <div className="research-warning"><b>{uploadedBars ? t('本地历史数据', 'ローカル履歴データ', 'Local history data') : hasBridgeHistory ? t('MT4 本机历史数据', 'MT4端末内履歴データ', 'MT4 local history data') : t('研究数据', '研究用データ', 'Research data')}</b><span>{uploadedBars ? t('当前结果来自你本机导入的CSV；不会上传。请确认货币对与周期一致。', '現在の結果は端末内で読み込んだCSVによるものです。アップロードはされません。通貨ペアと時間足を確認してください。', 'These results come from the CSV you imported locally; nothing is uploaded. Confirm the pair and timeframe match.') : hasBridgeHistory ? t(`当前结果来自 MT4 只读导出的 ${timeframe} 历史（共 ${bridgeHistoryTotal.toLocaleString()} 根）；不含任何下单接口。`, `現在の結果はMT4読取専用の${timeframe}履歴（全${bridgeHistoryTotal.toLocaleString()}本）によるものです。注文機能は含みません。`, `These results come from the MT4 read-only ${timeframe} export (${bridgeHistoryTotal.toLocaleString()} candles); it contains no order interface.`) : t('当前使用确定性的演示分钟序列，用于验证计算流程，不代表历史收益。导入MT4历史CSV后将替换为你的本地数据。', '現在は計算手順を検証するための決定論的デモ系列です。過去の収益を示すものではなく、MT4履歴CSVを読み込むと端末内データに置き換わります。', 'A deterministic demo minute series is used to validate the calculation flow; it does not represent historical returns. Import an MT4 history CSV to replace it with your local data.')}</span></div>

      <div className="csv-import">
        <div><b>{t('导入 MT4 历史 CSV', 'MT4履歴CSVを読み込む', 'Import MT4 history CSV')}</b><span>{t('支持 Date, Time, Open, High, Low, Close 格式；仅在本机处理。', 'Date, Time, Open, High, Low, Close 形式に対応。端末内のみで処理します。', 'Supports Date, Time, Open, High, Low, Close; processed locally only.')}</span></div>
        <label className="csv-upload"><input type="file" accept=".csv,text/csv" onChange={(event) => importCsv(event.target.files?.[0])} />{t('选择 CSV', 'CSVを選択', 'Choose CSV')}</label>
        {uploadedBars && <button className="csv-clear" onClick={() => { setUploadedBars(null); setUploadName(''); setUploadNotice(t('已切回演示数据。', 'デモデータに戻しました。', 'Switched back to demo data.')); }}>{t('移除数据', 'データを外す', 'Remove data')}</button>}
      </div>
      <div className="research-timeframe"><div><b>{t('回测K线周期', '検証時間足', 'Backtest timeframe')}</b><span>{t('分钟级数据天然覆盖较短；若要研究数月或多年，请直接切换 H1、H4、D1、W1 或 MN1。', '分足データの期間は本質的に短いため、数か月・数年を研究する場合はH1、H4、D1、W1またはMN1へ切り替えてください。', 'Minute data covers only short spans by nature; to study months or years, switch directly to H1, H4, D1, W1 or MN1.')}</span></div><select value={timeframe} onChange={(event) => { setUseFullHistory(false); setRangeStart(''); setRangeEnd(''); onTimeframeChange(event.target.value as Timeframe); }} aria-label={t('回测K线周期', '検証時間足', 'Backtest timeframe')}>{(['M1', 'M5', 'M15', 'H1', 'H4', 'D1', 'W1', 'MN1', 'Y1'] as Timeframe[]).map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
      {(uploadName || uploadNotice) && <p className="csv-notice">{uploadName && <b>{uploadName} · </b>}{uploadNotice}</p>}
      <section className="research-range">
        <div><p className="eyebrow">{language === 'zh' ? `研究范围 · ${displayTimeZone === 'Asia/Tokyo' ? 'JST' : displayTimeZone === 'America/New_York' ? 'ET' : displayTimeZone === 'Europe/London' ? 'UK' : 'CST'}` : language === 'ja' ? `研究期間 · ${displayTimeZone === 'Asia/Tokyo' ? 'JST' : displayTimeZone === 'America/New_York' ? 'ET' : displayTimeZone === 'Europe/London' ? 'UK' : 'CST'}` : `RESEARCH WINDOW · ${displayTimeZone === 'Asia/Tokyo' ? 'JST' : displayTimeZone === 'America/New_York' ? 'ET' : displayTimeZone === 'Europe/London' ? 'UK' : 'CST'}`}</p><b>{t('研究时间范围', '研究期間', 'Research time range')}</b><span>{t(`可自行决定开始和结束时间；留空即使用全部可用数据。当前可用范围：${firstAvailableTime ? dateOnly(firstAvailableTime) : '—'} → ${lastAvailableTime ? dateOnly(lastAvailableTime) : '—'}。`, `開始・終了時刻は自由に設定できます。空欄では利用可能な全データを使います。現在の利用可能範囲：${firstAvailableTime ? dateOnly(firstAvailableTime) : '—'} → ${lastAvailableTime ? dateOnly(lastAvailableTime) : '—'}。`, `Choose any start and end time; leave blank to use all available data. Available range: ${firstAvailableTime ? dateOnly(firstAvailableTime) : '—'} → ${lastAvailableTime ? dateOnly(lastAvailableTime) : '—'}.`)}</span></div>
        <div className="research-range-controls"><label><span>{t(`开始（${displayTimeZone === 'Asia/Tokyo' ? '日本时间' : displayTimeZone === 'America/New_York' ? '美国东部时间' : displayTimeZone === 'Europe/London' ? '英国时间' : '中国时间'}）`, `開始（${displayTimeZone === 'Asia/Tokyo' ? '日本時間' : displayTimeZone === 'America/New_York' ? '米国東部時間' : displayTimeZone === 'Europe/London' ? '英国時間' : '中国時間'}）`, `Start (${displayTimeZone === 'Asia/Tokyo' ? 'Japan' : displayTimeZone === 'America/New_York' ? 'US Eastern' : displayTimeZone === 'Europe/London' ? 'UK' : 'China'} time)`)}</span><input type="datetime-local" min={firstAvailableTime ? toTimeZoneInput(firstAvailableTime, displayTimeZone) : undefined} max={lastAvailableTime ? toTimeZoneInput(lastAvailableTime, displayTimeZone) : undefined} value={rangeStart} onChange={(event) => { setUseFullHistory(false); setRangeStart(event.target.value); }} /></label><label><span>{t(`结束（${displayTimeZone === 'Asia/Tokyo' ? '日本时间' : displayTimeZone === 'America/New_York' ? '美国东部时间' : displayTimeZone === 'Europe/London' ? '英国时间' : '中国时间'}）`, `終了（${displayTimeZone === 'Asia/Tokyo' ? '日本時間' : displayTimeZone === 'America/New_York' ? '米国東部時間' : displayTimeZone === 'Europe/London' ? '英国時間' : '中国時間'}）`, `End (${displayTimeZone === 'Asia/Tokyo' ? 'Japan' : displayTimeZone === 'America/New_York' ? 'US Eastern' : displayTimeZone === 'Europe/London' ? 'UK' : 'China'} time)`)}</span><input type="datetime-local" min={firstAvailableTime ? toTimeZoneInput(firstAvailableTime, displayTimeZone) : undefined} max={lastAvailableTime ? toTimeZoneInput(lastAvailableTime, displayTimeZone) : undefined} value={rangeEnd} onChange={(event) => { setUseFullHistory(false); setRangeEnd(event.target.value); }} /></label><button onClick={recommendRange}>{t('按样本数建议', 'サンプル数で提案', 'suggest by sample size')}</button><button className="plain" onClick={() => { setUseFullHistory(true); setRangeStart(''); setRangeEnd(''); }}>{t('使用全部', '全期間を使用', 'use all data')}</button></div>
        <small>{t(`当前筛选后：${bars.length.toLocaleString()} 根K线。若不足以完成策略预热，将明确显示没有交易，而不会伪造结果。`, `現在の絞り込み後：${bars.length.toLocaleString()}本。戦略の準備期間に不足する場合は取引なしと明示し、結果を作りません。`, `After filtering: ${bars.length.toLocaleString()} candles. If too few to warm up the strategy, no trades is shown explicitly instead of fabricating results.`)}</small>
      </section>
      {sourceBars && quality && <div className="quality-grid">
        <article><span>{t('数据期间', 'データ期間', 'Data period')}</span><b>{dateOnly(quality.firstTime)} → {dateOnly(quality.lastTime)}</b></article>
        <article><span>{t('识别周期', '検出時間足', 'Detected timeframe')}</span><b className={quality.dominantIntervalSeconds === expectedSeconds[timeframe] ? 'positive' : 'negative'}>{intervalLabel(quality.dominantIntervalSeconds)} {quality.dominantIntervalSeconds === expectedSeconds[timeframe] ? '✓' : `≠ ${timeframe}`}</b></article>
        <article><span>{t('数据缺口', 'データ欠損', 'Data gaps')}</span><b className={quality.gapCount === 0 ? 'positive' : 'negative'}>{quality.gapCount === 0 ? t('未发现', 'なし', 'None found') : `${quality.gapCount} ${t('处', '件', 'gaps')}`}</b></article>
      </div>}
      {sourceBars && <div className="validation-panel">
        <div><p className="eyebrow">CHRONOLOGICAL HOLDOUT · 70 / 30</p><b>{t('样本外验证', 'アウトオブサンプル検証', 'Out-of-sample validation')}</b><span>{t('前70%用于研究，后30%仅用于验证；不在此页面进行参数优化。', '前半70%を研究、後半30%を検証に使用します。この画面ではパラメーター最適化を行いません。', 'First 70% for research, last 30% for validation only; no parameter optimisation happens on this page.')}</span></div>
        {validationResult ? <div className="validation-metrics">
          <p><span>{t('样本外净收益', 'OOS純収益', 'Out-of-sample net return')}</span><b className={validationResult.netReturnPct >= 0 ? 'positive' : 'negative'}>{validationResult.netReturnPct >= 0 ? '+' : ''}{validationResult.netReturnPct.toFixed(2)}%</b></p>
          <p><span>{t('最大回撤', '最大DD', 'Max drawdown')}</span><b>{validationResult.maxDrawdownPct.toFixed(2)}%</b></p>
          <p><span>{t('交易数', '取引数', 'Trades')}</span><b>{validationResult.totalTrades}</b></p>
          <p><span>{t('盈亏因子', 'PF', 'Profit factor')}</span><b>{Number.isFinite(validationResult.profitFactor) ? validationResult.profitFactor.toFixed(2) : '∞'}</b></p>
        </div> : <p className="validation-empty">{t('需要至少300根已导入K线，才会显示样本外结果。', 'アウトオブサンプル結果の表示には、読み込み済みの足が300本以上必要です。', 'Out-of-sample results appear only with at least 300 imported candles.')}</p>}
      </div>}
      <section className="rolling-panel">
        <div><p className="eyebrow">ROLLING HOLDOUT · THREE WINDOWS</p><b>{t('滚动样本外验证', 'ローリングOOS検証', 'Rolling out-of-sample validation')}</b><span>{t('把真实历史按三个独立后段分别计算；它不是参数优化，也不会隐藏表现较差的窗口。', '実データの後半を3つの独立区間で計算します。最適化ではなく、成績の弱い区間も隠しません。', 'Real history is computed over three independent tail segments; this is not parameter optimisation and never hides weaker windows.')}</span></div>
        {rollingResults.length === 3 ? <div className="rolling-results">
          {rollingResults.map((item, index) => <p key={index}><span>{t(`窗口 ${index + 1}`, `区間 ${index + 1}`, `Window ${index + 1}`)}</span><b className={item.netReturnPct >= 0 ? 'positive' : 'negative'}>{item.netReturnPct >= 0 ? '+' : ''}{item.netReturnPct.toFixed(2)}%</b><small>{item.totalTrades} {t('笔', '件', 'trades')} · DD {item.maxDrawdownPct.toFixed(2)}%</small></p>)}
        </div> : <p className="validation-empty">{t('需要至少600根本机历史K线，才会显示三个滚动窗口。', '3つのローリング区間の表示には、端末内履歴が600本以上必要です。', 'Three rolling windows appear only with at least 600 local history candles.')}</p>}
      </section>
      <div className="research-gate">
        <div><p className="eyebrow">RESEARCH GATE · NOT AN ORDER APPROVAL</p><b>{t('研究验证闸门', '研究検証ゲート', 'Research validation gate')}</b><span>{t('仅用于判断数据和样本是否足以继续研究；即使全部通过，也不代表可以进行真实交易。', 'データとサンプルが研究継続に足りるかを確認するだけです。全て通過しても実取引を許可するものではありません。', 'Only judges whether data and samples suffice to continue research; passing every gate never means live trading is allowed.')}</span></div>
        <ul>
          <li className={sourceBars ? 'pass' : 'pending'}><i>{sourceBars ? '✓' : '—'}</i>{t('使用本地历史数据', 'ローカル履歴データを使用', 'Uses local history data')}</li>
          <li className={hasEnoughData ? 'pass' : 'pending'}><i>{hasEnoughData ? '✓' : '—'}</i>{t('至少300根K线', '足が300本以上', 'At least 300 candles')}</li>
          <li className={dataMatchesTimeframe ? 'pass' : 'pending'}><i>{dataMatchesTimeframe ? '✓' : '—'}</i>{t('数据周期与页面一致', 'データ時間足が画面と一致', 'Data timeframe matches the page')}</li>
          <li className={hasMeaningfulOosTrades ? 'pass' : 'pending'}><i>{hasMeaningfulOosTrades ? '✓' : '—'}</i>{t('样本外至少8笔交易', 'OOS取引が8件以上', 'At least 8 out-of-sample trades')}</li>
          <li className={rollingResults.length === 3 ? 'pass' : 'pending'}><i>{rollingResults.length === 3 ? '✓' : '—'}</i>{t('三个滚动窗口已计算', '3つのローリング区間を計算', 'Three rolling windows computed')}</li>
        </ul>
      </div>
      <section className="strategy-models">
        <div><p className="eyebrow">FIXED STRATEGY LIBRARY · RESEARCH ONLY</p><h4>{t('固定策略库', '固定ストラテジーライブラリ', 'Fixed strategy library')}</h4><span>{t('只可选择预先定义的逻辑；不会根据当前结果自动挑选“赢家”。', '事前定義したロジックのみ選択できます。現在の結果から「勝者」を自動選択しません。', 'You can only pick pre-defined logic; “winners” are never auto-selected from current results.')}</span></div>
        <div className="strategy-model-grid">{STRATEGY_MODELS.map((model) => <button key={model.id} className={entryModel === model.id ? 'active' : ''} onClick={() => onResearchModelChange(model.id)}><b>{t(model.zh, model.ja, model.en)}</b><span>{t(model.zhDetail, model.jaDetail, model.enDetail)}</span><small>{entryModel === model.id ? t('当前研究模型', '現在の研究モデル', 'Current research model') : t('点击切换研究模型', 'クリックして研究モデルを切替', 'Click to switch research model')}</small></button>)}</div>
      </section>
      <section className="strategy-lab">
        <div className="strategy-lab-heading"><div><p className="eyebrow">STRATEGY LAB · RESEARCH ONLY</p><h4>{t('策略实验室', 'ストラテジーラボ', 'Strategy lab')}</h4><span>{t('拖动风险谱可连续改变研究参数；仍可单独编辑每项参数。它只影响本机回测和内部模拟，不会发送任何订单。', 'リスクスペクトラムを動かすと研究パラメーターが連続的に変化します。各項目の個別編集もできます。端末内の検証と内部ペーパーのみが対象で、注文は送信されません。', 'Dragging the risk spectrum changes research parameters continuously; each parameter stays individually editable. It only affects local backtests and internal simulation and never sends orders.')}</span></div></div>
        <div className="strategy-spectrum">
          <div><span>{t('稳健 / 低频', '安定 / 低頻度', 'Steady / low-frequency')}</span><b>{t('风险谱', 'リスクスペクトラム', 'Risk spectrum')} {riskProfile}/100</b><span>{t('灵活 / 高频', '柔軟 / 高頻度', 'Agile / high-frequency')}</span></div>
          <input type="range" min="0" max="100" step="1" value={riskProfile} onChange={(event) => updateRiskProfile(Number(event.target.value))} aria-label={t('策略风险谱', '戦略リスクスペクトラム', 'Strategy risk spectrum')} />
          <p>{strategyMode === 'custom' ? t('已改为自定义参数；再次拖动风险谱会用连续模型重新填充这些参数。', '個別パラメーターを編集しました。スペクトラムを再度動かすと連続モデルで再設定されます。', 'Custom parameters are set; dragging the spectrum again refills them from the continuous model.') : t('滑块位置会同时调整 EMA、突破回看、ATR 止损、目标 R 与最长持仓。', 'スライダー位置はEMA、ブレイクアウト期間、ATRストップ、利確R、最大保有足を同時に調整します。', 'The slider adjusts EMA, breakout lookback, ATR stop, target R and max holding at once.')}</p>
        </div>
        <div className="strategy-controls">
          <label><span>Fast EMA</span><input type="number" min={2} max={200} step={1} value={strategy.fastEma} onChange={(event) => updateStrategy('fastEma', Number(event.target.value))} /></label>
          <label><span>Slow EMA</span><input type="number" min={3} max={400} step={1} value={strategy.slowEma} onChange={(event) => updateStrategy('slowEma', Number(event.target.value))} /></label>
          <label><span>{t('突破回看', 'ブレイクアウト', 'Breakout lookback')}</span><input type="number" min={2} max={250} step={1} value={strategy.breakoutLookback} onChange={(event) => updateStrategy('breakoutLookback', Number(event.target.value))} /></label>
          <label><span>{t('止损 ATR', 'ストップ ATR', 'Stop ATR')}</span><input type="number" min={0.2} max={10} step={0.1} value={strategy.stopAtr} onChange={(event) => updateStrategy('stopAtr', Number(event.target.value))} /></label>
          <label><span>{t('目标 R', '利確 R', 'Target R')}</span><input type="number" min={0.2} max={10} step={0.1} value={strategy.rewardRisk} onChange={(event) => updateStrategy('rewardRisk', Number(event.target.value))} /></label>
          <label><span>{t('最长持仓', '最大保有足', 'Max holding')}</span><input type="number" min={2} max={2000} step={1} value={strategy.maxHoldingBars} onChange={(event) => updateStrategy('maxHoldingBars', Number(event.target.value))} /></label>
          <label><span>{t('保本移损（研究）', 'ブレークイーブン（研究）', 'Breakeven (research)')}</span><span className="management-toggle"><input type="checkbox" checked={breakevenEnabled} onChange={(event) => setBreakevenEnabled(event.target.checked)} aria-label={t('启用保本移损', 'ブレークイーブンを有効化', 'Enable breakeven')} />{t('浮盈达', '浮益が', 'move stop at')} <input type="number" min={0.2} max={5} step={0.1} value={breakevenR} disabled={!breakevenEnabled} onChange={(event) => setBreakevenR(Number(event.target.value))} aria-label={t('保本触发 R 倍数', 'ブレークイーブンR', 'breakeven trigger R')} /> R</span></label>
          <label><span>{t('ATR 跟踪止损（研究）', 'ATRトレイル（研究）', 'ATR trailing (research)')}</span><span className="management-toggle"><input type="checkbox" checked={trailingEnabled} onChange={(event) => setTrailingEnabled(event.target.checked)} aria-label={t('启用跟踪止损', 'トレイルを有効化', 'Enable trailing')} />{t('倍数', '倍率', 'mult.')} <input type="number" min={0.2} max={6} step={0.1} value={trailingMult} disabled={!trailingEnabled} onChange={(event) => setTrailingMult(Number(event.target.value))} aria-label={t('跟踪 ATR 倍数', 'トレイルATR倍率', 'trailing ATR multiple')} /></span></label>
          <label><span>{t('部分平仓（研究）', '部分決済（研究）', 'Partial close (research)')}</span><span className="management-toggle"><input type="checkbox" checked={partialEnabled} onChange={(event) => setPartialEnabled(event.target.checked)} aria-label={t('启用部分平仓', '部分決済を有効化', 'Enable partial close')} />{t('达', '達', 'at')} <input type="number" min={0.2} max={5} step={0.1} value={partialR} disabled={!partialEnabled} onChange={(event) => setPartialR(Number(event.target.value))} aria-label={t('部分平仓触发 R 倍数', '部分決済R', 'partial trigger R')} /> R {t('了结', '決済', 'close')} <input type="number" min={10} max={90} step={5} value={Math.round(partialFraction * 100)} disabled={!partialEnabled} onChange={(event) => setPartialFraction(Number(event.target.value) / 100)} aria-label={t('部分平仓比例', '部分決済割合', 'partial fraction')} /> %</span></label>
          <label><span>{t('连续止损保护（研究）', '連続損切り保護（研究）', 'Loss-streak guard (research)')}</span><span className="management-toggle"><input type="checkbox" checked={lossStreakEnabled} onChange={(event) => setLossStreakEnabled(event.target.checked)} aria-label={t('启用连续止损保护', '連続損切り保護を有効化', 'Enable loss-streak guard')} /><input type="number" min={2} max={10} step={1} value={lossStreakCount} disabled={!lossStreakEnabled} onChange={(event) => setLossStreakCount(Number(event.target.value))} aria-label={t('连续亏损笔数', '連続損切り回数', 'consecutive losses')} /> {t('笔亏损后暂停', '件の損失後一時停止', 'losses then pause')} <input type="number" min={4} max={200} step={1} value={lossStreakPause} disabled={!lossStreakEnabled} onChange={(event) => setLossStreakPause(Number(event.target.value))} aria-label={t('暂停K线数', '一時停止の足数', 'pause bars')} /> {t('根', '本', 'bars')}</span></label>
        </div>
        <div className="strategy-compare"><p><span>{t('当前设置净收益', '現在設定の純収益', 'Net return (current settings)')}</span><b className={result.netReturnPct >= 0 ? 'positive' : 'negative'}>{result.netReturnPct >= 0 ? '+' : ''}{result.netReturnPct.toFixed(2)}%</b></p><p><span>{t('基准净收益', '基準の純収益', 'Net return (baseline)')}</span><b className={baselineResult.netReturnPct >= 0 ? 'positive' : 'negative'}>{baselineResult.netReturnPct >= 0 ? '+' : ''}{baselineResult.netReturnPct.toFixed(2)}%</b></p><p><span>{t('当前最大回撤', '現在の最大DD', 'Max drawdown (current)')}</span><b>{result.maxDrawdownPct.toFixed(2)}%</b></p><p><span>{t('基准最大回撤', '基準の最大DD', 'Max drawdown (baseline)')}</span><b>{baselineResult.maxDrawdownPct.toFixed(2)}%</b></p></div>
      </section>

      <section className="simulation-plan">
        <div><p className="eyebrow">THREE-STEP PAPER RESEARCH · NO BROKER CONNECTION</p><h4>{t('三步模拟研究', '3段階ペーパー研究', 'Three-step paper research')}</h4><span>{t('第1步核对数据；第2步让三个事先定义的策略在同一成本假设下各跑一次；第3步只把满足研究闸门的候选带入内部模拟。排序不是“最佳策略”承诺。', '第1段階でデータを確認し、第2段階で事前定義した3戦略を同じコスト仮定で各1回検証し、第3段階で研究ゲートを満たす候補だけを内部ペーパーへ進めます。順位は「最良戦略」の約束ではありません。', 'Step 1 verifies data; step 2 runs three pre-defined strategies once each under the same cost assumptions; step 3 moves only gate-passing candidates into internal simulation. The ranking is not a “best strategy” promise.')}</span></div>
        <ol><li className={sourceBars ? 'pass' : ''}><b>1</b>{t('本机历史与周期核对', '端末内履歴と時間足の確認', 'Local history & timeframe check')}</li><li className={sourceBars && bars.length >= 300 ? 'pass' : ''}><b>2</b>{t('三个预定义候选的样本外比较', '3つの事前定義候補をOOS比較', 'Out-of-sample comparison of three pre-defined candidates')}</li><li className={sourceBars && rollingResults.length === 3 ? 'pass' : ''}><b>3</b>{t('进入内部模拟（不连券商）', '内部ペーパーへ進行（ブローカー未接続）', 'Continue to internal simulation (no broker)')}</li></ol>
        <div className="candidate-list">{simulationTrials.map((trial, index) => <article key={trial.candidate.id}><div><span>{t(`排序 ${index + 1}`, `順位 ${index + 1}`, `Rank ${index + 1}`)}</span><b>{t(trial.candidate.zh, trial.candidate.ja, trial.candidate.en)}</b><small>{t(trial.candidate.zhNote, trial.candidate.jaNote, trial.candidate.enNote)}</small></div><p><span>{t('样本外', 'OOS', 'Out-of-sample')}</span><b className={trial.outOfSample && trial.outOfSample.netReturnPct >= 0 ? 'positive' : 'negative'}>{trial.outOfSample ? `${trial.outOfSample.netReturnPct >= 0 ? '+' : ''}${trial.outOfSample.netReturnPct.toFixed(2)}% · DD ${trial.outOfSample.maxDrawdownPct.toFixed(2)}%` : '—'}</b></p><label><span>{t('你的备注', 'あなたのメモ', 'Your notes')}</span><input value={candidateNotes[trial.candidate.id] ?? ''} onChange={(event) => setCandidateNotes((current) => ({ ...current, [trial.candidate.id]: event.target.value }))} placeholder={t('仅保存到本机', '端末内にのみ保存', 'Saved locally only')} /></label></article>)}</div>
      </section>

      <div className="backtest-controls">
        <label><span>{t('样本K线数', 'サンプル本数', 'Sample candles')}</span><select value={sampleSize} onChange={(event) => setSampleSize(Number(event.target.value))}><option value="480">480</option><option value="900">900</option><option value="1600">1,600</option></select></label>
        <label><span>{t('计入点差', 'スプレッド', 'Spread included')}</span><input type="number" min="0.1" max="8" step="0.1" value={spreadPips} onChange={(event) => setSpreadPips(Number(event.target.value))} /><b>pips</b></label>
        <label><span>{t('单笔风险', '1取引リスク', 'Risk per trade')}</span><strong>{risk.riskPerTradePct.toFixed(2)}%</strong><small>{t('在风险设置中修改', 'リスク設定で変更', 'Change in risk settings')}</small></label>
        <label><span>{t('策略版本', '戦略バージョン', 'Strategy version')}</span><strong>{entryModel}/0.4</strong><small>{t('参数可自由修改；会保留边界以避免无效实验。', 'パラメーターは自由に変更できますが、無効な検証を避けるための範囲は保持します。', 'Parameters are freely editable; bounds are kept to avoid invalid experiments.')}</small></label>
      </div>

      <div className="metric-grid">
        <article><span>{t('净收益', '純収益', 'Net return')}</span><strong className={result.netReturnPct >= 0 ? 'positive' : 'negative'}>{result.netReturnPct >= 0 ? '+' : ''}{result.netReturnPct.toFixed(2)}%</strong><small>{money.format(result.endingEquity)}</small></article>
        <article><span>{t('最大回撤', '最大ドローダウン', 'Max drawdown')}</span><strong>{result.maxDrawdownPct.toFixed(2)}%</strong><small>{t('按权益峰值计算', '資産ピーク基準', 'Measured from peak equity')}</small></article>
        <article><span>{t('胜率', '勝率', 'Win rate')}</span><strong>{result.winRatePct.toFixed(1)}%</strong><small>{result.totalTrades} {t('笔交易', '取引', 'trades')}</small></article>
        <article><span>{t('盈亏因子', 'プロフィットファクター', 'Profit factor')}</span><strong>{profitFactor}</strong><small>{t('平均', '平均', 'Average')} {result.averageR.toFixed(2)}R</small></article>
      </div>

      <details className="research-warning" open={false}>
        <summary>{t('蒙特卡洛重抽样（500 次，确定seed，可复现）', 'モンテカルロ再サンプリング（500回・決定論的シード）', 'Monte Carlo resampling (500 runs, deterministic seed)')}</summary>
        {result.trades.length === 0 ? <p className="empty-state">{t('当前样本没有交易，无法重抽样。', '現在のサンプルには取引がないため、再サンプリングできません。', 'No trades in the current sample to resample.')}</p> : <p className="research-warning"><b>MC</b><span>{t('P5 收益', 'P5収益', 'P5 return')} {monteCarlo.p5ReturnPct.toFixed(2)}% · {t('P95 回撤', 'P95DD', 'P95 drawdown')} {monteCarlo.p95MaxDrawdownPct.toFixed(2)}% · {t('触及 30% 回撤的频率', '30%DD到達頻度', 'frequency of hitting 30% drawdown')} {monteCarlo.ruinProbabilityPct.toFixed(1)}%。{t('它只重排同样的交易序列；不是收益承诺。', '同じ取引の並び替えであり、収益保証ではありません。', 'It only reorders the same trade sequence; it is not a profit promise.')}</span></p>}
      </details>

      <div className="backtest-grid">
        <article className="equity-panel"><div className="section-title"><b>{t('权益曲线', '資産曲線', 'Equity curve')}</b><span>{t('含点差与滑点', 'スプレッド・スリッページ込み', 'Spread and slippage included')}</span></div><EquityChart points={result.equityCurve} timeZone={displayTimeZone} locale={locale} /></article>
        <article className="trade-ledger"><div className="section-title"><b>{t('最近交易', '直近の取引', 'Recent trades')}</b><span>{t('保守处理同柱止损/止盈', '同一足はストップ優先', 'Same-bar stop is conservatively preferred')}</span></div>
          <div className="trade-table">
            <div className="trade-row header"><span>{t('方向', '方向', 'Side')}</span><span>{t('入场', 'エントリー', 'Entry')}</span><span>{t('结果', '結果', 'Result')}</span></div>
            {result.trades.slice(-6).reverse().map((trade) => (
              <div className="trade-row" key={trade.id}><span className={trade.side === 'long' ? 'positive' : 'negative'}>{trade.side === 'long' ? t('买入', '買い', 'Buy') : t('卖出', '売り', 'Sell')}</span><span>{date(trade.entryTime)}</span><b className={trade.rMultiple >= 0 ? 'positive' : 'negative'}>{trade.rMultiple >= 0 ? '+' : ''}{trade.rMultiple.toFixed(2)}R</b></div>
            ))}
            {result.trades.length === 0 && <p className="empty-state">{t('当前样本没有触发完整交易。', '現在のサンプルでは取引が成立していません。', 'No complete trades were triggered in the current sample.')}</p>}
          </div>
        </article>
      </div>
    </section>
  );
}
