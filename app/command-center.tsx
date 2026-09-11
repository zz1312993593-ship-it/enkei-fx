'use client';

// 批S：全屏交易控制台（总控台）。
// 顶栏状态条 + 左轨品种 + 中央暗色K线 + 右列风险/入口 + 底部信号条/新闻。
// 上下文感知监控面板：有持仓/急停时展开（持仓表+当前AI判断+紧急停止），空仓收起为一行。
// 数据全部来自本机服务；无下单入口（监控与急停除外）。
import { useEffect, useMemo, useState } from 'react';
import FxChart from './fx-chart';
import { buildResearchSignal } from '../lib/research-signal';
import { RESEARCH_MODELS, modelName } from '../lib/model-catalog';
import type { OhlcBar, PairSymbol, RiskConfig, Timeframe } from '../lib/market-data';
import type { Mt4HistorySnapshot, Mt4QuoteSnapshot } from '../lib/mt4-bridge';
import { accentColor, type ThemeAccent } from '../lib/theme';
import { resolveAiTerminalUrl } from '../lib/ai-terminal';

type Language = 'zh' | 'ja' | 'en';
const WALL_TFS = ['M15', 'H1', 'H4'] as const;
const CHART_TFS: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
// 新闻相关词表（与后端 news.py 的 PAIR_KEYWORDS/MACRO_TERMS 同源思想）
const NEWS_KEYWORDS = ['usd', 'dollar', 'yen', 'jpy', 'eur', 'euro', 'ecb', 'gbp', 'pound', 'sterling', 'boe', 'aud', 'rba', 'chf', 'franc', 'cad', 'nzd', 'boj', 'fed', 'fomc', 'inflation', 'cpi', 'interest rate', 'rate hike', 'rate cut', 'gdp', 'jobs report', 'nonfarm', 'unemployment', 'forex', 'currency', 'central bank', '央行', '加息', '降息', '通胀', '非农', '利率', '议息', '日元', '美元', '欧元', '外汇'];

interface DemoPosition {
  ticket: number; symbol: string; side: 'long' | 'short' | string; lots: number;
  open_price: number; current_price: number; stop_loss: number; take_profit: number;
  profit: number; swap: number; commission: number;
}
interface GateStatus {
  status?: string; killed?: boolean; pending?: boolean; close_pending?: boolean;
  demo_positions?: DemoPosition[];
  demo_positions_updated_at?: string | null;
}

