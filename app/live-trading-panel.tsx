'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { enqueueEvaluationEvent } from '../lib/ai-evaluation-outbox';
import { AiTerminalClient, createAiEventId, type AiPolicy } from '../lib/ai-terminal';
import { findMt4Quote, type Mt4HistorySnapshot, type Mt4QuoteSnapshot } from '../lib/mt4-bridge';
import { buildResearchSignal } from '../lib/research-signal';
import { modelDefinition } from '../lib/model-catalog';
import type { AdaptiveState } from '../lib/adaptive-research';
import type { PairSymbol, RiskConfig } from '../lib/market-data';
import AiRiskAdvisor from './ai-risk-advisor';
import { decidePositionManagement } from '../lib/position-management';

type Language = 'zh' | 'ja' | 'en';
type LiveGateStatus = {
  build_version?: string; status?: string; pending?: boolean; close_pending?: boolean; killed?: boolean; kill_reason?: string | null;
  limits?: { max_lots?: number; min_lots?: number; ticket_ttl_seconds?: number };
  live?: { enablement_active?: boolean; live_trading?: boolean; env_marker?: string; broker_name?: string; account_number?: string; enabled_at?: string };
  daily_budget?: { date?: string; realized_loss?: number; entries?: number; limit?: number };
  preflight?: { ready?: boolean; checked_at?: string; snapshot_age_seconds?: number | null; checks?: Array<{ id: string; passed: boolean; detail: string }> };
  live_account?: { login?: number | string; balance?: number; equity?: number; free_margin?: number; margin?: number; leverage?: number; server?: string; currency?: string } | null;
  live_positions?: Array<{ ticket: number; symbol: string; side: string; lots: number; open_price: number; current_price: number; stop_loss: number; take_profit: number; profit: number; swap: number; commission: number }>;
  live_closed_positions?: Array<{ ticket: number; policy_id: string; request_id: string; timeframe: 'M5' | 'M15'; symbol: string; side: 'long' | 'short'; lots: number; open_price: number; close_price: number; opened_at: string; closed_at: string; profit: number; swap: number; commission: number; spread_pips: number; slippage_pips: number }>;
  live_account_today?: { date?: string; realized_loss?: number; entries?: number } | null;
  live_account_updated_at?: string | null;
  audit?: string[][];
};
const LIVE_PAIRING_CODE = 'enkei-live-gate-pairing-code';

