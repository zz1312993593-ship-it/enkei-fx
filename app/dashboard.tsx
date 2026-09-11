'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import FxChart from './fx-chart';
import DataHealthPanel from './data-health-panel';
import BacktestPanel from './backtest-panel';
import EventPlanner from './event-planner';
import ModelLab from './model-lab';
import StrategyTournament from './strategy-tournament';
import ForwardValidation from './forward-validation';
import AdaptiveResearchPanel, { AdaptiveResearchEngine } from './adaptive-research';
import MarketResearchPanel from './market-research';
import ManualView from './manual-view';
import FirstRunWelcome from './first-run-welcome';
import DemoExecutionPanel from './demo-execution-panel';
import DemoAutomationPanel from './demo-automation-panel';
import AiTerminalConsole from './ai-terminal-console';
import OperationsPanel from './operations-panel';
import LiveTradingPanel from './live-trading-panel';
import AiLearningCenter from './ai-learning-center';
import { findMt4Quote, type Mt4HistoryCoverage, type Mt4HistorySnapshot, type Mt4QuoteSnapshot } from '../lib/mt4-bridge';
import { APP_VERSION } from '../lib/app-version';
import CommandCenter from './command-center';
import { loadThemeMode, loadThemeAccent, type ThemeMode, type ThemeAccent } from '../lib/theme';
import { buildResearchSignal, type ResearchModel } from '../lib/research-signal';
import { RESEARCH_MODELS, modelDefinition, modelName } from '../lib/model-catalog';
import { loadAdaptiveState } from '../lib/adaptive-research';
import { AiTerminalClient, saveAiTerminalUrl } from '../lib/ai-terminal';
import { flushEvaluationOutbox } from '../lib/ai-evaluation-outbox';
import {
  decimalsFor,
  DEFAULT_RISK_CONFIG,
  QUOTES,
  TIMEFRAME_SECONDS,
  type PairSymbol,
  type RiskConfig,
  type Timeframe,
} from '../lib/market-data';

type Language = 'zh' | 'ja' | 'en';
type ActiveView = 'overview' | 'dataHealth' | 'backtest' | 'paper' | 'journal' | 'demo' | 'live' | 'models' | 'terminal' | 'tournament' | 'forward' | 'adaptive' | 'marketResearch' | 'learning' | 'operations' | 'settings' | 'manual';
type NavGroupId = 'demo' | 'live' | 'operations' | 'research' | 'learning';
type DisplayTimeZone = 'Asia/Tokyo' | 'America/New_York' | 'Europe/London' | 'Asia/Shanghai';

const DISPLAY_TIME_ZONES: Array<{ id: DisplayTimeZone; zh: string; ja: string; en: string; short: string }> = [
  { id: 'Asia/Tokyo', zh: '日本时间', ja: '日本時間', en: 'Japan time', short: 'JST' },
  { id: 'America/New_York', zh: '美国东部', ja: '米国東部', en: 'US Eastern', short: 'ET' },
  { id: 'Europe/London', zh: '英国时间', ja: '英国時間', en: 'UK time', short: 'UK' },
  { id: 'Asia/Shanghai', zh: '中国时间', ja: '中国時間', en: 'China time', short: 'CST' },
];

function loadLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  const saved = window.localStorage.getItem('enkei-language');
  return saved === 'zh' || saved === 'ja' || saved === 'en' ? saved : 'zh';
}

function loadDisplayTimeZone(): DisplayTimeZone {
  if (typeof window === 'undefined') return 'Asia/Tokyo';
  const saved = window.localStorage.getItem('enkei-display-time-zone');
  return DISPLAY_TIME_ZONES.some((item) => item.id === saved) ? saved as DisplayTimeZone : 'Asia/Tokyo';
}

function snapshotReceivedAt(snapshot: Mt4QuoteSnapshot | null): string {
  const seconds = Number(snapshot?.gmt_epoch);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
}


// 发布版一级导航只突出五项日常能力。模型、API 与偏好从页头“设置”进入，
// 不再与业务入口并列；研究工具仍可作为对应中心的二级页面访问。
const NAV_GROUPS: Array<{ id: NavGroupId; icon: string; label: { zh: string; ja: string; en: string }; intro: { zh: string; ja: string; en: string }; items: Array<{ view: ActiveView; icon: string; label: { zh: string; ja: string; en: string } }> }> = [
  {
    id: 'demo', icon: '验',
    label: { zh: 'Demo 验证', ja: 'Demo検証', en: 'Demo verification' },
    intro: {
      zh: '以真实行情验证判断、执行、急停、回传和学习闭环。',
      ja: '実相場で判断・執行・緊急停止・返送・学習循環を検証します。',
      en: 'Validate decisions, execution, emergency stops, feedback and learning on real market data.',
    },
    items: [{ view: 'demo', icon: '验', label: { zh: 'Demo 验证', ja: 'Demo検証', en: 'Demo verification' } }],
  },
  {
    id: 'live', icon: '实',
    label: { zh: '实盘连接', ja: '実取引接続', en: 'Live trading' },
    intro: {
      zh: '满足全部授权和风控条件后，提供可持续、可追溯的正式实盘能力。',
      ja: '認証とリスク条件を満たした場合のみ、継続的で追跡可能な実取引を提供します。',
      en: 'Controlled, traceable live operation after every authorisation and risk gate passes.',
    },
    items: [{ view: 'live', icon: '实', label: { zh: '实盘连接', ja: '実取引接続', en: 'Live trading' } }],
  },
  {
    id: 'operations', icon: '运',
    label: { zh: '运营中心', ja: '運用センター', en: 'Operations centre' },
    intro: {
      zh: '集中管理服务、行情、模型链路、MT4、备份、诊断、版本与安全状态。',
      ja: 'サービス・相場・モデル経路・MT4・バックアップ・診断・版・安全状態を管理します。',
      en: 'Manage services, market feeds, model routes, MT4, backups, diagnostics, versions and safety.',
    },
    items: [
      { view: 'operations', icon: '运', label: { zh: '运营中心', ja: '運用センター', en: 'Operations centre' } },
      { view: 'overview', icon: '概', label: { zh: '市场总览', ja: '市場概要', en: 'Market overview' } },
      { view: 'dataHealth', icon: '质', label: { zh: '数据质量', ja: 'データ品質', en: 'Data quality' } },
    ],
  },
  {
    id: 'research', icon: '踪',
    label: { zh: '专项追踪', ja: '特別追跡', en: 'Research tracks' },
    intro: {
      zh: '管理连续研究、重大事件、异常波动和统一分析体上下文。',
      ja: '継続研究・重要イベント・異常変動・統合分析文脈を管理します。',
      en: 'Manage continuous research, major events, abnormal moves and unified-analysis context.',
    },
    items: [
      { view: 'marketResearch', icon: '踪', label: { zh: '专项追踪', ja: '特別追跡', en: 'Research tracks' } },
      { view: 'backtest', icon: '研', label: { zh: '策略研究', ja: '戦略研究', en: 'Strategy research' } },
    ],
  },
  {
    id: 'learning', icon: '学',
    label: { zh: 'AI 学习中心', ja: 'AI学習センター', en: 'AI learning centre' },
    intro: {
      zh: '查看分析会话、复盘、模型能力、条件权重、建议、版本和回滚。',
      ja: '分析会話・検証・モデル能力・条件重み・提案・版・ロールバックを確認します。',
      en: 'Review analysis conversations, outcomes, model ability, conditional weights, proposals, versions and rollback.',
    },
    items: [
      { view: 'learning', icon: '学', label: { zh: 'AI 学习中心', ja: 'AI学習センター', en: 'AI learning centre' } },
    ],
  },
];

const NAV_GROUP_OF_VIEW: Record<ActiveView, NavGroupId> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.view, group.id])),
) as Record<ActiveView, NavGroupId>;
Object.assign(NAV_GROUP_OF_VIEW, {
  paper: 'demo', journal: 'learning', models: 'operations', terminal: 'operations',
  tournament: 'research', forward: 'research', adaptive: 'research', settings: 'operations', manual: 'operations',
});

function navLabel(label: { zh: string; ja: string; en: string }, language: Language) {
  return language === 'zh' ? label.zh : language === 'ja' ? label.ja : label.en;
}

function inRange(value: unknown, fallback: number, minimum: number, maximum: number, step = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const bounded = Math.min(maximum, Math.max(minimum, numeric));
  return step > 0 ? Math.round(bounded / step) * step : bounded;
}