export default function CommandCenter({
  language, quotes, symbol, onSelectSymbol, risk, accent, onOpenView,
}: {
  language: Language;
  quotes: Mt4QuoteSnapshot | null;
  symbol: PairSymbol;
  onSelectSymbol: (symbol: PairSymbol) => void;
  risk: RiskConfig;
  accent: ThemeAccent;
  onOpenView: (view: 'operations' | 'live' | 'demo' | 'marketResearch' | 'learning' | 'overview') => void;
}) {
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const accentVar = { '--cc': accentColor(accent) } as React.CSSProperties;
  const [leaving, setLeaving] = useState(false);
  const [demoSettings, setDemoSettings] = useState({ minimumScore: 55, cooldownMinutes: 0, maxPositions: 3, maxSpreadPips: 3 });
  const leaveConsole = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => onOpenView('overview'), 50);
  };

  useEffect(() => {
    const load = () => {
      try {
        const saved = JSON.parse(window.localStorage.getItem('enkei-demo-automation-session') ?? '{}') as Partial<typeof demoSettings>;
        setDemoSettings((current) => ({ ...current, ...saved }));
      } catch { /* Preserve safe defaults if a legacy value is malformed. */ }
    };
    load();
    const timer = window.setInterval(load, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  // ---- 左轨行情 ----
  const quoteRows = useMemo(() => (quotes?.quotes ?? []).map((q) => ({
    symbol: q.symbol as PairSymbol,
    bid: q.bid,
    ask: q.ask,
    spread: Number(((q.ask - q.bid) / (q.symbol.includes('JPY') ? 0.01 : 0.0001)).toFixed(1)),
    digits: q.digits,
  })), [quotes]);
  const ageSeconds = quotes ? Math.max(0, Math.round(quotes.age_ms / 1000)) : null;

  // ---- 主图（自取历史 + 周期切换）----
  const [chartTf, setChartTf] = useState<Timeframe>('H1');
  const chartKey = `${symbol}:${chartTf}`;
  const [chartResult, setChartResult] = useState<{ key: string; bars: OhlcBar[]; state: 'ready' | 'unavailable' } | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(symbol.replace('/', ''))}&timeframe=${chartTf}&limit=3000`, { cache: 'no-store' });
        if (!response.ok) throw new Error('bridge');
        const data = await response.json() as Mt4HistorySnapshot;
        const valid = data.symbol === symbol.replace('/', '') && data.timeframe === chartTf
          && data.source === 'mt4-local-history-read-only'
          && data.clock?.status !== 'unresolved'
          && Array.isArray(data.bars) && data.bars.length > 0;
        if (active) setChartResult({ key: chartKey, bars: valid ? data.bars : [], state: valid ? 'ready' : 'unavailable' });
      } catch { if (active) setChartResult({ key: chartKey, bars: [], state: 'unavailable' }); }
    };
    void load();
    // The 3,000-bar chart is much heavier than the quote stream and only
    // changes when a candle advances, so do not retransmit it every 2 seconds.
    const timer = window.setInterval(load, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol, chartTf, chartKey]);
  const activeChart = chartResult?.key === chartKey ? chartResult : null;
  const activeQuote = quoteRows.find((row) => row.symbol === symbol) ?? null;
  const quoteTimestamp = Number(quotes?.gmt_epoch) > 0 ? Number(quotes?.gmt_epoch) * 1000 : 0;
  const liveQuote = activeQuote && quotes ? { bid: activeQuote.bid, ask: activeQuote.ask, at: Number.isFinite(quoteTimestamp) ? quoteTimestamp : 0 } : null;

  // ---- 实盘网关状态（8791，status 端点免鉴权；操作需会话配对码）----
  const [tradeMode, setTradeMode] = useState<'demo' | 'live'>('demo');
  const [liveGate, setLiveGate] = useState<{
    enabled: boolean; live_trading: boolean; killed: boolean; kill_reason: string | null; close_pending?: boolean;
    broker_name: string; account_number: string;
    realized_loss: number; loss_limit: number; entries: number;
    live_positions: Array<{ ticket: number; symbol: string; side: string; lots: number; open_price: number; current_price: number; profit: number }>;
    live_account: { balance?: number; equity?: number } | null;
    live_account_updated_at: string | null;
    live?: { live_trading?: boolean; env_marker?: string; broker_name?: string; account_number?: string; enabled_at?: string } | null;
    daily_budget?: { realized_loss?: number; entries?: number; limit?: number } | null;
  } | null>(null);
  const [livePaired, setLivePaired] = useState(false);
  useEffect(() => {
    if (tradeMode !== 'live') return;
    let active = true;
    const load = async () => {
      const verified = window.sessionStorage.getItem('enkei-live-gate-pairing-verified') === 'true';
      setLivePaired(verified);
      try {
        const response = await fetch('http://127.0.0.1:8791/api/status', { cache: 'no-store' });
        if (active) setLiveGate(response.ok ? await response.json() as never : null);
      } catch { if (active) setLiveGate(null); }
    };
    void load();
    const timer = window.setInterval(load, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tradeMode]);
  const liveEmergency = async () => {
    if (!livePaired || killBusy) return;
    setKillBusy(true);
    try {
      const code = window.sessionStorage.getItem('enkei-live-gate-pairing-code') ?? '';
      const response = await fetch('http://127.0.0.1:8791/api/kill', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Live-Code': code } });
      setKillNotice(response.ok ? t('实盘急停已激活。', '実取引緊急停止を有効化しました。', 'Live emergency stop activated.') : `${t('急停失败', '緊急停止失敗', 'Kill failed')} HTTP ${response.status}`);
    } catch { setKillNotice(t('急停请求失败：服务不可达。', '接続不可。', 'Kill request failed.')); }
    setKillBusy(false);
  };

  // ---- 上下文监控：Demo 网关仓位（2 秒回传）----
  const [gate, setGate] = useState<GateStatus | null>(null);
  const [paired, setPaired] = useState(false);
  const [killNotice, setKillNotice] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      const verified = window.sessionStorage.getItem('enkei-demo-gate-pairing-verified') === 'true';
      const code = window.sessionStorage.getItem('enkei-demo-gate-pairing-code') ?? '';
      setPaired(verified);
      try {
        const response = await fetch('http://127.0.0.1:8790/api/status', { cache: 'no-store', headers: verified ? { 'X-Enkei-Demo-Code': code } : undefined });
        if (active) setGate(response.ok ? await response.json() as GateStatus : null);
      } catch { if (active) setGate(null); }
    };
    void load();
    const timer = window.setInterval(load, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const demoPositions = gate?.demo_positions ?? [];
  const demoPnl = demoPositions.reduce((sum, item) => sum + item.profit + item.swap + item.commission, 0);
  const demoLots = demoPositions.reduce((sum, item) => sum + item.lots, 0);
  const demoCostBasis = demoLots > 0
    ? demoPositions.reduce((sum, item) => sum + item.open_price * item.lots, 0) / demoLots
    : null;
  const livePositions = liveGate?.live_positions ?? [];
  const liveLots = livePositions.reduce((sum, item) => sum + item.lots, 0);
  const livePnl = livePositions.reduce((sum, item) => sum + item.profit, 0);
  const liveCostBasis = liveLots > 0
    ? livePositions.reduce((sum, item) => sum + item.open_price * item.lots, 0) / liveLots
    : null;

  // ---- 评估次数（AI 活跃度，终端台账）----
  const [evalEvents, setEvalEvents] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${resolveAiTerminalUrl()}/v1/ledger/summary`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { total_events?: number; total?: number };
        if (active) setEvalEvents(Number(data.total_events ?? data.total ?? 0) || 0);
      } catch { /* 静默 */ }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  // ---- 当前 AI 判断（M15 政策）----
  const [policy, setPolicy] = useState<{ action: string; confidence: number } | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${resolveAiTerminalUrl()}/v1/policies/current?symbol=${encodeURIComponent(symbol.replace('/', ''))}&timeframe=M15`, { cache: 'no-store' });
        if (!response.ok) { if (active) setPolicy(null); return; }
        const data = await response.json() as { action_bias?: unknown; confidence?: unknown };
        if (active && typeof data.action_bias === 'string') {
          setPolicy({ action: data.action_bias, confidence: typeof data.confidence === 'number' ? data.confidence : 0 });
        } else if (active) setPolicy(null);
      } catch { if (active) setPolicy(null); }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol]);

  // ---- 紧急停止 ----
  const [killBusy, setKillBusy] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [shutdownBusy, setShutdownBusy] = useState(false);
  const emergency = async () => {
    if (!paired || killBusy) return;
    setKillBusy(true);
    try {
      const code = window.sessionStorage.getItem('enkei-demo-gate-pairing-code') ?? '';
      const response = await fetch('http://127.0.0.1:8790/api/kill', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Demo-Code': code } });
      setKillNotice(response.ok ? t('急停已激活：所有待执行 Demo 指令被阻止。', '緊急停止を有効化しました。', 'Emergency stop activated.') : `${t('急停失败', '緊急停止失敗', 'Kill failed')} HTTP ${response.status}`);
    } catch { setKillNotice(t('急停请求失败：服务不可达。', '接続不可。', 'Kill request failed: service unreachable.')); }
    setKillBusy(false);
  };
  const closeDemoAll = async () => {
    if (!paired || closeBusy || !demoPositions.length) return;
    if (!window.confirm(t('确认立即平掉本 EA 的全部 Demo 持仓？', 'このEAのDemo保有をすべて直ちに決済しますか？', 'Close all Demo positions opened by this EA now?'))) return;
    setCloseBusy(true);
    try {
      const code = window.sessionStorage.getItem('enkei-demo-gate-pairing-code') ?? '';
      const response = await fetch('http://127.0.0.1:8790/api/close', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Demo-Code': code }, body: JSON.stringify({ ticket: 0, confirmation: 'DEMO' }) });
      setKillNotice(response.ok ? t('全部 Demo 平仓指令已提交，等待 MT4 回执。', 'Demo全決済指示を送信しました。', 'Close-all Demo request submitted.') : `${t('平仓失败', '決済失敗', 'Close failed')} HTTP ${response.status}`);
    } catch { setKillNotice(t('全部平仓失败：Demo 服务不可达。', 'Demoサービスに接続できません。', 'Close all failed: Demo service unreachable.')); }
    setCloseBusy(false);
  };
  const closeLiveAll = async () => {
    if (!livePaired || closeBusy || !liveGate?.live_positions?.length || !liveGate.live?.env_marker) return;
    if (!window.confirm(t('确认立即平掉本 EA 的全部实盘持仓？这会操作真实资金账户。', 'このEAの実取引保有をすべて決済しますか？ 実資金口座を操作します。', 'Close all live positions opened by this EA? This acts on a real-money account.'))) return;
    setCloseBusy(true);
    try {
      const code = window.sessionStorage.getItem('enkei-live-gate-pairing-code') ?? '';
      const response = await fetch('http://127.0.0.1:8791/api/close', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Live-Code': code }, body: JSON.stringify({ ticket: 0, confirmation: 'LIVE', envMarker: liveGate.live.env_marker }) });
      setKillNotice(response.ok ? t('全部实盘平仓指令已提交，等待 MT4 回执。', '実取引の全決済指示を送信しました。', 'Close-all live request submitted.') : `${t('平仓失败', '決済失敗', 'Close failed')} HTTP ${response.status}`);
    } catch { setKillNotice(t('全部平仓失败：实盘服务不可达。', '実取引サービスに接続できません。', 'Close all failed: live service unreachable.')); }
    setCloseBusy(false);
  };
  const shutdownApplication = async () => {
    if (shutdownBusy || !window.confirm(t('确认关闭圆衡应用及其全部受管进程？未平仓持仓不会自动改变。', '円衡アプリと管理対象プロセスをすべて終了しますか？ 保有ポジションは自動決済されません。', 'Close Enkei and all managed processes? Open positions will not be changed automatically.'))) return;
    setShutdownBusy(true);
    try {
      await fetch('http://127.0.0.1:8787/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      window.setTimeout(() => window.close(), 500);
    } catch { setKillNotice(t('无法连接本机控制中心，应用未关闭。', 'コントロールセンターに接続できず、終了できません。', 'The local controller is unreachable; Enkei was not closed.')); setShutdownBusy(false); }
  };

  const monitorOpen = tradeMode === 'demo'
    ? demoPositions.length > 0 || Boolean(gate?.killed)
    : livePositions.length > 0 || Boolean(liveGate?.killed);

  // ---- 信号条 / 健康 / 新闻 ----
  const [wallBars, setWallBars] = useState<Record<string, OhlcBar[]>>({});
  useEffect(() => {
    let active = true;
    const load = async () => {
      const next: Record<string, OhlcBar[]> = {};
      for (const tf of WALL_TFS) {
        try {
          const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&limit=260`, { cache: 'no-store' });
          if (!response.ok) continue;
          const data = await response.json() as { bars?: OhlcBar[] };
          if (Array.isArray(data.bars)) next[tf] = data.bars;
        } catch { /* 静默 */ }
      }
      if (active) setWallBars(next);
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [symbol]);
  const wall = useMemo(() => WALL_TFS.map((tf) => ({
    tf,
    cells: RESEARCH_MODELS.map((candidate) => {
      const bars = wallBars[tf];
      const signal = bars && bars.length >= 42 ? buildResearchSignal(bars, symbol, tf, candidate.id) : null;
      return { id: candidate.id, direction: signal?.direction ?? 'wait' };
    }),
  })), [wallBars, symbol]);
  const [health, setHealth] = useState<{ bridge: boolean; terminal: boolean; decision: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    const probe = async (url: string) => { try { const r = await fetch(url, { cache: 'no-store' }); return r.ok; } catch { return false; } };
    const load = async () => {
      const [bridge, terminal, decision] = await Promise.all([
        probe('http://127.0.0.1:8788/api/health'), probe(`${resolveAiTerminalUrl()}/health`), probe('http://127.0.0.1:8792/v1/health'),
      ]);
      if (active) setHealth({ bridge, terminal, decision });
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const [news, setNews] = useState<Array<{ display: string; published: string }>>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${resolveAiTerminalUrl()}/v1/news?limit=8`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as { items?: Array<Record<string, unknown>> };
        if (active && Array.isArray(data.items)) {
          // 严格过滤：只显示与 6 货币对或宏观相关的条目（词表与后端 news.py 同源思想）。
          const relevant = data.items.filter((item) => {
            const low = String(item.title ?? '').toLowerCase();
            return NEWS_KEYWORDS.some((word) => low.includes(word));
          });
          setNews(relevant.map((item) => ({ display: String(item.display_title ?? item.title ?? ''), published: String(item.published ?? '') })));
        }
      } catch { /* 静默 */ }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const dot = (ok: boolean | undefined) => `cc-dot ${ok ? 'on' : 'off'}`;
  const signalChip = (direction: string) => direction === 'long' ? 'cc-sig long' : direction === 'short' ? 'cc-sig short' : 'cc-sig wait';
  const signalText = (direction: string) => direction === 'long' ? t('多', 'ロング', 'L') : direction === 'short' ? t('空', 'ショート', 'S') : t('观', '待', 'W');
  const entries: Array<{ view: 'operations' | 'live' | 'demo' | 'marketResearch' | 'learning'; icon: string; label: string }> = [
    { view: 'demo', icon: '演', label: t('Demo 验证', 'Demo検証', 'Demo') },
    { view: 'live', icon: '锁', label: t('实盘连接', '実取引接続', 'Live link') },
    { view: 'operations', icon: '运', label: t('运营中心', '運用センター', 'Operations') },
    { view: 'marketResearch', icon: '踪', label: t('专项追踪', '特別追跡', 'Research tracks') },
    { view: 'learning', icon: '学', label: t('AI 学习中心', 'AI学習センター', 'AI learning') },
  ];

  return (
    <div className={`console ${leaving ? 'leaving' : ''}`} style={accentVar} data-accent={accent}>
      <header className="console-top">
        <div className="console-brand"><b>円</b><span>FX CONSOLE</span></div>
        <div className="console-stats">
          <span className={ageSeconds !== null && ageSeconds <= 10 ? 'ok' : 'warn'}>{t('数据', 'データ', 'DATA')} {ageSeconds === null ? '—' : `${ageSeconds}s`}</span>
          <i className={dot(!!health?.bridge)} title={t('行情桥', 'レート橋', 'bridge')} />
          <i className={dot(!!health?.terminal)} title={t('AI 终端', 'AIターミナル', 'terminal')} />
          <i className={dot(!!health?.decision)} title={t('决策服务', '決定サービス', 'decision')} />
        </div>
        <div className="console-top-actions">
          <button className="console-theme-btn" onClick={leaveConsole} disabled={leaving} title={t('切换到经典亮色界面', 'クラシック画面へ', 'Switch to classic UI')}>{leaving ? '…' : t('经典界面', 'クラシック', 'Classic')} ☀</button>
          <button className="console-shutdown" onClick={() => void shutdownApplication()} disabled={shutdownBusy}>{shutdownBusy ? t('正在关闭…', '終了中…', 'Closing…') : t('关闭应用', 'アプリ終了', 'Close app')}</button>
        </div>
      </header>

      <div className="cc-kpi-row">
        {tradeMode === 'demo' ? (
          <>
            <div className={`cc-kpi hero ${demoPnl >= 0 ? 'pos' : 'neg'}`}>
              <span>{t('DEMO 浮动盈亏', 'Demo含み損益', 'DEMO floating P&L')}</span>
              <b>{demoPnl >= 0 ? '+' : ''}{demoPnl.toFixed(2)}</b>
              <small>{t('Demo 持仓', 'Demo保有', 'Demo positions')} {demoPositions.length}</small>
            </div>
            <div className="cc-kpi">
              <span>{t('持仓总数', '保有合計', 'Total positions')}</span>
              <b>{demoPositions.length}</b>
              <small>{t('MT4 Demo 实际回传', 'MT4 Demo実測', 'MT4 Demo reported')}</small>
            </div>
            <div className="cc-kpi">
              <span>{t('持仓成本线', '保有コスト線', 'Position cost line')}</span>
              <b>{demoCostBasis === null ? '—' : demoCostBasis.toFixed(symbol.includes('JPY') ? 3 : 5)}</b>
              <small>{t('按手数加权', 'ロット加重', 'lot weighted')}</small>
            </div>
            <div className="cc-kpi">
              <span>{t('评估事件', '評価イベント', 'Eval events')}</span>
              <b>{evalEvents.toLocaleString()}</b>
              <small>{t('AI 活跃度', 'AI活動度', 'AI activity')}</small>
            </div>
          </>
        ) : (
          <>
            <div className={`cc-kpi hero ${(liveGate?.daily_budget?.realized_loss ?? 0) > 0 ? 'neg' : 'pos'}`}>
              <span>{t('今日已实现亏损', '本日の確定損失', 'Realised loss today')}</span>
              <b>{liveGate?.daily_budget?.realized_loss?.toFixed(2) ?? '0.00'}</b>
              <small>{t('预算', '予算', 'budget')} {liveGate?.daily_budget?.limit ?? '—'}</small>
            </div>
            <div className="cc-kpi">
              <span>{t('实盘持仓', '実保有', 'Live positions')}</span>
              <b>{liveGate?.live_positions?.length ?? 0}</b>
              <small>{t('真实资金', 'リアルマネー', 'real money')}</small>
            </div>
            <div className="cc-kpi">
              <span>{t('账户净值', '口座純資産', 'Account equity')}</span>
              <b>{liveGate?.live_account?.equity != null ? Number(liveGate.live_account.equity).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</b>
              <small>{liveGate?.live?.broker_name || t('未启用', '未有効化', 'not enabled')}</small>
            </div>
            <div className="cc-kpi">
              <span>{t('今日开仓', '本日建玉', 'Entries today')}</span>
              <b>{liveGate?.daily_budget?.entries ?? 0}</b>
              <small>{t('急停', '緊急停止', 'kill')} {liveGate?.killed ? t('激活', '作動中', 'active') : t('保持', '保持', 'held')}</small>
            </div>
          </>
        )}
      </div>

      <div className="console-body">
        <aside className="console-rail">
          {quoteRows.map((row) => (
            <button key={row.symbol} className={`console-pair ${row.symbol === symbol ? 'active' : ''}`} onClick={() => onSelectSymbol(row.symbol)}>
              <b>{row.symbol}</b><span>{row.bid.toFixed(row.digits)}</span><small>{row.spread.toFixed(1)}</small>
            </button>
          ))}
          {quoteRows.length === 0 && <p className="cc-empty">{t('等待报价', 'レート待機', 'waiting')}</p>}
        </aside>

        <main className="console-main">
          {/* Demo/Live 模式切换（互不混合） */}
          <div className="console-mode-switch" role="tablist" aria-label={t('交易模式', '取引モード', 'Trade mode')}>
            <button role="tab" aria-selected={tradeMode === 'demo'} className={tradeMode === 'demo' ? 'active' : ''} onClick={() => setTradeMode('demo')}>{t('模拟 DEMO', '模擬 DEMO', 'DEMO')}</button>
            <button role="tab" aria-selected={tradeMode === 'live'} className={tradeMode === 'live' ? 'active' : ''} onClick={() => setTradeMode('live')}>{t('实盘 LIVE', '実取引 LIVE', 'LIVE')}</button>
          </div>
          {/* 上下文感知监控面板：有仓位/急停时展开 */}
          {tradeMode === 'demo' ? (monitorOpen ? (
            <section className="console-monitor open" aria-label={t('持仓监控', '保有モニタリング', 'Position monitor')}>
              <div className="console-monitor-head">
                <b>{t('实时持仓监控', 'リアルタイム保有監視', 'Live position monitor')}</b>
                {policy && <span className="cc-chip">{t('AI 判断', 'AI判断', 'AI bias')}: {policy.action} · {policy.confidence}%</span>}
                {gate?.killed && <span className="cc-chip killed">{t('急停激活', '緊急停止作動中', 'KILL ACTIVE')}</span>}
                <button className="console-close-all" disabled={!paired || !demoPositions.length || gate?.killed || gate?.close_pending || closeBusy} onClick={() => void closeDemoAll()}>{closeBusy || gate?.close_pending ? '…' : t('一键平仓', '一括決済', 'CLOSE ALL')}</button>
                {paired ? (
                  <button className="console-kill" disabled={killBusy} onClick={() => void emergency()}>{killBusy ? '…' : t('紧急停止', '緊急停止', 'EMERGENCY STOP')}</button>
                ) : (
                  <button className="console-kill ghost" onClick={() => onOpenView('demo')}>{t('前往配对后可急停', 'ペアリング後に停止可能', 'Pair to enable kill')}</button>
                )}
              </div>
              <table><thead><tr><th>#</th><th>{t('品种', '通貨', 'Symbol')}</th><th>{t('方向', '方向', 'Side')}</th><th>{t('手数', 'ロット', 'Lots')}</th><th>{t('开仓', '建値', 'Open')}</th><th>{t('现价', '現値', 'Now')}</th><th>{t('浮动盈亏', '含み損益', 'P&L')}</th></tr></thead><tbody>
                {demoPositions.map((position) => (
                  <tr key={position.ticket}>
                    <td>{position.ticket}</td><td>{position.symbol}</td>
                    <td className={position.side === 'long' ? 'up' : 'down'}>{position.side === 'long' ? t('多', '買い', 'L') : t('空', '売り', 'S')}</td>
                    <td>{position.lots.toFixed(2)}</td>
                    <td>{position.open_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</td>
                    <td>{position.current_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</td>
                    <td className={position.profit + position.swap + position.commission >= 0 ? 'up' : 'down'}>{(position.profit + position.swap + position.commission).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody></table>
              {killNotice && <small>{killNotice}</small>}
            </section>
          ) : (
            <div className="console-monitor closed" aria-label={t('无持仓', '保有なし', 'no positions')}>
              <span><i className="cc-dot off" />{t('无持仓 · 监控待命', '保有なし・監視待機', 'No positions · monitor standby')}</span>
              <span><i className={`cc-dot ${gate?.killed ? 'on' : 'off'}`} />{gate?.killed ? t('急停激活', '緊急停止作動中', 'kill active') : t('急停保持', '緊急停止保持', 'kill held')}</span>
              <span><i className="cc-dot on" />{t('实盘全局锁定', '実取引全体ロック', 'live locked')}</span>
            </div>
          )) : (
            /* LIVE 模式：实盘网关只读监控 + 急停（未启用时引导） */
            <section className="console-monitor open live" aria-label={t('实盘监控', '実取引監視', 'Live monitor')}>
              <div className="console-monitor-head">
                <b>{t('实盘监控（真实资金）', '実取引監視（リアルマネー）', 'Live monitor (real money)')}</b>
                {liveGate?.live?.live_trading
                  ? <span className="cc-chip">{t('已启用', '有効化済み', 'enabled')} · {liveGate.live?.broker_name} #{liveGate.live?.account_number}</span>
                  : <span className="cc-chip killed">{t('全局锁定', '全体ロック', 'globally locked')}</span>}
                <button className="console-close-all" disabled={!livePaired || !liveGate?.live?.live_trading || !liveGate?.live_positions?.length || liveGate?.killed || liveGate?.close_pending || closeBusy} onClick={() => void closeLiveAll()}>{closeBusy || liveGate?.close_pending ? '…' : t('一键平仓', '一括決済', 'CLOSE ALL')}</button>
                {livePaired && liveGate?.live?.live_trading ? (
                  <button className="console-kill" disabled={killBusy} onClick={() => void liveEmergency()}>{killBusy ? '…' : t('紧急停止', '緊急停止', 'EMERGENCY STOP')}</button>
                ) : (
                  <button className="console-kill ghost" onClick={() => onOpenView('live')}>{t('前往实盘连接', '実取引接続へ', 'Go to live link')}</button>
                )}
              </div>
              {liveGate?.live?.live_trading ? (
                <>
                  <div className="live-kpi">
                    <div><span>{t('今日已实现亏损', '本日の確定損失', 'Realised loss today')}</span><b>{liveGate.daily_budget?.realized_loss?.toFixed(2) ?? '0.00'}</b><small>/ {liveGate.daily_budget?.limit ?? '—'}</small></div>
                    <div><span>{t('今日开仓', '本日建玉', 'Entries today')}</span><b>{liveGate.daily_budget?.entries ?? 0}</b></div>
                    <div><span>{t('实盘持仓', '実保有', 'Live positions')}</span><b>{liveGate.live_positions?.length ?? 0}</b></div>
                  </div>
                  <table><thead><tr><th>#</th><th>{t('品种', '通貨', 'Symbol')}</th><th>{t('方向', '方向', 'Side')}</th><th>{t('手数', 'ロット', 'Lots')}</th><th>{t('开仓', '建値', 'Open')}</th><th>{t('现价', '現値', 'Now')}</th><th>{t('浮动盈亏', '含み損益', 'P&L')}</th></tr></thead><tbody>
                    {(liveGate.live_positions ?? []).map((position) => (
                      <tr key={position.ticket}>
                        <td>{position.ticket}</td><td>{position.symbol}</td>
                        <td className={position.side === 'long' ? 'up' : 'down'}>{position.side === 'long' ? t('多', '買い', 'L') : t('空', '売り', 'S')}</td>
                        <td>{position.lots?.toFixed(2)}</td>
                        <td>{position.open_price?.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</td>
                        <td>{position.current_price?.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</td>
                        <td className={(position.profit ?? 0) >= 0 ? 'up' : 'down'}>{(position.profit ?? 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                  <small>{liveGate.live_account_updated_at ? `${t('账户回传', '口座更新', 'account report')}: ${liveGate.live_account_updated_at}` : t('等待 EA 回传', 'EAの報告待ち', 'waiting for EA report')}</small>
                </>
              ) : (
                <p className="cc-empty">{t('实盘通道默认全局锁定。启用需要：账户号+确认词+手动挂载 EA（见 实盘连接 页）。', '実取引は既定ロック。有効化には口座番号＋確認語＋EA手動装着が必要です。', 'Live is locked by default. Enablement needs account number + confirmation phrase + manually attached EA (see Live link page).')}</p>
              )}
            </section>
          )}

          <div className="console-chart-row">
            <div className="console-chart">
              <div className="console-tf-tabs">{CHART_TFS.map((tf) => <button key={tf} className={chartTf === tf ? 'active' : ''} onClick={() => setChartTf(tf)}>{tf}</button>)}</div>
              <FxChart bars={activeChart?.bars ?? []} symbol={symbol} timeframe={chartTf} source={activeChart?.state === 'ready' ? 'mt4' : 'unavailable'} liveQuote={liveQuote} costBasis={tradeMode === 'demo' ? demoCostBasis : liveCostBasis} theme="dark" language={language} />
            </div>
            <aside className="console-side">
              <div className="console-card">
                <h4>{t('风险参数', 'リスクパラメーター', 'Risk parameters')}</h4>
                {tradeMode === 'demo' ? <>
                  <div><span>{t('信号门槛', 'シグナル閾値', 'Signal threshold')}</span><b>{demoSettings.minimumScore}</b></div>
                  <div><span>{t('冷却时间', '待機時間', 'Cooldown')}</span><b>{demoSettings.cooldownMinutes} min</b></div>
                  <div><span>{t('最大 Demo 持仓', '最大Demo保有', 'Max Demo positions')}</span><b>{demoSettings.maxPositions}</b></div>
                  <div><span>{t('Demo 点差上限', 'Demo最大スプレッド', 'Demo spread cap')}</span><b>{demoSettings.maxSpreadPips.toFixed(1)}</b></div>
                </> : <>
                  <div><span>{t('单笔风险', '1取引リスク', 'Risk/trade')}</span><b>{risk.riskPerTradePct.toFixed(2)}%</b></div>
                  <div><span>{t('日亏上限', '日次損失上限', 'Daily cap')}</span><b>{risk.dailyLossLimitPct.toFixed(2)}%</b></div>
                  <div><span>{t('最大实盘持仓', '最大実取引保有', 'Max live positions')}</span><b>{risk.maxOpenPositions}</b></div>
                  <div><span>{t('实盘点差上限', '実取引最大スプレッド', 'Live spread cap')}</span><b>{risk.maxSpreadPips.toFixed(1)}</b></div>
                </>}
              </div>
              <div className="console-card">
                <h4>{t('账户概览', '口座概要', 'Account overview')}</h4>
                {tradeMode === 'demo' ? <>
                  <div><span>{t('Demo 持仓', 'Demo保有', 'Demo positions')}</span><b>{demoPositions.length}</b></div>
                  <div><span>{t('Demo 浮动', 'Demo含み損益', 'Demo floating')}</span><b className={demoPnl >= 0 ? 'up' : 'down'}>{demoPnl >= 0 ? '+' : ''}{demoPnl.toFixed(2)}</b></div>
                </> : <>
                  <div><span>{t('实盘持仓', '実取引保有', 'Live positions')}</span><b>{livePositions.length}</b></div>
                  <div><span>{t('实盘浮动', '実取引含み損益', 'Live floating')}</span><b className={livePnl >= 0 ? 'up' : 'down'}>{livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}</b></div>
                  <div><span>{t('实盘余额', '実取引残高', 'Live balance')}</span><b>{liveGate?.live_account?.balance?.toFixed(2) ?? '—'}</b></div>
                </>}
                <div><span>{t('当前 AI 判断', '現在のAI判断', 'Current AI bias')}</span><b>{policy ? `${policy.action} ${policy.confidence}%` : '—'}</b></div>
              </div>
              <div className="console-card">
                <h4>{t('功能入口', '機能入口', 'Quick entries')}</h4>
                <div className="console-entries">
                  {entries.map((entry) => (
                    <button key={entry.view} onClick={() => onOpenView(entry.view)}><b>{entry.icon}</b><span>{entry.label}</span></button>
                  ))}
                </div>
                <small>{t('点击将离开控制台进入对应页面；控制台数据保持刷新。', 'クリックするとコンソールを離れて該当画面へ。', 'Clicking leaves the console for that page; console data keeps refreshing.')}</small>
              </div>
            </aside>
          </div>

          <section className="console-signal-strip">
            {wall.some((row) => row.cells.some((cell) => cell.direction !== 'wait')) ? wall.map((row) => (
              <div key={row.tf} className="console-signal-row">
                <b>{row.tf}</b>
                {row.cells.map((cell) => (
                  <span key={cell.id} className={signalChip(cell.direction)} title={modelName(RESEARCH_MODELS.find((m) => m.id === cell.id) ?? RESEARCH_MODELS[0], language)}>
                    {signalText(cell.direction)}
                  </span>
                ))}
                {row.tf === 'M15' && policy && <span className="cc-chip">{t('AI', 'AI', 'AI')}: {policy.action} {policy.confidence}%</span>}
              </div>
            )) : (
              <div className="console-signal-row all-wait">
                <b>{t('信号', 'シグナル', 'SIGNAL')}</b>
                <span className="cc-empty">{t('全部观望——休市中或尚未触发入场条件；触发时此处亮起。', 'すべて待機——休市中または条件未達。発火時ここが点灯します。', 'All standby — closed or no entry triggered; lights up on signal.')}</span>
              </div>
            )}
          </section>

          <footer className="console-news">
            {news.length === 0 ? <span className="cc-empty">{t('暂无与外汇相关的新闻（已过滤无关条目）', 'FX関連のニュースなし（無関係を除外）', 'No FX-relevant news (irrelevant items filtered)')}</span> : news.slice(0, 6).map((item, index) => (
              <span key={index} className="console-news-item">{item.display || '—'}<time>{item.published.slice(5, 16).replace('T', ' ')}</time></span>
            ))}
          </footer>
        </main>
      </div>
    </div>
  );
}