export default function LiveTradingPanel({ language, snapshot, adaptiveState, risk, onApplyRisk }: { language: Language; snapshot: Mt4QuoteSnapshot | null; adaptiveState: AdaptiveState; risk: RiskConfig; onApplyRisk: (risk: RiskConfig) => void }) {
  const [gateRunning, setGateRunning] = useState(false);
  const [code, setCode] = useState('');
  const [paired, setPaired] = useState(false);
  const [gate, setGate] = useState<LiveGateStatus | null>(null);
  const [brokerName, setBrokerName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [enableWord, setEnableWord] = useState('');
  const [disableWord, setDisableWord] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [closingAll, setClosingAll] = useState(false);
  const [liveAutomationArmed, setLiveAutomationArmed] = useState(false);
  const [liveAutomationWord, setLiveAutomationWord] = useState('');
  const [liveTimeframe, setLiveTimeframe] = useState<'M5' | 'M15'>('M5');
  const [liveSymbol, setLiveSymbol] = useState<PairSymbol>('USD/JPY');
  const [liveHistory, setLiveHistory] = useState<Mt4HistorySnapshot | null>(null);
  const [livePolicy, setLivePolicy] = useState<AiPolicy | null>(null);
  const [constraints, setConstraints] = useState({ score: true, cooldown: true, scaleIn: true, exit: true, spread: true });
  const [lastLiveActionAt, setLastLiveActionAt] = useState(0);
  const [policyRefreshNonce, setPolicyRefreshNonce] = useState(0);
  const lastLiveBar = useRef<number | null>(null);
  const manualPolicyRefresh = useRef(false);
  const liveDecisionBusy = useRef(false);
  const aiTerminal = useRef(new AiTerminalClient());
  const statusFailures = useRef(0);
  const t = useCallback((zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en, [language]);
  const bilingual = useCallback((zh: string, ja: string, english: string) => t(zh, ja, english), [t]);

  const controllerRequest = useCallback(async (path: string, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:8787${path}`, { method, cache: 'no-store' });
    return (await response.json()) as { running?: boolean; error?: string; pairing_code?: string };
  }, []);

  const gateRequest = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:8791${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(code ? { 'X-Enkei-Live-Code': code } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json() as LiveGateStatus & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Live gateway request failed.');
    return payload;
  }, [code]);

  const refresh = useCallback(async () => {
    try {
      const controller = await controllerRequest('/api/live/status');
      setGateRunning(Boolean(controller?.running));
      if (!code) { setGate(null); return; }
      const next = await gateRequest('/api/status');
      setPaired(true);
      statusFailures.current = 0;
      setGate((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch { statusFailures.current += 1; /* Keep last server-confirmed state during browser throttling. */ }
  }, [code, controllerRequest, gateRequest]);

  useEffect(() => {
    let active = true;
    const initial = window.setTimeout(() => {
      const storedCode = window.sessionStorage.getItem(LIVE_PAIRING_CODE);
      if (storedCode) { if (active) setCode(storedCode); window.setTimeout(() => void refresh(), 0); }
      else void refresh();
    }, 0);
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    for (const position of gate?.live_closed_positions ?? []) {
      if (!position.policy_id || !position.request_id || !['M5', 'M15'].includes(position.timeframe)) continue;
      const opened = Date.parse(position.opened_at); const closed = Date.parse(position.closed_at);
      if (![opened, closed, position.open_price, position.close_price, position.profit, position.swap, position.commission].every(Number.isFinite)) continue;
      const seenKey = `enkei-live-outcome-${position.ticket}`;
      if (window.localStorage.getItem(seenKey)) continue;
      enqueueEvaluationEvent({
        event_id: createAiEventId(), type: 'outcome', policy_id: position.policy_id, symbol: position.symbol.replace(/[^A-Za-z]/g, '').toUpperCase(),
        timeframe: position.timeframe, direction: position.side, entry_price: position.open_price, exit_price: position.close_price,
        floating_pnl: 0, closed_pnl: position.profit + position.swap + position.commission,
        spread_pips: position.spread_pips, slippage_pips: position.slippage_pips,
        duration_seconds: Math.max(0, Math.floor((closed - opened) / 1000)), opened_at: position.opened_at, closed_at: position.closed_at,
        environment: 'live', execution_reason: `MT4 live ticket ${position.ticket}; request ${position.request_id}`,
      });
      window.localStorage.setItem(seenKey, position.closed_at);
    }
  }, [gate?.live_closed_positions]);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(liveSymbol)}&timeframe=${liveTimeframe}&limit=120`, { cache: 'no-store' });
        if (response.ok) setLiveHistory(await response.json() as Mt4HistorySnapshot);
      } catch {}
    };
    void load(); const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [liveSymbol, liveTimeframe]);

  useEffect(() => {
    const bars = liveHistory?.bars ?? [];
    const completed = bars.at(-2);
    const quote = findMt4Quote(snapshot, liveSymbol);
    const manualRefresh = manualPolicyRefresh.current;
    if ((!liveAutomationArmed && !manualRefresh) || !completed || !quote || liveDecisionBusy.current) return;
    if (lastLiveBar.current === null) { lastLiveBar.current = completed.time; return; }
    if (completed.time <= lastLiveBar.current) return;
    lastLiveBar.current = completed.time;
    manualPolicyRefresh.current = false;
    liveDecisionBusy.current = true;
    void (async () => {
      const terminalSymbol = liveSymbol.replace('/', '');
      const pip = terminalSymbol.endsWith('JPY') ? .01 : .0001;
      const closes = bars.map((bar) => bar.close);
      const ema = (period: number) => { const alpha = 2 / (period + 1); return closes.reduce((value, close, index) => index ? close * alpha + value * (1 - alpha) : close, closes[0] ?? 0); };
      const selectedModel = adaptiveState.timeframeDecisions[liveTimeframe]?.selectedModel ?? adaptiveState.selectedModel;
      const model = modelDefinition(selectedModel);
      const signal = buildResearchSignal(bars, liveSymbol, liveTimeframe, selectedModel);
      const submittedAt = Date.now();
      const summary = {
        version: 'enkei-market-summary/v1' as const, generated_at: new Date().toISOString(), symbol: terminalSymbol, timeframe: liveTimeframe,
        quote: { bid: quote.bid, ask: quote.ask, spread_pips: (quote.ask - quote.bid) / pip, received_at: snapshot?.gmt_epoch ? new Date(snapshot.gmt_epoch * 1000).toISOString() : new Date().toISOString() },
        features: { ema_fast: ema(20), ema_slow: ema(50), momentum: (bars.at(-2)?.close ?? 0) - (bars.at(-7)?.close ?? 0), recent_high: Math.max(...bars.slice(-20).map((bar) => bar.high)), recent_low: Math.min(...bars.slice(-20).map((bar) => bar.low)), range_pips: (Math.max(...bars.slice(-20).map((bar) => bar.high)) - Math.min(...bars.slice(-20).map((bar) => bar.low))) / pip },
        bars: bars.slice(-20).map((bar) => ({ time: new Date(bar.time * 1000).toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
        execution_context: { selected_rule_model: selectedModel, positions: (gate?.live_positions ?? []).map((position) => ({ side: position.side === 'long' ? 'long' as const : 'short' as const, lots: position.lots, open_price: position.open_price, profit: position.profit })), previous_policy: livePolicy ? { action_bias: livePolicy.action_bias, expires_at: livePolicy.expires_at } : null },
      };
      try {
        await aiTerminal.current.submitAssessment(summary);
        let policy: AiPolicy | null = null;
        for (let attempt = 0; attempt < 20 && !policy; attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          const current = await aiTerminal.current.getCurrentPolicy(liveSymbol, liveTimeframe);
          if (current.policy && Date.parse(current.policy.generated_at) >= submittedAt - 1_000) policy = current.policy;
        }
        setLivePolicy(policy);
        if (!policy || !policy.request_id) throw new Error(t('没有取得可追溯的新判断。', '追跡可能な新判断を取得できません。', 'No new traceable decision was returned.'));
        const otherTimeframe = liveTimeframe === 'M5' ? 'M15' : 'M5';
        const confirmationResult = await aiTerminal.current.getCurrentPolicy(liveSymbol, otherTimeframe);
        const management = decidePositionManagement(policy, confirmationResult.policy, (gate?.live_positions ?? []).map((position) => position.side));
        if (constraints.exit && management.action === 'close-all') {
          await gateRequest('/api/close', 'POST', { ticket: 0, confirmation: 'LIVE', envMarker: gate?.live?.env_marker });
          setNotice(t(`AI 判定为${management.classification === 'confirmed-reversal' ? '跨周期趋势反转' : '明确退出'}，已请求平掉本 EA 的全部实盘持仓；等待 MT4 回执。`, `AIは${management.classification === 'confirmed-reversal' ? '時間足横断のトレンド反転' : '明確な退出'}と判定し、このEAの全実取引決済を要求しました。MT4応答待ちです。`, `AI classified ${management.classification}; close-all for this EA was requested and is awaiting MT4 receipt.`));
          return;
        }
        const aligned = (policy.action_bias === 'long' || policy.action_bias === 'short') && policy.action_bias === signal.direction;
        const spreadPips = (quote.ask - quote.bid) / pip;
        const blocks = [
          ...(!gate?.preflight?.ready ? ['live-preflight'] : []), ...(!paired ? ['pairing'] : []), ...(gate?.pending ? ['pending-intent'] : []),
          ...((gate?.live_positions?.length ?? 0) >= risk.maxOpenPositions ? ['position-cap'] : []), ...(constraints.spread && spreadPips > risk.maxSpreadPips ? ['spread-limit'] : []),
          ...(!aligned ? ['ai-rule-conflict'] : []), ...(constraints.score && signal.score < 55 ? ['signal-threshold'] : []),
          ...(constraints.cooldown && Date.now() - lastLiveActionAt < 5 * 60_000 ? ['cooldown'] : []), ...(snapshot?.age_ms !== undefined && snapshot.age_ms > 10_000 ? ['stale-quote'] : []),
        ];
        enqueueEvaluationEvent({ event_id: createAiEventId(), type: 'decision', policy_id: policy.policy_id, request_id: policy.request_id,
          symbol: terminalSymbol, timeframe: liveTimeframe, decision_generated_at: new Date().toISOString(), adopted: blocks.length === 0,
          reject_reason: blocks.includes('ai-rule-conflict') ? 'rule_conflict' : blocks.length ? 'invalid' : null, final_action: aligned ? policy.action_bias : 'wait',
          gate_summary: { rules_checked: 7, rules_passed: Math.max(0, 7 - blocks.length), blocked_by: blocks }, ai_provider: policy.provider,
          ai_model: policy.model_id, ai_model_version: policy.model_version, ai_direction: policy.action_bias, ai_confidence: policy.confidence,
          market_regime: policy.market_regime, strategy_model: model.id, strategy_version: model.version, strategy_score: signal.score,
          rationale: policy.rationale_zh, invalidation: policy.invalidation, evidence: { news: policy.news_context, feature_summary: policy.feature_summary }, environment: 'live' });
        if (blocks.length) { setNotice(t(`实盘本根观望：${blocks.join('、')}`, `実取引は今回見送り：${blocks.join('、')}`, `Live bar skipped: ${blocks.join(', ')}`)); return; }
        const stopPips = 30; const side = policy.action_bias as 'long' | 'short';
        const stopLoss = side === 'long' ? quote.bid - stopPips * pip : quote.ask + stopPips * pip;
        const takeProfit = side === 'long' ? quote.ask + stopPips * 2 * pip : quote.bid - stopPips * 2 * pip;
        const response = await fetch('http://127.0.0.1:8791/api/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Live-Code': code }, body: JSON.stringify({ symbol: terminalSymbol, side, lots: .01, stopLoss, takeProfit, maxSpreadPips: constraints.spread ? Math.min(50, risk.maxSpreadPips) : 0, dailyLossLimit: gate?.daily_budget?.limit, envMarker: gate?.live?.env_marker, confirmation: 'LIVE', policyId: policy.policy_id, requestId: policy.request_id, timeframe: liveTimeframe }) });
        const result = await response.json() as { id?: string; error?: string };
        if (!response.ok) throw new Error(result.error ?? 'live-ticket-rejected');
        setLastLiveActionAt(Date.now()); setNotice(t(`实盘指令已提交 EA、尚未成交：${result.id}`, `実取引指示をEAへ送信、未約定：${result.id}`, `Live intent submitted to EA, not filled yet: ${result.id}`));
      } catch (error) { setNotice(error instanceof Error ? error.message : 'live-decision-failed'); }
      finally { liveDecisionBusy.current = false; }
    })();
  }, [adaptiveState, code, constraints, gate, gateRequest, language, lastLiveActionAt, liveAutomationArmed, liveHistory, livePolicy, liveSymbol, liveTimeframe, paired, policyRefreshNonce, risk.maxOpenPositions, risk.maxSpreadPips, snapshot, t]);

  const startGate = async () => {
    setBusy(true); setNotice('');
    try {
      const res = await controllerRequest('/api/live/start', 'POST');
      if (res?.error) throw new Error(res.error);
      const pairingCode = res?.pairing_code;
      if (pairingCode) {
        setCode(pairingCode);
        try { window.sessionStorage.setItem(LIVE_PAIRING_CODE, pairingCode); } catch {}
        setPaired(true);
        setNotice(t('实盘确认网关已启动并自动配对。下单仍被全局锁定。', '実取引確認ゲートウェイを起動し自動ペアリングしました。注文はまだ全体ロック中です。', 'The live confirmation gateway has started and auto-paired. Order placement remains globally locked.'));
      } else {
        setNotice(t('实盘确认网关已启动，但未取到配对码。请重启本机控制中心后重试。', 'ゲートウェイは起動しましたがペアリングコードを取得できません。コントロールセンターを再起動してください。', 'The live gateway has started but no pairing code was obtained. Restart the local control centre and retry.'));
      }
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('启动失败。', '起動に失敗しました。', 'Start failed.')); }
    setBusy(false);
  };
  const stopGate = async () => {
    setBusy(true); setNotice('');
    try {
      const res = await controllerRequest('/api/live/stop', 'POST');
      if (res?.error) throw new Error(res.error);
      setGateRunning(false); setPaired(false); setGate(null);
      setNotice(t('实盘确认网关已停止。全局锁定状态未改变。', '実取引ゲートウェイを停止しました。全体ロック状態は変わりません。', 'The live gateway has stopped. The global lock state is unchanged.'));
    } catch (error) { setNotice(error instanceof Error ? error.message : t('停止失败。', '停止に失敗しました。', 'Stop failed.')); }
    setBusy(false);
  };
  const enableLive = async () => {
    setBusy(true); setNotice('');
    try {
      await gateRequest('/api/enable', 'POST', { brokerName, accountNumber, confirmation: 'LIVE' });
      setNotice(t('已启用并锁定到该券商账户。EA 挂载并开启执行后才可能下单；急停与逐日亏损上限始终生效。', 'このブローカー口座へ有効化・ロックしました。EAを装着し実行を有効化して初めて注文可能になります。', 'Enabled and locked to this broker account. Orders become possible only after the EA is mounted and execution enabled; the emergency stop and daily loss cap always apply.'));
      setEnableWord(''); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('启用被拒绝。', '有効化は拒否されました。', 'Enablement was rejected.')); }
    setBusy(false);
  };
  const disableLive = async () => {
    setBusy(true); setNotice('');
    try {
      await gateRequest('/api/disable', 'POST', { confirmation: 'DISABLE' });
      setNotice(t('已解除实盘启用，回到全局锁定。', '実取引の有効化を解除し、全体ロックへ戻りました。', 'Live enablement released; back to the global lock.'));
      setDisableWord(''); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('解除被拒绝。', '解除は拒否されました。', 'Release was rejected.')); }
    setBusy(false);
  };
  const emergency = async (reset = false) => {
    setBusy(true); setNotice('');
    try {
      await gateRequest(reset ? '/api/kill/reset' : '/api/kill', 'POST', {});
      setNotice(reset ? t('急停已重置；启用与每日亏损上限仍未解除。', '緊急停止を解除しました。有効化と日次損失上限は維持されます。', 'Emergency stop reset; enablement and the daily loss cap remain in force.') : t('急停已激活；禁止新增风险，但认证后的一键平仓仍然可用。', '緊急停止を有効化。新規リスクは禁止し、認証済み一括決済は利用できます。', 'Emergency stop activated; new risk is blocked, while authenticated close-all remains available.'));
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('操作失败。', '操作に失敗しました。', 'The operation failed.')); }
    setBusy(false);
  };

  const closeAll = async () => {
    if (!positions.length || closingAll || !paired || !live?.env_marker) return;
    if (!window.confirm(t('确认立即平掉本 EA 的全部实盘持仓？这会操作真实资金账户。', 'このEAの実取引保有をすべて直ちに決済しますか？ 実資金口座を操作します。', 'Close all live positions opened by this EA now? This acts on a real-money account.'))) return;
    setClosingAll(true); setNotice('');
    try {
      await gateRequest('/api/close', 'POST', { ticket: 0, confirmation: 'LIVE', envMarker: live.env_marker });
      setNotice(t('全部实盘平仓指令已提交，正在等待 MT4 回执。', '実取引の全決済指示を送信し、MT4の応答を待っています。', 'Close-all live request submitted; waiting for the MT4 receipt.'));
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('全部平仓失败。', '全決済に失敗しました。', 'Close all failed.')); }
    finally { setClosingAll(false); }
  };

  const live = gate?.live;
  const budget = gate?.daily_budget;
  const today = gate?.live_account_today;
  const account = gate?.live_account;
  const positions = gate?.live_positions ?? [];
  const enabled = Boolean(live?.enablement_active);
  const selectedQuote = findMt4Quote(snapshot, liveSymbol);
  const currentSpread = selectedQuote ? (selectedQuote.ask - selectedQuote.bid) / (liveSymbol.endsWith('JPY') ? .01 : .0001) : 0;

  return <section className="phase-panel live-trading-panel">
    <div className="phase-heading">
      <div><p className="eyebrow">{bilingual('实盘执行确认服务', '実取引実行確認サービス', 'Live execution confirmation')}</p><h3>{t('实盘执行确认服务', '実取引実行確認サービス', 'Live execution confirmation service')} <span>{t('账户级锁定 · 每日亏损上限 · 随时急停', '口座レベルロック・日次損失上限・緊急停止', 'Account-level lock · daily loss cap · emergency stop anytime')}</span></h3></div>
      <span className="demo-gate-chip">{bilingual('真实资金', '実資金', 'REAL MONEY')}</span>
    </div>
    <div className="demo-execution-warning live-warning"><span>!</span><p><b>{t('这是真实资金通道。默认全局锁定：不启用到特定券商账户前，任何途径都无法下单。', 'これは実資金の経路です。既定は全体ロック。特定のブローカー口座へ有効化しない限り、いかなる経路からも注文できません。', 'This is the real-money channel. It is globally locked by default: until enabled for a specific broker account, no path can place orders.')}</b><small>{t('启用需手动输入账户号与确认词；EA 必须由你在乐天 MT4 FX 口座上手动挂载并开启执行；急停必须手动重置。密钥永不进入日志、网页或前端。', '有効化には口座番号と確認語の手入力が必要です。EAは楽天MT4 FX口座に手動で装着し実行を有効にする必要があります。秘密鍵はログ・Web・フロントエンドに一切入りません。', 'Enablement requires manually entering the account number and confirmation phrase; the EA must be mounted by you on the Rakuten MT4 FX account with execution enabled; the emergency stop must be reset manually. Secrets never enter logs, web pages or the frontend.')}</small></p></div>
    <div className="demo-live-strip">
      <article><span>{t('本机确认服务', '端末内確認サービス', 'Local confirmation service')}</span><b className={gateRunning ? 'positive' : 'negative'}>{gateRunning ? t('运行中', '稼働中', 'Running') : t('未启动', '未起動', 'Not started')}</b><small>{code ? t(`已配对 ${code.slice(0, 8)}…`, `ペアリング済み ${code.slice(0, 8)}…`, `Paired ${code.slice(0, 8)}…`) : t('尚未配对', '未ペアリング', 'Not paired')}</small></article>
      <article><span>{t('全局锁定', '全体ロック', 'Globally locked')}</span><b className={!enabled ? 'positive' : 'negative'}>{enabled ? t('已启用', '有効化済み', 'Enabled') : t('锁定中', 'ロック中', 'Locked')}</b><small>{enabled ? `${live?.broker_name} #${live?.account_number}` : t('等待启用到特定账户', '特定口座への有効化待ち', 'Waiting to be enabled for a specific account')}</small></article>
      <article><span>{t('今日已实现亏损', '本日の確定損失', 'Realised loss today')}</span><b className={(budget?.realized_loss ?? 0) >= (budget?.limit || Infinity) ? 'negative' : ''}>{budget?.limit ? `${(budget.realized_loss ?? 0).toFixed(2)} / ${budget.limit.toFixed(2)}` : `— / ${t('未设预算', '未設定', 'No budget set')}`}</b><small>{today && Number.isFinite(today.entries) ? `${t('今日开仓', '本日建玉', 'Positions opened today')} ${today.entries}` : t('每日上限为硬熔断', '日次上限はハードブレーカー', 'The daily cap is a hard breaker')}</small></article>
      <article><span>{t('账户余额 / 净值', '口座残高 / 純資産', 'Balance / equity')}</span><b>{account ? `${account.balance?.toFixed(2)} / ${account.equity?.toFixed(2)}` : t('等待 EA 回传', 'EA受信待ち', 'Waiting for the EA report')}</b><small>{account ? `${account.currency ?? ''} · ${account.server ?? ''}` : t('只读快照，不包含任何凭据', '読取専用スナップショット・認証情報なし', 'Read-only snapshot with no credentials')}</small></article>
    </div>
    <div className={gate?.preflight?.ready ? 'live-preflight ready' : 'live-preflight'}>
      <div>
        <b>{gate?.preflight?.ready ? t('实盘正式运行准入已通过', '実取引の正式運用チェック合格', 'Formal live-operation preflight passed') : t('实盘正式运行准入尚未通过', '実取引の正式運用チェック未完了', 'Formal live-operation preflight not ready')}</b>
        <small>{t('网关会在每次新开仓前重新检查；任一关键项失败即拒绝新仓，但一键平仓仍保留独立人工通道。', '新規注文ごとに再確認し、重要項目が一つでも失敗すれば拒否します。一括決済は独立した手動経路を維持します。', 'The gateway rechecks before every new entry. Any failed critical check rejects entry; close-all remains an independent manual path.')}</small>
      </div>
      <div className="live-preflight-checks">
        {(gate?.preflight?.checks ?? []).map((check) => <span className={check.passed ? 'passed' : 'failed'} key={check.id}>{check.passed ? '✓' : '×'} {check.id} · {check.detail}</span>)}
      </div>
    </div>
    <AiRiskAdvisor language={language} mode="live" positionCeiling={risk.maxOpenPositions} policy={livePolicy} regime={livePolicy?.market_regime} confidence={livePolicy?.confidence} currentSpread={currentSpread} onRefresh={() => { const bar = liveHistory?.bars?.at(-2); if (!bar) throw new Error('live-history-unavailable'); manualPolicyRefresh.current = true; lastLiveBar.current = bar.time - 1; setPolicyRefreshNonce((value) => value + 1); setNotice(t('已提交实盘 AI 建议刷新，正在等待真实政策回传；不会因此启动自动交易。', '実取引AI提案の更新を送信しました。実際の方針応答を待機中で、自動取引は開始しません。', 'Live AI guidance refresh submitted; this does not start automated trading.')); }} onApplyLive={(value) => { onApplyRisk(value); setNotice(t('已应用经你确认的实盘 AI 风险参数；不会提高用户设置的持仓上限。', '確認済みの実取引AIリスク設定を適用しました。ユーザー上限は引き上げません。', 'The confirmed live AI guidance was applied without raising the user position ceiling.')); }} />
    <div className="ai-constraint-toggles">{([['score','信号阈值','シグナル閾値','Signal threshold'],['cooldown','冷却时间','クールダウン','Cooldown'],['scaleIn','加仓间距','追加間隔','Scale-in spacing'],['exit','弱信号退出','弱シグナル退出','Weak-signal exit'],['spread','点差上限','スプレッド上限','Spread cap']] as const).map(([key, zh, ja, en]) => <label key={key}><input type="checkbox" checked={constraints[key]} onChange={(event) => setConstraints((value) => ({ ...value, [key]: event.target.checked }))} />{t(zh, ja, en)}</label>)}</div>
    <div className={liveAutomationArmed ? 'demo-pairing live-auto-armed' : 'demo-pairing'}>
      <div>
        <p className="eyebrow">{bilingual('正式受控实盘决策循环', '正式な制御付き実取引判断ループ', 'controlled live decision loop')}</p>
        <b>{liveAutomationArmed ? t('已启用：仅在新完成的 M5/M15 K线、AI 与本地策略同向且全部准入通过时提交 0.01 手。', '有効：確定M5/M15、AIとローカル戦略の一致、全チェック合格時のみ0.01ロットを送信。', 'Enabled: submits 0.01 lot only on a newly closed M5/M15 bar when AI and the local strategy agree and every preflight passes.') : t('默认关闭；它与“启用实盘账户”是两个独立开关。', '既定は無効。「実取引口座の有効化」とは独立した二つ目のスイッチです。', 'Off by default; this is a second switch independent from account enablement.')}</b>
        <small>{livePolicy ? `${livePolicy.provider} / ${livePolicy.model_id} · ${livePolicy.action_bias} ${livePolicy.confidence}% · request ${livePolicy.request_id?.slice(0, 12) ?? '—'}…` : t('尚未形成新的可追溯实盘判断。', '新しい追跡可能な実取引判断はまだありません。', 'No new traceable live decision yet.')}</small>
      </div>
      <select value={liveSymbol} disabled={liveAutomationArmed} onChange={(event) => { setLiveSymbol(event.target.value as PairSymbol); lastLiveBar.current = null; }}><option>USD/JPY</option><option>EUR/USD</option><option>EUR/JPY</option><option>GBP/USD</option><option>GBP/JPY</option><option>AUD/JPY</option></select>
      <select value={liveTimeframe} disabled={liveAutomationArmed} onChange={(event) => { setLiveTimeframe(event.target.value as 'M5' | 'M15'); lastLiveBar.current = null; }}><option>M5</option><option>M15</option></select>
      {!liveAutomationArmed && <input value={liveAutomationWord} onChange={(event) => setLiveAutomationWord(event.target.value.toUpperCase())} placeholder="LIVE-AUTO" />}
      <button className={liveAutomationArmed ? 'cancel' : 'kill'} disabled={!liveAutomationArmed && (!gate?.preflight?.ready || liveAutomationWord !== 'LIVE-AUTO')} onClick={() => { setLiveAutomationArmed((value) => !value); setLiveAutomationWord(''); lastLiveBar.current = null; }}>{liveAutomationArmed ? t('停止实盘决策循环', '実取引判断ループ停止', 'Stop live decision loop') : t('输入 LIVE-AUTO 后启用', 'LIVE-AUTO入力後に有効化', 'Enable after typing LIVE-AUTO')}</button>
    </div>
    <div className="demo-pairing">
      <div>
        <p className="eyebrow">{bilingual('步骤 1：启动并配对本机确认服务', '手順1：端末内確認サービスを起動・ペアリング', 'Step 1 · Start and pair local service')}</p>
        <b>{t('配对码由本机控制中心签发，只保存在当前浏览器会话。重启服务后需重新启动并配对。', 'ペアリングコードは本機コントロールセンターが発行し、現在のブラウザセッションにのみ保持します。サービス再起動後は再起動・再ペアリングが必要です。', 'The pairing code is issued by the local control centre and kept only in this browser session. After restarting the service, start and pair again.')}</b>
        <small>{t('已启动且已配对时，本服务才开始接受状态查询。启用账户仍需下一步的确认词。', '起動しペアリング済みのとき、本サービスは状態照会を受け付けます。口座の有効化には次の手順の確認語が仍必要です。', 'The service accepts status queries only once started and paired. Enabling the account still requires the confirmation phrase in the next step.')}</small>
      </div>
      <button onClick={startGate} disabled={busy || gateRunning}>{gateRunning ? t('已启动', '稼働中', 'Started') : t('启动实盘确认服务', '実取引確認サービスを起動', 'Start live confirmation service')}</button>
      <button className="cancel" onClick={stopGate} disabled={busy || !gateRunning}>{t('停止服务', 'サービスを停止', 'Stop service')}</button>
      <button className={gate?.killed ? 'reset' : 'kill'} onClick={() => emergency(Boolean(gate?.killed))} disabled={busy || !gateRunning || !paired}>{gate?.killed ? t('解除急停', '緊急停止を解除', 'Release emergency stop') : t('紧急停止', '緊急停止', 'Emergency stop')}</button>
    </div>
    <details className="demo-service-details live-enable-section">
      <summary>{t('步骤 2：启用 / 停用实盘（真实资金）', '手順2：実取引の有効化／無効化（実資金）', 'Step 2 · Enable / disable real-money path')}<small>{enabled ? t('当前已启用', '現在：有効化済み', 'Currently enabled') : t('当前全局锁定', '現在：全体ロック', 'Currently globally locked')}</small></summary>
      <div className="live-enable-form">
        <div className="live-enable-field"><label>{t('券商名称（需与 MT4 服务器名匹配）', 'ブローカー名（MT4サーバー名と一致）', 'Broker name (must match the MT4 server name)')}</label><input type="text" autoComplete="off" value={brokerName} disabled={enabled} onChange={(event) => setBrokerName(event.target.value)} placeholder={t('例如 Rakuten', '例：Rakuten', 'e.g. Rakuten')} /></div>
        <div className="live-enable-field"><label>{t('乐天 MT4 FX 账户号', '楽天MT4 FX口座番号', 'Rakuten MT4 FX account number')}</label><input type="text" inputMode="numeric" autoComplete="off" value={accountNumber} disabled={enabled} onChange={(event) => setAccountNumber(event.target.value)} placeholder="12345678" /></div>
        <div className="live-enable-field"><label>{t('输入 LIVE 启用', 'LIVEと入力して有効化', 'Type LIVE to enable')}</label><input type="text" maxLength={8} value={enableWord} disabled={enabled} onChange={(event) => setEnableWord(event.target.value.toUpperCase())} placeholder="LIVE" /></div>
        <button className="kill" disabled={busy || !gateRunning || !paired || enabled || !brokerName || !/^\d+$/.test(accountNumber) || enableWord !== 'LIVE'} onClick={enableLive}>{t('启用并锁定该账户', 'この口座を有効化してロック', 'Enable and lock this account')}</button>
        <div className="live-enable-field disable-field"><label>{t('输入 DISABLE 停用', 'DISABLEと入力して無効化', 'Type DISABLE to disable')}</label><input type="text" maxLength={8} value={disableWord} disabled={!enabled} onChange={(event) => setDisableWord(event.target.value.toUpperCase())} placeholder="DISABLE" /></div>
        <button className="cancel" disabled={busy || !gateRunning || !paired || !enabled || disableWord !== 'DISABLE'} onClick={disableLive}>{t('停用，回到全局锁定', '無効化して全体ロックへ', 'Disable and return to the global lock')}</button>
      </div>
      <div className="live-status-grid">
        <article><span>{t('环境标记', '環境マーカー', 'Environment tag')}</span><b>{live?.env_marker || t('无', 'なし', 'None')}</b><small>{t('EA 与网关逐笔核对此标记；不一致即拒单。', 'EAとゲートウェイが毎回照合します。不一致なら拒否。', 'The EA and gateway check this tag on every order; a mismatch rejects it.')}</small></article>
        <article><span>{t('总手数 / 持仓上限', '合計ロット／建玉上限', 'Total lots / position cap')}</span><b>{gate?.limits?.max_lots ?? 1} / 10</b><small>{t('仅以 MT4 已成交持仓为准；待执行或拒绝票据不计入。', 'MT4約定済みのみを計数し、待機・拒否意図は含めません。', 'Only MT4-filled positions count; pending or rejected intents do not.')}</small></article>
        <article><span>{t('待执行意图', '待機中の意図', 'Pending intent')}</span><b className={gate?.pending ? '' : 'positive'}>{gate?.pending ? t('1 个待执行', '1件待機', '1 pending') : t('无', 'なし', 'None')}</b><small>{t('意图 90 秒有效，过期自动作废。', '意図は90秒間有効で期限切れ自動無効。', 'The intent is valid for 90 seconds and voids itself on expiry.')}</small></article>
        <article><span>{t('账户快照', '口座スナップショット', 'Account snapshot')}</span><b>{gate?.live_account_updated_at ?? t('待回传', '受信待ち', 'Awaiting report')}</b><small>{t('仅回传只读状态与仓位。', '読取専用状態とポジションのみ送信。', 'Reports read-only status and positions only.')}</small></article>
      </div>
    </details>
    {notice && <p className="demo-execution-notice">{notice}</p>}
    <div className="execution-safety-actions live"><button className="close-all-button" onClick={() => void closeAll()} disabled={!gateRunning || !paired || !enabled || !positions.length || gate?.close_pending || closingAll}>{closingAll || gate?.close_pending ? t('实盘平仓处理中…', '実取引決済処理中…', 'Closing live positions…') : t('一键平掉全部实盘持仓', '実取引保有を一括決済', 'Close all live positions')}</button><small>{t('真实资金操作：仅关闭本 EA 管理的实盘持仓；即使急停已开启也保留此减险通道。', '実資金操作：このEAの保有のみ決済。緊急停止中もリスク削減経路を維持します。', 'Real-money action: closes only positions managed by this EA; this risk-reducing path remains available during emergency stop.')}</small></div>
    <div className="demo-realtime-panel">
      <div className="section-title"><b>{bilingual('实盘账户与持仓（只读回传）', '実取引口座と保有（読取専用）', 'live account & positions (read-only)')}</b><span>{t(`已启用账户：${enabled ? `${live?.broker_name} #${live?.account_number}` : t('未启用', '未有効化', 'Not enabled')}`, `有効化口座：${enabled ? `${live?.broker_name} #${live?.account_number}` : t('未启用', '未有効化', 'Not enabled')}`, `Enabled account: ${enabled ? `${live?.broker_name} #${live?.account_number}` : t('未启用', '未有効化', 'Not enabled')}`)}</span></div>
      {positions.length === 0 && <p className="empty-state">{t('当前没有由实盘 EA 创建的持仓。', '現在この実取引EAが作成した保有はありません。', 'No positions created by the live EA right now.')}</p>}
      {positions.map((position) => <article className="demo-position-row" key={position.ticket}>
        <b>#{position.ticket} · {position.symbol} · {position.side === 'long' ? t('买入', '買い', 'Buy') : t('卖出', '売り', 'Sell')} {position.lots.toFixed(2)}</b>
        <span>{t('开仓', '建値', 'Open')} {position.open_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)} → {t('现价', '現値', 'Price')} {position.current_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</span>
        <span>{t('止损', 'SL', 'SL')} {position.stop_loss.toFixed(position.symbol.includes('JPY') ? 3 : 5)} · {t('目标', 'TP', 'TP')} {position.take_profit.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</span>
        <strong className={position.profit + position.swap + position.commission >= 0 ? 'positive' : 'negative'}>{t('浮动盈亏', '評価損益', 'Floating P&L')} {(position.profit + position.swap + position.commission).toFixed(2)}</strong>
      </article>)}
      <div className="demo-closed-ledger">
        <div className="section-title"><b>{bilingual('实盘已平仓与学习回传', '実取引決済済み・学習返送', 'closed live trades & learning feedback')}</b><span>{t('由 MT4 回传真实成交结果；策略编号和分析请求编号随订单保存。', 'MT4が実約定結果を返送し、方針IDと分析リクエストIDを注文と共に保存します。', 'MT4 returns actual fills; policy and analysis request IDs stay attached to the order.')}</span></div>
        {(gate?.live_closed_positions ?? []).slice(0, 12).map((position) => <article key={position.ticket}>
          <b>#{position.ticket} · {position.symbol} · {position.side === 'long' ? t('买入', '買い', 'Buy') : t('卖出', '売り', 'Sell')} {Number(position.lots).toFixed(2)}</b>
          <span>{Number(position.open_price).toFixed(position.symbol.includes('JPY') ? 3 : 5)} → {Number(position.close_price).toFixed(position.symbol.includes('JPY') ? 3 : 5)} · {position.closed_at}</span>
          <small>{position.timeframe} · policy {position.policy_id.slice(0, 12)}… · request {position.request_id.slice(0, 12)}…</small>
          <strong className={Number(position.profit) + Number(position.swap) + Number(position.commission) >= 0 ? 'positive' : 'negative'}>{(Number(position.profit) + Number(position.swap) + Number(position.commission)).toFixed(2)}</strong>
        </article>)}
        {!(gate?.live_closed_positions?.length) && <p className="empty-state">{t('尚无带完整策略身份的实盘平仓记录。', '完全な方針ID付き実取引決済記録はまだありません。', 'No closed live trade with complete policy identity yet.')}</p>}
      </div>
      <div className="demo-execution-rules">
        <article><p className="eyebrow">FAIL-CLOSED</p><b>{t('任一异常都拒绝执行', '異常時はすべて実行拒否', 'Any anomaly rejects execution')}</b><span>{t('非实盘账户、账户/券商不匹配、急停、意图过期、点差过大、手数或止损目标无效、保证金不足、已达每日亏损上限，任一命中即拒单。', '実取引以外、口座／ブローカー不一致、緊急停止、期限切れ、スプレッド超過、無効ロット/SL/TP、証拠金不足、日次損失上限到達のいずれかで拒否。', 'Non-live account, account/broker mismatch, emergency stop, expired intent, excessive spread, invalid lots or stop/target, insufficient margin, or the daily loss cap reached — any hit rejects the order.')}</span></article>
        <article><p className="eyebrow">NO HIDDEN TRIGGER</p><b>{t('没有隐藏自动触发', '隠れた自動起動なし', 'No hidden auto-triggers')}</b><span>{t('意图由量化服务产生，EA 独立复核后执行；任何一步缺失都不会下单。前端不提供人工买卖入口。', '意図は定量サービスが生成し、EAが独立検証して実行します。欠けていると注文されません。フロントエンドに手動売買入口はありません。', 'Intents are produced by the quant service and executed only after independent EA re-checks; if any step is missing nothing is sent. The frontend offers no manual buy/sell entrance.')}</span></article>
        <article><p className="eyebrow">AUDIT & KEY ISOLATION</p><b>{t('审计不可覆盖', '監査は上書き不可', 'Audit cannot be overwritten')}</b><span>{t('所有启用/停用/指令/执行都写入本机追加式审计文件；账号密码与 API 密钥永不进入日志、网页或前端。', '有効化・無効化・指示・実行はすべてローカルの追記監査に記録。パスワードとAPIキーはログ・Web・フロントに一切入りません。', 'All enable/disable/intent/execution events go into a local append-only audit file; account passwords and API keys never enter logs, web pages or the frontend.')}</span></article>
      </div>
    </div>
    <details className="demo-audit">
      <summary className="section-title"><b>{bilingual('实盘审计回执', '実取引監査レシート', 'live audit receipt')}</b><span>{t('展开查看最近 8 条', '展開して直近8件を表示', 'expand for latest 8')}</span></summary>
      {(gate?.audit ?? []).filter((row) => row[0] !== 'time').slice(0, 8).map((row, index) => <article key={`${row.join('-')}-${index}`}><time>{row[0] ?? '—'}</time><b>{row[2] ?? '—'}</b><span>{row[3] ?? '—'}</span></article>)}
      {(gate?.audit ?? []).filter((row) => row[0] !== 'time').length === 0 && <p className="empty-state">{t('尚无实盘审计记录。启用或创建意图后才会产生。', '実取引の監査記録はまだありません。有効化または意図作成後に発生します。', 'No live audit records yet. They appear after enablement or intent creation.')}</p>}
    </details>
  </section>;
}