function normaliseRiskConfig(value: unknown): RiskConfig {
  const saved = value && typeof value === 'object' ? value as Partial<RiskConfig> : {};
  return {
    riskPerTradePct: inRange(saved.riskPerTradePct, DEFAULT_RISK_CONFIG.riskPerTradePct, .05, 2, .05),
    dailyLossLimitPct: inRange(saved.dailyLossLimitPct, DEFAULT_RISK_CONFIG.dailyLossLimitPct, .1, 10, .1),
    maxOpenPositions: Math.round(inRange(saved.maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions, 1, 10)),
    maxSpreadPips: inRange(saved.maxSpreadPips, DEFAULT_RISK_CONFIG.maxSpreadPips, .5, 5, .1),
    eventPauseMinutes: Math.round(inRange(saved.eventPauseMinutes, DEFAULT_RISK_CONFIG.eventPauseMinutes, 0, 240, 5)),
    requireStopLoss: true,
  };
}

function loadRiskConfig(): RiskConfig {
  if (typeof window === 'undefined') return DEFAULT_RISK_CONFIG;
  const saved = window.localStorage.getItem('enkei-risk-config');
  if (!saved) return DEFAULT_RISK_CONFIG;
  try {
    return normaliseRiskConfig(JSON.parse(saved));
  } catch {
    window.localStorage.removeItem('enkei-risk-config');
    return DEFAULT_RISK_CONFIG;
  }
}

function loadResearchModel(): ResearchModel {
  if (typeof window === 'undefined') return 'trend-breakout';
  const saved = window.localStorage.getItem('enkei-active-research-model');
  return RESEARCH_MODELS.some((item) => item.id === saved) ? saved as ResearchModel : 'trend-breakout';
}

function initialClock() {
  return Date.now();
}

function sessionStatus(now: number, timeZone: string, startHour: number, endHour: number) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? -1);
  return !['Sat', 'Sun'].includes(weekday) && hour >= startHour && hour < endHour;
}

function timeLabel(now: number, timeZone: string, locale = 'ja-JP') {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
}

export default function Dashboard() {
  const [language, setLanguage] = useState<Language>(loadLanguage);
  const [activeView, setActiveView] = useState<ActiveView>('overview');
  // 批R：主题（classic 原生亮色 / command 暗色指挥中心）+ 强调色，长期记忆。
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [themeAccent, setThemeAccent] = useState<ThemeAccent>(loadThemeAccent);
  useEffect(() => {
    const onAccent = (event: Event) => {
      const detail = (event as CustomEvent<ThemeAccent>).detail;
      if (detail) { setThemeAccent(detail); window.localStorage.setItem('enkei-theme-accent', detail); }
    };
    window.addEventListener('enkei-accent-change', onAccent);
    return () => window.removeEventListener('enkei-accent-change', onAccent);
  }, []);

  // The controller owns the actual terminal port. Keep every browser client
  // aligned with it so analysis, evaluation replay and the console cannot
  // accidentally talk to different local terminals.
  useEffect(() => {
    let active = true;
    const syncTerminalEndpoint = async () => {
      try {
        const response = await fetch('http://127.0.0.1:8787/api/status', { cache: 'no-store' });
        const status = await response.json() as { ai_terminal?: { running?: boolean; endpoint?: string } };
        if (active && status.ai_terminal?.running && status.ai_terminal.endpoint) saveAiTerminalUrl(status.ai_terminal.endpoint);
      } catch { /* The runtime supervisor will retry; do not erase the last known endpoint. */ }
    };
    void syncTerminalEndpoint();
    const timer = window.setInterval(() => void syncTerminalEndpoint(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [symbol, setSymbol] = useState<PairSymbol>('USD/JPY');
  const [timeframe, setTimeframe] = useState<Timeframe>('M15');
  const [showPairs, setShowPairs] = useState(false);
  const [showMoreTimeframes, setShowMoreTimeframes] = useState(false);
  const [showRisk, setShowRisk] = useState(false);
  // 侧栏手风琴：默认展开当前视图所在组；点组名可展开/收起（批L 侧栏简化）。
  // 不用 effect 同步：'none' 哨兵表示用户显式收起了当前组。
  const [manualNavGroup, setManualNavGroup] = useState<NavGroupId | 'none' | null>(null);
  const expandedNavGroup = (group: NavGroupId) => manualNavGroup === 'none' ? false : manualNavGroup !== null ? manualNavGroup === group : NAV_GROUP_OF_VIEW[activeView] === group;
  // 批K：首次启动引导（语言+时区长期记忆）。localStorage 无标记时显示一次。
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeChecked, setWelcomeChecked] = useState(false);
  const [risk, setRisk] = useState<RiskConfig>(loadRiskConfig);

  useEffect(() => {
    const closeTransientNavigation = () => setShowMoreTimeframes(false);
    window.addEventListener('resize', closeTransientNavigation);
    return () => window.removeEventListener('resize', closeTransientNavigation);
  }, []);
  const [savedNotice, setSavedNotice] = useState(false);
  const [riskSaving, setRiskSaving] = useState(false);
  const [shutdownBusy, setShutdownBusy] = useState(false);
  const riskSavingRef = useRef(false);
  const [now, setNow] = useState(initialClock);
  const [mt4Snapshot, setMt4Snapshot] = useState<Mt4QuoteSnapshot | null>(null);
  const [mt4History, setMt4History] = useState<Mt4HistorySnapshot | null>(null);
  const [mt4Coverage, setMt4Coverage] = useState<Mt4HistoryCoverage | null>(null);
  const [bridgeState, setBridgeState] = useState<'waiting' | 'live'>('waiting');
  const [researchModel, setResearchModel] = useState<ResearchModel>(loadResearchModel);
  const [displayTimeZone, setDisplayTimeZone] = useState<DisplayTimeZone>(loadDisplayTimeZone);
  const [adaptiveState, setAdaptiveState] = useState(loadAdaptiveState);
  const evaluationRelay = useRef(new AiTerminalClient());

  // Evaluation delivery is application-wide, not owned by the Demo page.
  // It therefore continues while the user views Live, Learning or the console.
  useEffect(() => {
    const flush = () => void flushEvaluationOutbox(evaluationRelay.current);
    flush();
    const timer = window.setInterval(flush, 10_000);
    const resume = () => { if (document.visibilityState === 'visible') flush(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', flush);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', flush); };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowWelcome(!window.localStorage.getItem('enkei-welcome-done'));
      setWelcomeChecked(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(initialClock()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { window.localStorage.setItem('enkei-active-research-model', researchModel); }, [researchModel]);
  useEffect(() => {
    window.localStorage.setItem('enkei-language', language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    void fetch('http://127.0.0.1:8710/v1/preferences/language', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }),
    }).catch(() => undefined);
  }, [language]);
  useEffect(() => { window.localStorage.setItem('enkei-display-time-zone', displayTimeZone); }, [displayTimeZone]);

  // 桌面键盘用户：Esc 关闭"更多周期"弹出层（清单 3.4）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowMoreTimeframes(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('http://127.0.0.1:8788/api/snapshot');
        if (!response.ok) throw new Error('Bridge unavailable');
        const snapshot = await response.json() as Mt4QuoteSnapshot;
        if (active) {
          setMt4Snapshot(snapshot);
          setBridgeState(snapshot.age_ms <= 10_000 ? 'live' : 'waiting');
        }
      } catch {
        if (active) {
          setMt4Snapshot(null);
          setBridgeState('waiting');
        }
      }
    };
    refresh();
    // The MT4 publisher is still read-only. Sampling it once per second keeps
    // the web quote/status view responsive without treating tick noise as a trade signal.
    const timer = window.setInterval(refresh, 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    const refreshHistory = async () => {
      try {
        const largeHistoryView = ['backtest', 'models', 'tournament', 'forward'].includes(activeView);
        const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(symbol.replace('/', ''))}&timeframe=${timeframe}&limit=${largeHistoryView ? 20000 : 3000}`);
        if (!response.ok) throw new Error('MT4 history unavailable');
        const history = await response.json() as Mt4HistorySnapshot;
        if (active) setMt4History(history);
      } catch {
        if (active) setMt4History(null);
      }
    };
    refreshHistory();
    const timer = window.setInterval(refreshHistory, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol, timeframe, activeView]);

  useEffect(() => {
    let active = true;
    const refreshCoverage = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:8788/api/coverage?symbol=${encodeURIComponent(symbol.replace('/', ''))}`);
        if (!response.ok) throw new Error('MT4 coverage unavailable');
        const coverage = await response.json() as Mt4HistoryCoverage;
        if (active) setMt4Coverage(coverage);
      } catch {
        if (active) setMt4Coverage(null);
      }
    };
    refreshCoverage();
    const timer = window.setInterval(refreshCoverage, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol]);

  const baseQuote = QUOTES.find((item) => item.symbol === symbol) ?? QUOTES[0];
  const matchingMt4Quote = findMt4Quote(mt4Snapshot, symbol);
  const hasLiveQuote = matchingMt4Quote !== null && bridgeState === 'live';
  const quote = hasLiveQuote
    ? { ...baseQuote, bid: matchingMt4Quote.bid, ask: matchingMt4Quote.ask, receivedAt: snapshotReceivedAt(mt4Snapshot), source: 'mt4' as const }
    : baseQuote;
  const hasBridgeHistory = mt4History !== null && mt4History.timeframe === timeframe && mt4History.bars.length >= 100;
  const historyClockVerified = mt4History?.clock?.status === 'aligned' || mt4History?.clock?.status === 'offset-corrected';
  const usingBridgeHistory = hasBridgeHistory && historyClockVerified;
  // A trading-facing chart must never turn missing MT4 history into a plausible
  // looking synthetic chart.  Empty history means neutral research and an
  // explicit wait state, not an invented annual or intraday series.
  const bars = useMemo(() => usingBridgeHistory ? mt4History!.bars : [], [mt4History, usingBridgeHistory]);
  const historyLagSeconds = usingBridgeHistory && mt4History?.latest_bar_time ? Math.max(0, Math.floor(now / 1000) - mt4History.latest_bar_time) : 0;
  const isHistoryBehind = usingBridgeHistory && historyLagSeconds > TIMEFRAME_SECONDS[timeframe] * 2;
  const autonomousTimeframe = (timeframe === 'M1' || timeframe === 'M5' || timeframe === 'M15' || timeframe === 'H1') ? timeframe : 'M15';
  const autonomousDecision = adaptiveState.timeframeDecisions[autonomousTimeframe];
  const autonomousModel = autonomousDecision?.selectedModel ?? adaptiveState.selectedModel;
  // The overview is an autonomous recommendation. Manual model choices below
  // remain research-only and cannot alter the Demo execution selection.
  const signal = useMemo(() => buildResearchSignal(bars, symbol, timeframe, autonomousModel), [autonomousModel, bars, symbol, timeframe]);
  const visibleQuotes = QUOTES.slice(0, 3).map((item) => {
    const liveQuote = findMt4Quote(mt4Snapshot, item.symbol);
    return liveQuote !== null && bridgeState === 'live'
      ? { ...item, bid: liveQuote.bid, ask: liveQuote.ask, receivedAt: snapshotReceivedAt(mt4Snapshot), source: 'mt4' as const }
      : item;
  });
  const primary = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const price = quote.bid.toFixed(decimalsFor(symbol));
  const pageTitle = (() => {
    const titles: Record<ActiveView, { zh: string; ja: string; en: string }> = {
      overview: { zh: '市场总览', ja: 'マーケット概要', en: 'Market overview' },
      dataHealth: { zh: '数据质量', ja: 'データ品質', en: 'Data quality' },
      backtest: { zh: '策略回测', ja: 'ストラテジー検証', en: 'Strategy backtest' },
      paper: { zh: '内部模拟', ja: '内部ペーパートレード', en: 'Paper simulation' },
      journal: { zh: '信号与回溯', ja: 'シグナルと振り返り', en: 'Signals & journal' },
      demo: { zh: '模拟账户验收', ja: 'デモ口座検収', en: 'Demo verification' },
      live: { zh: '实盘连接（默认锁定）', ja: '実取引接続（既定ロック）', en: 'Live link (locked by default)' },
      models: { zh: '模型窗口', ja: 'モデル・ウィンドウ', en: 'Model workspace' },
      terminal: { zh: 'AI 终端控制', ja: 'AIターミナル制御', en: 'AI terminal control' },
      tournament: { zh: '策略筛选', ja: 'ストラテジー選抜', en: 'Strategy selection' },
      forward: { zh: '前向验证', ja: 'フォワード検証', en: 'Forward validation' },
      adaptive: { zh: '自适应研究', ja: '適応型リサーチ', en: 'Adaptive research' },
      marketResearch: { zh: '市场专项追踪', ja: 'マーケット特別追跡', en: 'Market research tracks' },
      learning: { zh: 'AI 学习中心', ja: 'AI学習センター', en: 'AI learning centre' },
      operations: { zh: '运营中心', ja: '運用センター', en: 'Operations centre' },
      settings: { zh: '风险与偏好', ja: 'リスクと設定', en: 'Risk & preferences' },
      manual: { zh: '使用说明', ja: '取扱説明', en: 'User manual' },
    };
    return navLabel(titles[activeView], language);
  })();
  const direction = signal.direction === 'wait'
    ? primary('观望', '待機', 'Wait')
    : signal.direction === 'long'
      ? primary('偏多', '買い優勢', 'Long bias')
      : primary('偏空', '売り優勢', 'Short bias');
  const activeModelDefinition = modelDefinition(autonomousModel);
  const modelLabel = modelName(activeModelDefinition, language);
  const displayZone = DISPLAY_TIME_ZONES.find((item) => item.id === displayTimeZone) ?? DISPLAY_TIME_ZONES[0];
  const locale = language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US';
  const displayDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: displayTimeZone }).format(new Date(now));
  const latestHistoryTime = mt4History?.latest_bar_time
    ? new Intl.DateTimeFormat(locale, { timeZone: displayTimeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(mt4History.latest_bar_time * 1000))
    : '—';
  const marketSessions = [
    { label: primary('东京', '東京', 'Tokyo'), timezone: 'Asia/Tokyo', open: sessionStatus(now, 'Asia/Tokyo', 9, 18) },
    { label: primary('伦敦', 'ロンドン', 'London'), timezone: 'Europe/London', open: sessionStatus(now, 'Europe/London', 8, 17) },
    { label: primary('纽约', 'ニューヨーク', 'New York'), timezone: 'America/New_York', open: sessionStatus(now, 'America/New_York', 8, 17) },
  ];

  const saveRisk = (nextRisk?: RiskConfig) => {
    if (riskSavingRef.current) return;
    const value = normaliseRiskConfig(nextRisk ?? risk);
    riskSavingRef.current = true;
    setRiskSaving(true);
    if (nextRisk) setRisk(value);
    window.localStorage.setItem('enkei-risk-config', JSON.stringify(value));
    setSavedNotice(true);
    window.setTimeout(() => {
      setSavedNotice(false);
      riskSavingRef.current = false;
      setRiskSaving(false);
    }, 600);
  };

  const updateRisk = (key: keyof RiskConfig, value: number) => {
    setRisk((current) => normaliseRiskConfig({ ...current, [key]: value }));
  };

  const shutdownApplication = async () => {
    if (shutdownBusy || !window.confirm(primary('确认关闭圆衡应用及其全部受管进程？未平仓持仓不会自动改变。', '円衡アプリと管理対象プロセスをすべて終了しますか？ 保有ポジションは自動決済されません。', 'Close Enkei and all managed processes? Open positions will not be changed automatically.'))) return;
    setShutdownBusy(true);
    try {
      await fetch('http://127.0.0.1:8787/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      window.setTimeout(() => window.close(), 500);
    } catch {
      window.alert(primary('无法连接本机控制中心，应用未关闭。', 'コントロールセンターに接続できず、終了できません。', 'The local controller is unreachable; Enkei was not closed.'));
      setShutdownBusy(false);
    }
  };

  // 批S：command 模式 = 全屏控制台接管（亮色壳不渲染）；classic = 原有应用。
  if (!welcomeChecked) return <main className="app-shell"><div className="startup-screen"><b>円衡 Enkei</b><span>Preparing language selection…</span></div></main>;
  if (showWelcome) return <FirstRunWelcome initialLanguage={language} initialTimeZone={displayTimeZone} onFinish={(nextLanguage, nextTimeZone) => { setLanguage(nextLanguage); setDisplayTimeZone(nextTimeZone); window.localStorage.setItem('enkei-welcome-done', new Date().toISOString()); setShowWelcome(false); }} />;

  if (themeMode === 'command') {
    return (
      <CommandCenter
        language={language}
        quotes={mt4Snapshot}
        symbol={symbol}
        onSelectSymbol={setSymbol}
        risk={risk}
        accent={themeAccent}
        onOpenView={(view) => { setThemeMode('classic'); window.localStorage.setItem('enkei-theme-mode', 'classic'); setActiveView(view as ActiveView); }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">円</div>
          <div>
            <p className="eyebrow">JPY FX QUANT DESK</p>
            <h1>円衡 <span>Enkei</span></h1>
          </div>
        </div>
        <div className="mode-chip"><span />{activeView === 'paper' ? primary('内部模拟', '内部ペーパー', 'Paper simulation') : activeView === 'demo' ? primary('Demo 演练 · 执行确认服务', 'Demo演習・実行確認サービス', 'Demo rehearsal · execution confirmation') : activeView === 'live' ? primary('实盘确认 · 全局锁定', '実取引確認・全体ロック', 'Live confirmation · globally locked') : activeView === 'models' ? primary('模型研究，无订单', 'モデル研究・注文なし', 'Model research · no orders') : activeView === 'terminal' ? primary('本机终端控制', '端末内ターミナル制御', 'Local terminal control') : activeView === 'tournament' ? primary('策略研究，无订单', '戦略研究・注文なし', 'Strategy research · no orders') : activeView === 'forward' ? primary('前向验证 · 观察研究', 'フォワード検証・観察研究', 'Forward validation · observe') : activeView === 'adaptive' ? primary('自适应研究，无订单', 'Adaptive research · no orders', 'Adaptive research · no orders') : activeView === 'marketResearch' ? primary('研究上下文 · 不直接下单', '研究コンテキスト・直接注文なし', 'Research context · no direct orders') : activeView === 'dataHealth' ? primary('只读检查 · 不参与判断', '読取点検・判断に不使用', 'Read-only checks · not used for judgement') : activeView === 'settings' ? primary('偏好设置 · 仅本机', '設定・端末内のみ', 'Preferences · this device only') : activeView === 'manual' ? primary('帮助文档 · 只读', 'ヘルプ・読み取り専用', 'Help · read-only') : activeView === 'operations' ? primary('运营就绪 · 无自动下单', '運用準備・自動注文なし', 'Operations · no auto orders') : primary('只读模式', '閲覧のみ', 'Read-only mode')}</div>
        <div className="header-actions">
          <label className="time-zone-select">
            <span>{primary('显示时区', '表示時刻', 'Display time zone')}</span>
            <select value={displayTimeZone} onChange={(event) => setDisplayTimeZone(event.target.value as DisplayTimeZone)} aria-label={primary('选择显示时区', '表示タイムゾーンを選択', 'Select display time zone')}>
              {DISPLAY_TIME_ZONES.map((zone) => <option key={zone.id} value={zone.id}>{language === 'zh' ? zone.zh : language === 'ja' ? zone.ja : zone.en}</option>)}
            </select>
          </label>
          <label className="language-select"><span>{primary('语言', '言語', 'Language')}</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)} aria-label={primary('选择语言', '言語を選択', 'Select language')}><option value="zh">中文</option><option value="ja">日本語</option><option value="en">English</option></select></label>
          <button className="icon-button" aria-label={primary('切换控制台/经典界面', 'コンソール/クラシック切替', 'Toggle console/classic')} title={primary('进入全屏交易控制台', 'トレーディングコンソールへ', 'Open the full-screen trading console')} onClick={() => { setThemeMode('command'); window.localStorage.setItem('enkei-theme-mode', 'command'); }}>◐</button>
          <button className="icon-button" aria-label={primary('AI 助手与模型设置', 'AIアシスタントとモデル設定', 'AI assistant and model settings')} onClick={() => setActiveView('terminal')} title={primary('AI 助手：状态、模型和新闻', 'AIアシスタント：状態・モデル・ニュース', 'AI assistant: status, models, and news')}>AI</button>
          <button className="icon-button" aria-label={primary('打开风险设置', 'リスク設定を開く', 'Open risk settings')} onClick={() => setShowRisk(true)}>{primary('设', '設', 'Risk')}</button>
          <button className="app-shutdown-button" onClick={() => void shutdownApplication()} disabled={shutdownBusy} title={primary('关闭应用及全部圆衡进程', 'アプリと円衡プロセスを終了', 'Close app and all Enkei processes')}>{shutdownBusy ? primary('关闭中…', '終了中…', 'Closing…') : primary('关闭应用', 'アプリ終了', 'Close app')}</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <nav aria-label={primary('主要导航', 'メインナビゲーション', 'Primary navigation')}>
            <div className="nav-mobile-groups">
              {NAV_GROUPS.map((group) => (
                <button key={group.id} className={`nav-item ${NAV_GROUP_OF_VIEW[activeView] === group.id ? 'active' : ''}`} aria-label={navLabel(group.label, language)} onClick={() => setActiveView(group.items[0].view)}>
                  <b>{group.icon}</b><span>{navLabel(group.label, language)}</span>
                </button>
              ))}
            </div>
            <div className="nav-tree">
              {NAV_GROUPS.map((group) => {
                const expanded = expandedNavGroup(group.id);
                return (
                  <div className="nav-group" key={group.id}>
                    <button className="nav-group-toggle" aria-expanded={expanded} title={navLabel(group.intro, language)} onClick={() => setManualNavGroup(expanded ? 'none' : group.id)}>
                      {navLabel(group.label, language)}<span className="caret">{expanded ? '▾' : '▸'}</span>
                    </button>
                    {expanded && group.items.map((item) => (
                      <button key={item.view} className={`nav-item ${activeView === item.view ? 'active' : ''}`} onClick={() => { setActiveView(item.view); setManualNavGroup(null); }}>
                        <b>{item.icon}</b><span>{navLabel(item.label, language)}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </nav>
          <div className="system-state">
            <span className="status-dot" />
            <p>{primary('系统正常', 'システム正常', 'System healthy')}</p>
            <small>v{APP_VERSION}</small>
          </div>
        </aside>

        <section className="dashboard" id="overview">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{displayDate} · {displayZone.short} {timeLabel(now, displayTimeZone, locale)}</p>
              <h2>{pageTitle}</h2>
            </div>
            <div className={`demo-badge ${bridgeState === 'live' ? 'live-badge' : ''}`}>{bridgeState === 'live' ? primary('MT4 只读报价', 'MT4 読取専用レート', 'MT4 read-only quote') : primary('演示数据', 'デモデータ', 'Demo data')}</div>
          </div>

          <nav className="subnav" aria-label={primary('当前分组页面', '現在のグループ', 'Current group pages')}>
            {(() => {
              const group = NAV_GROUPS.find((item) => item.id === NAV_GROUP_OF_VIEW[activeView]) ?? NAV_GROUPS[0];
              return <>
                <div className="subnav-tabs" role="tablist">
                  {group.items.map((item) => (
                    <button key={item.view} role="tab" aria-selected={activeView === item.view} className={`subnav-tab ${activeView === item.view ? 'active' : ''}`} onClick={() => setActiveView(item.view)}>
                      {navLabel(item.label, language)}
                    </button>
                  ))}
                </div>
                <p className="subnav-intro">{navLabel(group.intro, language)}</p>
              </>;
            })()}
          </nav>

          <div className="pair-strip" aria-label={primary('货币对报价', '通貨ペアレート', 'Pair quotes')}>
            {visibleQuotes.map((pair) => (
              <button
                className={`pair-card ${pair.symbol === symbol ? 'active' : ''}`}
                key={pair.symbol}
                onClick={() => setSymbol(pair.symbol)}
              >
                <div><strong>{pair.symbol}</strong><small>SPOT</small></div>
                <p>{pair.bid.toFixed(decimalsFor(pair.symbol))}</p>
                <span className={pair.changePct >= 0 ? 'positive' : 'negative'}>{pair.changePct >= 0 ? '+' : ''}{pair.changePct.toFixed(2)}%</span>
              </button>
            ))}
            <div className="pair-picker">
              <button className="add-pair" aria-label={primary('选择其他货币对', '他の通貨ペアを選択', 'Choose another pair')} onClick={() => setShowPairs(!showPairs)}>＋</button>
              {showPairs && (
                <div className="pair-menu">
                  {QUOTES.map((pair) => (
                    <button key={pair.symbol} onClick={() => { setSymbol(pair.symbol); setShowPairs(false); }}>
                      <span>{pair.symbol}</span><b>{pair.bid.toFixed(decimalsFor(pair.symbol))}</b>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {activeView === 'overview' && <>
          <div className="main-grid">
            <article className="chart-panel" id="market">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{symbol}</p>
                  <div className="quote-line"><strong>{price}</strong><span className={quote.changePct >= 0 ? 'positive' : 'negative'}>{quote.changePct >= 0 ? '+' : ''}{quote.changePct.toFixed(2)}%</span></div>
                </div>
                <div className="timeframes" aria-label={primary('时间周期', '時間足', 'Timeframe')}>
                  {(['M1', 'M5', 'M15', 'H1', 'H4'] as Timeframe[]).map((item) => (
                    <button className={item === timeframe ? 'active' : ''} key={item} onClick={() => setTimeframe(item)}>{item}</button>
                  ))}
                  <div className="timeframe-picker">
                    <button className={(['D1', 'W1', 'MN1', 'Y1'] as Timeframe[]).includes(timeframe) ? 'active' : ''} aria-label={primary('更多周期', 'その他の時間足', 'More timeframes')} onClick={() => setShowMoreTimeframes(!showMoreTimeframes)}>···</button>
                    {showMoreTimeframes && <div className="timeframe-menu">
                      {(['D1', 'W1', 'MN1', 'Y1'] as Timeframe[]).map((item) => <button key={item} className={item === timeframe ? 'active' : ''} onClick={() => { setTimeframe(item); setShowMoreTimeframes(false); }}>{item === 'D1' ? primary('日', '日足', 'Daily') : item === 'W1' ? primary('周', '週足', 'Weekly') : item === 'MN1' ? primary('月', '月足', 'Monthly') : primary('年', '年足', 'Yearly')}</button>)}
                    </div>}
                  </div>
                </div>
              </div>
              <div className="chart-area"><FxChart bars={bars} symbol={symbol} timeframe={timeframe} source={usingBridgeHistory ? 'mt4' : 'unavailable'} timeZone={displayTimeZone} locale={locale} language={language} liveQuote={hasLiveQuote ? { bid: quote.bid, ask: quote.ask, at: now } : null} /></div>
              <footer className="chart-footer">
                {marketSessions.map((session) => <span className={session.open ? 'market-open' : 'market-closed'} key={session.timezone}><i />{session.label} {timeLabel(now, session.timezone, locale)} · {session.open ? primary('开放', '取引中', 'Open') : primary('休市', '時間外', 'Closed')}</span>)}
                <small>{usingBridgeHistory
                  ? isHistoryBehind
                    ? primary(`MT4 ${timeframe} 历史最新K线落后约 ${Math.round(historyLagSeconds / 60)} 分钟；当前未完成K线仍按每秒只读报价更新`, `MT4 ${timeframe}履歴の最新足は約${Math.round(historyLagSeconds / 60)}分遅延。現在の未確定足は毎秒の読取レートで更新します`, `MT4 ${timeframe} history is about ${Math.round(historyLagSeconds / 60)} min behind; the active bar still updates from the 1-second read-only quote`)
                    : primary(`MT4 本机 ${timeframe} 历史 · ${mt4History?.total_bars.toLocaleString()} 根 · ${Math.max(0, Math.round((mt4History?.file_age_ms ?? 0) / 1000))} 秒前刷新 · 当前K线每秒更新 · 只读`, `MT4端末内 ${timeframe} 履歴・${mt4History?.total_bars.toLocaleString()}本・${Math.max(0, Math.round((mt4History?.file_age_ms ?? 0) / 1000))}秒前更新・現在足は毎秒更新・読取専用`, `MT4 local ${timeframe} history · ${mt4History?.total_bars.toLocaleString()} bars · refreshed ${Math.max(0, Math.round((mt4History?.file_age_ms ?? 0) / 1000))}s ago · active bar updates every second · read-only`)
                  : hasBridgeHistory
                    ? primary('MT4 历史时间尚未通过校准；为避免旧K线被误读为实时，暂不用于图表或回测。', 'MT4履歴時刻が未補正のため、古い足をリアルタイムと誤認しないようチャート・検証には使用しません。', 'MT4 history clock is not calibrated yet; to avoid reading old candles as live, it is not used for charts or backtests.')
                  : quote.source === 'mt4'
                    ? primary('MT4 只读报价 · 当前周期历史正在准备，未就绪前图表保持等待态，不显示演示K线', 'MT4読取専用レート・現在の時間足履歴を準備中。未準備時はチャートを待機状態にし、デモ足は表示しません', 'MT4 read-only quotes · history for this timeframe is preparing; until ready the chart stays in a waiting state and shows no demo candles')
                  : primary('演示报价 · 本地时间', 'デモレート・ローカル時刻', 'Demo quotes · local time')}</small>
              </footer>
              <details className="chart-context" aria-label={primary('图表详情', 'チャート詳細', 'Chart details')}>
                <summary>{primary('图表详情与数据状态', 'チャート詳細とデータ状態', 'Chart details & data status')}</summary>
                <div>
                  <article><span>{primary('显示时钟', '表示クロック', 'Display clock')}</span><strong>{timeLabel(now, displayTimeZone, locale)} {displayZone.short}</strong><small>{language === 'zh' ? displayZone.zh : language === 'ja' ? displayZone.ja : displayZone.en}</small></article>
                  <article><span>{primary('最新历史K线', '最新履歴足', 'Latest historical bar')}</span><strong>{latestHistoryTime}</strong><small>{usingBridgeHistory ? `${timeframe} · MT4` : primary('等待历史校准', '履歴校正待ち', 'Waiting for history calibration')}</small></article>
                  <article><span>{primary('研究观察', '研究観測', 'Research view')}</span><strong className={signal.direction === 'long' ? 'positive' : signal.direction === 'short' ? 'negative' : ''}>{direction}</strong><small>{modelLabel} · {timeframe}</small></article>
                  <article><span>{primary('数据状态', 'データ状態', 'Data status')}</span><strong>{usingBridgeHistory ? primary('本机只读', '端末内読取', 'Local read-only') : primary('演示', 'デモ', 'Demo')}</strong><small>{usingBridgeHistory ? primary('不含下单能力', '発注機能なし', 'No order access') : primary('未用于真实交易', '実取引には未使用', 'Not for live trading')}</small></article>
                </div>
              </details>
            </article>

            <aside className="insight-column">
              <article className="signal-card" id="signals">
                <div className="card-kicker"><span className="pulse" />{usingBridgeHistory ? primary('当前研究观察', '現在の研究観測', 'Current research view') : primary('等待真实历史', '実履歴を待機', 'Waiting for real history')}</div>
                <div className="signal-controls">
                  <select value={researchModel} onChange={(event) => setResearchModel(event.target.value as ResearchModel)} aria-label={primary('仅供查看的研究策略', '閲覧専用の研究ストラテジー', 'Research model for viewing')}>{RESEARCH_MODELS.map((item) => <option key={item.id} value={item.id}>{language === 'zh' ? `查看：${item.zh}` : language === 'ja' ? `閲覧：${item.ja}` : `View: ${item.en}`}</option>)}</select>
                  <div>{(['M1', 'M5', 'M15'] as Timeframe[]).map((item) => <button key={item} className={item === timeframe ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}</div>
                </div>
                <div className="signal-state"><strong>{direction}</strong></div>
                <div className="confidence"><span style={{ width: `${signal.score}%` }} /><p>{primary('信号强度', 'シグナル強度', 'Signal strength')} {signal.score}</p></div>
                <ul>
                  <li><span>{primary('自主模型', '自律モデル', 'Autonomous model')}</span><b>{modelLabel}</b></li>
                  <li><span>{timeframe} {primary('趋势', 'トレンド', 'trend')}</span><b className={signal.trend === 'bullish' ? 'positive' : signal.trend === 'bearish' ? 'negative' : ''}>{signal.trend === 'bullish' ? primary('偏多', '上向き', 'Bullish') : signal.trend === 'bearish' ? primary('偏空', '下向き', 'Bearish') : primary('中性', '中立', 'Neutral')}</b></li>
                  <li><span>{primary('动量', 'モメンタム', 'Momentum')}</span><b>{signal.momentum === 'neutral' ? primary('中性', '中立', 'Neutral') : signal.momentum === 'bullish' ? primary('增强', '強含み', 'Strengthening') : primary('减弱', '弱含み', 'Weakening')}</b></li>
                  <li><span>{primary('信号条件', 'シグナル条件', 'Signal condition')}</span><b>{signal.direction === 'wait' ? primary('未满足', '未成立', 'Not met') : primary('已满足，待确认', '成立・確認待ち', 'Met; awaiting confirmation')}</b></li>
                  <li><span>{primary('点差状态', 'スプレッド', 'Spread')}</span><b className={quote.spreadPips <= risk.maxSpreadPips ? 'positive' : 'negative'}>{quote.spreadPips.toFixed(1)} pips</b></li>
                </ul>
                <p className="signal-note">{primary(`等待${timeframe}收盘确认，不在未完成K线上触发交易。`, `${timeframe}足の確定を待機中。未確定足では取引しません。`, `Wait for the ${timeframe} close; no action is taken on an unfinished bar.`)}</p>
                <code>{signal.strategyVersion}</code>
              </article>

              <EventPlanner language={language} timeZone={displayTimeZone} />
            </aside>
          </div>

          <div className="bottom-grid" id="risk">
            <article><p>{primary('数据桥', 'データブリッジ', 'Data bridge')}</p><strong className={bridgeState === 'live' ? 'positive' : ''}>{bridgeState === 'live' ? primary('只读在线', '読取オンライン', 'Read-only online') : primary('等待MT4', 'MT4待機', 'Waiting for MT4')}</strong><small>{bridgeState === 'live' ? `${mt4Snapshot?.quotes?.length ?? 1} ${primary('个货币对', '通貨ペア', 'pairs')} · ${Math.round((mt4Snapshot?.age_ms ?? 0) / 1000)}s` : primary('不含下单接口', '注文機能なし', 'No order interface')}</small></article>
            <article><p>{primary('今日风险', '本日のリスク', 'Today’s risk')}</p><strong>0.00%</strong><small>{primary('限额', '上限', 'Limit')} {risk.dailyLossLimitPct.toFixed(2)}%</small></article>
            <article><p>{primary('当前持仓', '保有ポジション', 'Open positions')}</p><strong>0</strong><small>{primary('最大', '最大', 'Maximum')} {risk.maxOpenPositions}</small></article>
            <article><p>{primary('历史数据', '履歴データ', 'History')}</p><strong className={usingBridgeHistory ? 'positive' : ''}>{usingBridgeHistory ? `MT4 ${timeframe}` : primary('正在准备', '準備中', 'Preparing')}</strong><small>{mt4History ? `${mt4History.total_bars.toLocaleString()} ${primary('根K线', '本', 'bars')}` : primary('新版模块会依次生成全部周期', '新版モジュールが全時間足を順次作成', 'All timeframes are being prepared')}</small></article>
          </div>
          <details className="secondary-panel-collapse">
            <summary>{primary('数据质量与历史范围', 'データ品質と履歴範囲', 'Data quality & history range')}</summary>
            <DataHealthPanel language={language} symbol={symbol} timeframe={timeframe} snapshot={mt4Snapshot} history={mt4History} coverage={mt4Coverage} bridgeState={bridgeState} displayTimeZone={displayTimeZone} />
          </details>
          </>}
          {activeView === 'backtest' && <BacktestPanel language={language} symbol={symbol} timeframe={timeframe} risk={risk} bridgeHistory={usingBridgeHistory ? mt4History?.bars ?? null : null} bridgeHistoryTotal={mt4History?.total_bars ?? 0} onTimeframeChange={setTimeframe} displayTimeZone={displayTimeZone} researchModel={researchModel} onResearchModelChange={setResearchModel} />}
          {activeView === 'demo' && <DemoExecutionPanel language={language} quote={quote} risk={risk} />}
          {activeView === 'models' && <ModelLab language={language} model={researchModel} onModelChange={setResearchModel} bars={bars} symbol={symbol} timeframe={timeframe} sourceReady={usingBridgeHistory} displayTimeZone={displayTimeZone} autonomous={{ enabled: adaptiveState.enabled, selectedModel: adaptiveState.selectedModel, rows: ['M1', 'M5', 'M15'].map((tf) => { const d = adaptiveState.timeframeDecisions[tf as 'M1' | 'M5' | 'M15']; const def = modelDefinition(d?.selectedModel ?? adaptiveState.selectedModel); return { tf, modelName: modelName(def, language) }; }) }} />}
          {activeView === 'tournament' && <StrategyTournament language={language} timeframe={timeframe} risk={risk} activeModel={researchModel} onModelChange={setResearchModel} displayTimeZone={displayTimeZone} />}
          {activeView === 'forward' && <ForwardValidation language={language} quote={quote} bars={bars} symbol={symbol} timeframe={timeframe} historyReady={usingBridgeHistory} activeModel={researchModel} onModelChange={setResearchModel} displayTimeZone={displayTimeZone} />}
          {activeView === 'adaptive' && <AdaptiveResearchPanel language={language} state={adaptiveState} onStateChange={setAdaptiveState} activeModel={researchModel} displayTimeZone={displayTimeZone} />}
          {activeView === 'marketResearch' && <MarketResearchPanel key={language} language={language} activeSymbol={symbol} />}
          {activeView === 'learning' && <AiLearningCenter language={language} />}
          {activeView === 'dataHealth' && <DataHealthPanel language={language} symbol={symbol} timeframe={timeframe} snapshot={mt4Snapshot} history={mt4History} coverage={mt4Coverage} bridgeState={bridgeState} displayTimeZone={displayTimeZone} />}
          {activeView === 'terminal' && <AiTerminalConsole language={language} symbol={symbol} displayTimeZone={displayTimeZone} />}
          {activeView === 'live' && <LiveTradingPanel language={language} snapshot={mt4Snapshot} adaptiveState={adaptiveState} risk={risk} onApplyRisk={(value) => saveRisk(value)} />}
          {activeView === 'settings' && <RiskPreferencesPanel language={language} setLanguage={setLanguage} risk={risk} updateRisk={updateRisk} saveRisk={saveRisk} riskSaving={riskSaving} displayTimeZone={displayTimeZone} setDisplayTimeZone={setDisplayTimeZone} onReopenWelcome={() => setShowWelcome(true)} symbol={symbol} />}
          {activeView === 'manual' && <ManualView language={language} />}
          {activeView === 'operations' && <OperationsPanel language={language} risk={risk} symbol={symbol} timeframe={timeframe} model={researchModel} bridgeLive={bridgeState === 'live' && hasLiveQuote} historyReady={usingBridgeHistory} displayTimeZone={displayTimeZone} onRestore={(preferences) => { setRisk(preferences.risk); setSymbol(preferences.symbol); setTimeframe(preferences.timeframe); setResearchModel(preferences.model); }} />}
          <DemoAutomationPanel language={language} snapshot={mt4Snapshot} visible={activeView === 'demo'} adaptiveState={adaptiveState} displayTimeZone={displayTimeZone} />
        </section>
      </div>
      <AdaptiveResearchEngine risk={risk} onStateChange={setAdaptiveState} />

      {showWelcome && (
        <FirstRunWelcome
          initialLanguage={language}
          initialTimeZone={displayTimeZone}
          onFinish={(nextLanguage, nextTimeZone) => {
            setLanguage(nextLanguage);
            setDisplayTimeZone(nextTimeZone);
            window.localStorage.setItem('enkei-welcome-done', new Date().toISOString());
            setShowWelcome(false);
          }}
        />
      )}

      {showRisk && (
        <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={primary('风险设置', 'リスク設定', 'Risk settings')}>
          <button className="drawer-scrim" aria-label={primary('关闭设置', '設定を閉じる', 'Close settings')} onClick={() => setShowRisk(false)} />
          <aside className="risk-drawer">
            <div className="drawer-heading">
              <div><p className="eyebrow">SAFETY CONTROLS</p><h3>{primary('风险设置', 'リスク設定', 'Risk settings')}</h3></div>
              <button onClick={() => setShowRisk(false)} aria-label={primary('关闭', '閉じる', 'Close')}>×</button>
            </div>
            <div className="safety-note"><b>{primary('演示阶段', 'デモ段階', 'Demo stage')}</b><p>{primary('设置仅保存在这台设备，不会触发任何订单。', '設定はこの端末にのみ保存され、注文は送信されません。', 'Settings are saved on this device only and never trigger orders.')}</p></div>
            <label><span>{primary('单笔风险', '1取引リスク', 'Risk per trade')}</span><b>{risk.riskPerTradePct.toFixed(2)}%</b><input type="range" min="0.05" max="1" step="0.05" value={risk.riskPerTradePct} onChange={(event) => updateRisk('riskPerTradePct', Number(event.target.value))} /></label>
            <label><span>{primary('单日亏损上限', '日次損失上限', 'Daily loss cap')}</span><b>{risk.dailyLossLimitPct.toFixed(2)}%</b><input type="range" min="0.25" max="5" step="0.25" value={risk.dailyLossLimitPct} onChange={(event) => updateRisk('dailyLossLimitPct', Number(event.target.value))} /></label>
            <label><span>{primary('最大同时持仓', '最大同時保有数', 'Max open positions')}</span><b>{risk.maxOpenPositions}</b><input type="range" min="1" max="10" step="1" value={risk.maxOpenPositions} onChange={(event) => updateRisk('maxOpenPositions', Number(event.target.value))} /></label>
            <label><span>{primary('最大点差', '最大スプレッド', 'Max spread')}</span><b>{risk.maxSpreadPips.toFixed(1)} pips</b><input type="range" min="0.5" max="8" step="0.1" value={risk.maxSpreadPips} onChange={(event) => updateRisk('maxSpreadPips', Number(event.target.value))} /></label>
            <label><span>{primary('事件暂停时间', 'イベント停止時間', 'Event pause')}</span><b>{risk.eventPauseMinutes} min</b><input type="range" min="0" max="120" step="5" value={risk.eventPauseMinutes} onChange={(event) => updateRisk('eventPauseMinutes', Number(event.target.value))} /></label>
            <div className="hard-rule"><span>✓</span><p><b>{primary('止损为强制规则', 'ストップロス必須', 'Stop loss is mandatory')}</b><small>{primary('真实交易中不能关闭', '実取引では無効化できません', 'Cannot be disabled in live trading')}</small></p></div>
            <button className="save-risk" onClick={() => saveRisk()} disabled={riskSaving}>{savedNotice ? primary('已保存', '保存しました', 'Saved') : primary('保存到本机', '端末に保存', 'Save locally')}</button>
          </aside>
        </div>
      )}
    </main>
  );
}

// 设置组"风险与偏好"：与总览风险抽屉共用同一套数据与校验；偏好只存本机。
function RiskPreferencesPanel({ language, setLanguage, risk, updateRisk, saveRisk, riskSaving, displayTimeZone, setDisplayTimeZone, onReopenWelcome, symbol }: {
  language: Language;
  setLanguage: (lang: Language) => void;
  risk: RiskConfig;
  updateRisk: (key: keyof RiskConfig, value: number) => void;
  saveRisk: (nextRisk?: RiskConfig) => void;
  riskSaving: boolean;
  displayTimeZone: DisplayTimeZone;
  setDisplayTimeZone: (zone: DisplayTimeZone) => void;
  onReopenWelcome: () => void;
  symbol: PairSymbol;
}) {
  const primary = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  // 批C：AI 推荐参数——本地算法（离线）与大模型（统一分析体）双通道，用户自主选择。
  const [recTab, setRecTab] = useState<'local' | 'ai'>('local');
  const [recBusy, setRecBusy] = useState(false);
  const [recResult, setRecResult] = useState<{ risk: number; stopAtr: number; spread: number; reason: string } | null>(null);
  const [recError, setRecError] = useState('');

  const atrPips = (bars: Array<{ high: number; low: number; close: number }>) => {
    if (bars.length < 16) return null;
    const pip = symbol.includes('JPY') ? 0.01 : 0.0001;
    let sum = 0;
    for (let i = bars.length - 14; i < bars.length; i += 1) {
      const prevClose = bars[i - 1].close;
      sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
    }
    return (sum / 14) / pip;
  };

  const ema = (values: number[], period: number) => {
    if (values.length === 0) return 0;
    const multiplier = 2 / (period + 1);
    return values.slice(1).reduce((value, current) => current * multiplier + value * (1 - multiplier), values[0]);
  };

  const recommendLocal = async () => {
    setRecBusy(true); setRecError('');
    try {
      const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(symbol)}&timeframe=H1&limit=300`, { cache: 'no-store' });
      if (!response.ok) throw new Error('bridge');
      const data = await response.json() as { bars?: Array<{ time: number; open: number; high: number; low: number; close: number }> };
      const bars = (data.bars ?? []).slice(-120);
      const atr = atrPips(bars);
      if (atr === null || !Number.isFinite(atr) || atr <= 0) throw new Error('no-data');
      // 固定风控公式（可解释）：波动越高 → 单笔风险越低、止损 ATR 倍数越大
      const highVol = atr > 25;
      const midVol = atr > 12 && atr <= 25;
      const recRisk = highVol ? 0.15 : midVol ? 0.25 : 0.35;
      const recStop = highVol ? 2.4 : midVol ? 2.0 : 1.6;
      const recSpread = Math.max(0.5, Math.min(3, Math.ceil(atr / 12 * 2) / 2));
      const reason = primary(
        `近 14 根 H1 的 ATR ≈ ${atr.toFixed(1)} pips（${highVol ? '偏高' : midVol ? '中等' : '偏低'}）→ 建议单笔风险 ${recRisk.toFixed(2)}%、止损 ${recStop.toFixed(1)}×ATR、点差上限 ${recSpread}。`,
        `直近14本のH1 ATR≈${atr.toFixed(1)}pips（${highVol ? '高め' : midVol ? '中程度' : '低め'}）→ リスク${recRisk.toFixed(2)}%・ストップ${recStop.toFixed(1)}×ATR・スプレッド上限${recSpread}を推奨。`,
        `Last 14 H1 ATR ≈ ${atr.toFixed(1)} pips (${highVol ? 'high' : midVol ? 'medium' : 'low'}) → suggest risk ${recRisk.toFixed(2)}%, stop ${recStop.toFixed(1)}×ATR, max spread ${recSpread}.`,
      );
      setRecResult({ risk: recRisk, stopAtr: recStop, spread: recSpread, reason });
    } catch { setRecError(primary('历史数据不可用，无法计算推荐。', '履歴データが利用できません。', 'History data unavailable; cannot compute.')); }
    setRecBusy(false);
  };

  const recommendAi = async () => {
    setRecBusy(true); setRecError('');
    try {
      // 走统一分析体链路：提交当前行情摘要 → 读取最新政策（含 market_regime 与理由）
      const [historyResponse, snapshotResponse] = await Promise.all([
        fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(symbol)}&timeframe=M15&limit=60`, { cache: 'no-store' }),
        fetch('http://127.0.0.1:8788/api/snapshot', { cache: 'no-store' }),
      ]);
      if (!historyResponse.ok || !snapshotResponse.ok) throw new Error('bridge');
      const history = await historyResponse.json() as Mt4HistorySnapshot;
      const snapshot = await snapshotResponse.json() as Mt4QuoteSnapshot;
      const bars = history.bars ?? [];
      const quote = (snapshot.quotes ?? []).find((q) => q.symbol === symbol.replace('/', ''));
      const quoteReceivedAt = snapshotReceivedAt(snapshot);
      const quoteTime = Date.parse(quoteReceivedAt);
      const correctMarket = history.symbol === symbol.replace('/', '') && history.timeframe === 'M15';
      const freshQuote = Number.isFinite(quoteTime) && snapshot.age_ms <= 10_000 && snapshot.clock_status !== 'unresolved';
      if (!quote || bars.length < 20 || !correctMarket || !freshQuote || history.clock?.status === 'unresolved') throw new Error('no-fresh-data');
      const now = new Date();
      const closes = bars.map((bar) => bar.close);
      const packet = {
        version: 'enkei-market-summary/v1',
        language,
        generated_at: now.toISOString(),
        symbol: symbol.replace('/', ''),
        timeframe: 'M15',
        quote: { bid: quote.bid, ask: quote.ask, spread_pips: Number(((quote.ask - quote.bid) / (quote.digits === 3 ? 0.01 : 0.0001)).toFixed(1)), received_at: quoteReceivedAt },
        features: { ema_fast: ema(closes, 20), ema_slow: ema(closes, 50), momentum: bars[bars.length - 1].close - bars[Math.max(0, bars.length - 6)].close, recent_high: Math.max(...bars.slice(-20).map((b) => b.high)), recent_low: Math.min(...bars.slice(-20).map((b) => b.low)), range_pips: Math.round((Math.max(...bars.slice(-20).map((b) => b.high)) - Math.min(...bars.slice(-20).map((b) => b.low))) / (symbol.includes('JPY') ? 0.01 : 0.0001)) },
        bars: bars.slice(-20).map((bar) => ({ time: new Date(bar.time * 1000).toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
        execution_context: { selected_rule_model: 'ema-cross', positions: [], previous_policy: null },
      };
      type PolicyLike = { policy_id?: string; generated_at?: string; market_regime?: string; action_bias?: string; confidence?: number; rationale_zh?: string };
      const policyUrl = `http://127.0.0.1:8710/v1/policies/current?symbol=${symbol.replace('/', '')}&timeframe=M15`;
      const previousResponse = await fetch(policyUrl, { cache: 'no-store' });
      const previousPolicy = previousResponse.ok ? await previousResponse.json() as PolicyLike : null;
      const submit = await fetch('http://127.0.0.1:8710/v1/assessments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(packet),
      });
      if (!submit.ok) {
        const detail = await submit.json().catch(() => ({})) as { detail?: { details?: string[] } | string };
        const text = typeof detail.detail === 'string' ? detail.detail : Array.isArray(detail.detail?.details) ? detail.detail.details.join('; ') : `HTTP ${submit.status}`;
        throw new Error(text);
      }
      // 政策由调度器异步产出；轮询最多 40 秒
      let policy: PolicyLike | null = null;
      for (let attempt = 0; attempt < 20 && !policy; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const poll = await fetch(policyUrl, { cache: 'no-store' });
        if (poll.ok) {
          const candidate = await poll.json() as PolicyLike;
          const changed = !previousPolicy?.policy_id || candidate.policy_id !== previousPolicy.policy_id;
          const generated = candidate.generated_at ? Date.parse(candidate.generated_at) : NaN;
          if (changed && Number.isFinite(generated) && generated >= now.getTime() - 1_000) policy = candidate;
        }
      }
      if (!policy) throw new Error(primary('评估仍在进行，稍后可在此查看。', '評価は進行中です。', 'Evaluation still running; check back shortly.'));
      const regime = policy.market_regime ?? 'uncertain';
      const recRisk = regime === 'volatile' ? 0.15 : regime === 'trend' ? 0.30 : 0.25;
      const recStop = regime === 'volatile' ? 2.4 : regime === 'trend' ? 2.0 : 1.6;
      const reason = primary(
        `统一分析体判断市场状态为「${regime}」（置信度 ${policy.confidence ?? '—'}%）：${policy.rationale_zh ?? ''} → 建议单笔风险 ${recRisk.toFixed(2)}%、止损 ${recStop.toFixed(1)}×ATR。`,
        `統合分析体の判断：市場状態「${regime}」（信頼度${policy.confidence ?? '—'}%）→ リスク${recRisk.toFixed(2)}%・ストップ${recStop.toFixed(1)}×ATR を推奨。`,
        `Unified analysis: regime "${regime}" (confidence ${policy.confidence ?? '—'}%) → suggest risk ${recRisk.toFixed(2)}%, stop ${recStop.toFixed(1)}×ATR.`,
      );
      setRecResult({ risk: recRisk, stopAtr: recStop, spread: risk.maxSpreadPips, reason });
    } catch (error) {
      setRecError(error instanceof Error && error.message !== 'bridge' && error.message !== 'no-fresh-data'
        ? `${primary('评估未完成', '評価未完了', 'evaluation incomplete')}: ${error.message}`
        : primary('当前无新鲜行情（休市或未校准），大模型推荐不可用——可用"本地算法"离线推荐。', '新鮮な行情なし（休市・未補正）。ローカル算法をご利用ください。', 'No fresh market data (closed/uncalibrated) — use the local algorithm instead.'));
    }
    setRecBusy(false);
  };

  return (
    <div className="settings-panel">
      <section className="settings-card">
        <p className="eyebrow">AI RECOMMENDATION</p>
        <h3>{primary('AI 推荐参数', 'AI推奨パラメーター', 'AI-recommended parameters')}</h3>
        <div className="rec-tabs">
          <button className={recTab === 'local' ? 'active' : ''} onClick={() => setRecTab('local')}>{primary('本地算法（离线）', 'ローカル算法（オフライン）', 'Local algorithm (offline)')}</button>
          <button className={recTab === 'ai' ? 'active' : ''} onClick={() => setRecTab('ai')}>{primary('大模型评估', '大モデル評価', 'LLM evaluation')}</button>
        </div>
        {recTab === 'ai' && <small>{primary('通过统一分析体评估当前行情（需新鲜数据与已配置的模型额度）。', '統合分析体で現在の行情を評価（新鮮なデータとモデル設定が必要）。', 'Evaluates current market via the unified analysis entity (needs fresh data and a configured model).')}</small>}
        {recTab === 'local' && <small>{primary('基于当前币对 H1 真实历史的 ATR/波动率，按固定风控公式推荐——离线可用、完全可解释。', '現在の通貨ペアのH1履歴のATR/ボラから固定式で推奨。オフライン可・完全説明可能。', 'ATR/volatility from real H1 history, fixed risk formula — offline and fully explainable.')}</small>}
        {recBusy ? <b className="rec-busy">{primary('计算中…', '計算中…', 'computing…')}</b> : (
          <button className="primary-btn" onClick={() => recTab === 'local' ? void recommendLocal() : void recommendAi()}>{primary('生成推荐', '推奨を生成', 'Generate recommendation')}</button>
        )}
        {recError && <p className="rec-error">{recError}</p>}
        {recResult && !recBusy && <>
          <div className="rec-result">
            <div><span>{primary('单笔风险', '1取引リスク', 'Risk/trade')}</span><b>{recResult.risk.toFixed(2)}%</b></div>
            <div><span>{primary('止损 ATR', 'ストップ ATR', 'Stop ATR')}</span><b>{recResult.stopAtr.toFixed(1)}</b></div>
            <div><span>{primary('最大点差', '最大スプレッド', 'Max spread')}</span><b>{recResult.spread.toFixed(1)}</b></div>
          </div>
          <small className="rec-reason">{recResult.reason}</small>
          <button className="save-risk" onClick={() => saveRisk({ ...risk, riskPerTradePct: recResult.risk, maxSpreadPips: recResult.spread })}>{primary('应用风险项并保存（止损 ATR 在回测页）', 'リスク項を適用（ストップATRは検証ページ）', 'Apply risk items (stop ATR on Backtest page)')}</button>
        </>}
      </section>
      <section className="settings-card">
        <p className="eyebrow">SAFETY CONTROLS</p>
        <h3>{primary('风险参数', 'リスクパラメーター', 'Risk parameters')}</h3>
        <p>{primary('设置仅保存在这台设备，不会触发任何订单。', '設定はこの端末にのみ保存され、注文は送信されません。', 'Settings are saved on this device only and never trigger orders.')}</p>
        <label><span>{primary('单笔风险', '1取引リスク', 'Risk per trade')}</span><b>{risk.riskPerTradePct.toFixed(2)}%</b><input type="range" min="0.05" max="1" step="0.05" value={risk.riskPerTradePct} onChange={(event) => updateRisk('riskPerTradePct', Number(event.target.value))} /></label>
        <label><span>{primary('单日亏损上限', '日次損失上限', 'Daily loss cap')}</span><b>{risk.dailyLossLimitPct.toFixed(2)}%</b><input type="range" min="0.25" max="5" step="0.25" value={risk.dailyLossLimitPct} onChange={(event) => updateRisk('dailyLossLimitPct', Number(event.target.value))} /></label>
        <label><span>{primary('最大同时持仓', '最大同時保有数', 'Max open positions')}</span><b>{risk.maxOpenPositions}</b><input type="range" min="1" max="10" step="1" value={risk.maxOpenPositions} onChange={(event) => updateRisk('maxOpenPositions', Number(event.target.value))} /></label>
        <label><span>{primary('最大点差', '最大スプレッド', 'Max spread')}</span><b>{risk.maxSpreadPips.toFixed(1)} pips</b><input type="range" min="0.5" max="8" step="0.1" value={risk.maxSpreadPips} onChange={(event) => updateRisk('maxSpreadPips', Number(event.target.value))} /></label>
        <label><span>{primary('事件暂停时间', 'イベント停止時間', 'Event pause')}</span><b>{risk.eventPauseMinutes} min</b><input type="range" min="0" max="120" step="5" value={risk.eventPauseMinutes} onChange={(event) => updateRisk('eventPauseMinutes', Number(event.target.value))} /></label>
        <div className="hard-rule"><span>✓</span><p><b>{primary('止损为强制规则', 'ストップロス必須', 'Stop loss is mandatory')}</b><small>{primary('真实交易中不能关闭', '実取引では無効化できません', 'Cannot be disabled in live trading')}</small></p></div>
        <button className="save-risk" onClick={() => saveRisk()} disabled={riskSaving}>{primary('保存到本机', '端末に保存', 'Save locally')}</button>
      </section>
      <section className="settings-card">
        <p className="eyebrow">PREFERENCES</p>
        <h3>{primary('显示偏好', '表示設定', 'Display preferences')}</h3>
        <label><span>{primary('界面语言（长期记忆）', '表示言語（端末に記憶）', 'UI language (remembered)')}</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as Language)} aria-label={primary('选择语言', '言語を選択', 'Select language')}>
            <option value="zh">中文</option><option value="ja">日本語</option><option value="en">English</option>
          </select>
        </label>
        <label><span>{primary('显示时区（长期记忆）', '表示タイムゾーン（端末に記憶）', 'Display time zone (remembered)')}</span>
          <select value={displayTimeZone} onChange={(event) => setDisplayTimeZone(event.target.value as DisplayTimeZone)} aria-label={primary('选择显示时区', '表示タイムゾーンを選択', 'Select display time zone')}>
            {DISPLAY_TIME_ZONES.map((zone) => <option key={zone.id} value={zone.id}>{navLabel(zone, language)}</option>)}
          </select>
        </label>
        <small>{primary('首次启动引导的选择也保存在这里；可随时回来修改。', '初回ガイドでの選択もここに保存され、いつでも変更できます。', 'The first-run guide stores its choices here; come back any time to change them.')}</small>
        <button className="plain" onClick={onReopenWelcome}>{primary('重新打开首次启动引导', '初回ガイドをもう一度表示', 'Reopen the first-run guide')}</button>
      </section>
      <section className="settings-card">
        <p className="eyebrow">ABOUT</p>
        <h3>{primary('关于', 'このアプリについて', 'About')}</h3>
        <p>円衡 FX（Enkei FX） v{APP_VERSION}</p>
        <small>{primary('本地优先 · 只读行情 · 实盘默认锁定。仓库与文档见 README。', 'ローカル優先・読み取り専用レート・実取引は既定ロック。詳細はREADME参照。', 'Local-first · read-only quotes · live locked by default. See README for the repository.')}</small>
      </section>
    </div>
  );
}
