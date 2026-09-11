'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildResearchSignal } from '../lib/research-signal';
import { QUOTES, type MarketQuote, type OhlcBar, type PairSymbol } from '../lib/market-data';
import { modelDefinition, modelLogic, modelName } from '../lib/model-catalog';
import type { AdaptiveState } from '../lib/adaptive-research';
import { findMt4Quote, type Mt4HistorySnapshot, type Mt4QuoteSnapshot } from '../lib/mt4-bridge';
import { AiTerminalClient, createAiEventId, type AiPolicy, type AiTerminalStatus } from '../lib/ai-terminal';
import { buildAiMarketSummary } from '../lib/market-summary';
import { loadAiPolicy, removeExpiredAiPolicies, saveAiPolicy } from '../lib/ai-policy-store';
import { composeDecision } from '../lib/decision-composer';
import { enqueueEvaluationEvent, flushEvaluationOutbox } from '../lib/ai-evaluation-outbox';
import AiEvaluationLedger from './ai-evaluation-ledger';
import AiRiskAdvisor, { type DemoRiskSuggestion } from './ai-risk-advisor';
import { decidePositionManagement } from '../lib/position-management';

type Language = 'zh' | 'ja' | 'en';
type ExecutionTimeframe = 'M1' | 'M5' | 'M15';
type DisplayTimeZone = 'Asia/Tokyo' | 'America/New_York' | 'Europe/London' | 'Asia/Shanghai';
type Position = { ticket: number; symbol: string; side: 'long' | 'short'; lots: number; open_price: number; profit: number };
type ClosedPosition = { ticket: number; policy_id: string; request_id: string; timeframe: 'M5' | 'M15'; symbol: string; side: 'long' | 'short'; lots: number; open_price: number; close_price: number; opened_at: string; closed_at: string; profit: number; swap: number; commission: number; spread_pips: number; slippage_pips: number };
type Gate = { status?: string; pending?: boolean; close_pending?: boolean; killed?: boolean; kill_reason?: 'manual-emergency' | 'startup-safe' | null; demo_account?: { balance?: number; equity?: number; free_margin?: number; margin?: number; leverage?: number; currency?: string } | null; demo_positions?: Position[]; demo_closed_positions?: ClosedPosition[] };
type Log = { id: string; time: string; barTime: number; kind: 'observed' | 'blocked' | 'ticket' | 'close'; detail: string };
type Session = { version: number; armed: boolean; demoOnly: boolean; acceptScope: boolean; useMinimumScore: boolean; useCooldown: boolean; useScaleIn: boolean; useExitScore: boolean; useSpreadCap: boolean; minimumScore: number; cooldownMinutes: number; maxSpreadPips: number; maxPositions: number; entryLots: number; scaleInPips: number; exitScore: number; executionSymbol: PairSymbol; executionTimeframe: ExecutionTimeframe; lastActionAt: number; lastBarTime: number | null };

const CODE = 'enkei-demo-gate-pairing-code'; const VERIFIED = 'enkei-demo-gate-pairing-verified'; const LOGS = 'enkei-demo-automation-log'; const STATE = 'enkei-demo-automation-session'; const VERSION = 6;
const PROCESSED_OUTCOMES = 'enkei-demo-processed-outcomes/v2';
function claimPolicyOutcome(position: ClosedPosition) { if (typeof window === 'undefined' || !position.policy_id) return null; const key = `${position.ticket}:${position.closed_at}`; let done: string[] = []; try { done = JSON.parse(localStorage.getItem(PROCESSED_OUTCOMES) ?? '[]') as string[]; } catch {} if (done.includes(key)) return null; localStorage.setItem(PROCESSED_OUTCOMES, JSON.stringify([...done.slice(-499), key])); return { policy_id: position.policy_id, symbol: position.symbol.replace('/', ''), timeframe: position.timeframe, outcome_event_id: createAiEventId() }; }
const defaults: Session = { version: VERSION, armed: false, demoOnly: false, acceptScope: false, useMinimumScore: true, useCooldown: true, useScaleIn: true, useExitScore: true, useSpreadCap: true, minimumScore: 55, cooldownMinutes: 0, maxSpreadPips: 3, maxPositions: 2, entryLots: .01, scaleInPips: 8, exitScore: 35, executionSymbol: 'USD/JPY', executionTimeframe: 'M5', lastActionAt: 0, lastBarTime: null };
const num = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
function loadSession(): Session { if (typeof window === 'undefined') return defaults; try { const raw = localStorage.getItem(STATE) ?? sessionStorage.getItem(STATE) ?? '{}'; const old = JSON.parse(raw) as Partial<Session> & { acceptLimit?: boolean }; const migratedTimeframe: ExecutionTimeframe = old.executionTimeframe === 'M1' ? 'M1' : old.executionTimeframe === 'M15' ? 'M15' : 'M5'; return { ...defaults, ...old, version: VERSION, armed: Boolean(old.armed), demoOnly: Boolean(old.demoOnly), acceptScope: Boolean(old.acceptScope ?? old.acceptLimit), minimumScore: num(old.minimumScore, 55), cooldownMinutes: Math.max(0, num(old.cooldownMinutes, 0)), maxSpreadPips: num(old.maxSpreadPips, 3), maxPositions: Math.max(1, Math.min(10, Math.round(num(old.maxPositions, 2)))), entryLots: Math.max(.01, Math.min(1, num(old.entryLots, .01))), scaleInPips: Math.max(0, num(old.scaleInPips, 8)), exitScore: num(old.exitScore, 35), executionSymbol: QUOTES.some((x) => x.symbol === old.executionSymbol) ? old.executionSymbol as PairSymbol : 'USD/JPY', executionTimeframe: migratedTimeframe, lastActionAt: num(old.lastActionAt, 0), lastBarTime: Number.isFinite(old.lastBarTime) ? Number(old.lastBarTime) : null }; } catch { return defaults; } }
function loadLogs() { if (typeof window === 'undefined') return [] as Log[]; try { return JSON.parse(localStorage.getItem(LOGS) ?? '[]') as Log[]; } catch { return []; } }

export default function DemoAutomationPanel({ language, snapshot, visible, adaptiveState, displayTimeZone = 'Asia/Tokyo' }: { language: Language; snapshot: Mt4QuoteSnapshot | null; visible: boolean; adaptiveState: AdaptiveState; displayTimeZone?: DisplayTimeZone }) {
  const [session, setSession] = useState<Session>(defaults); const [restored, setRestored] = useState(false); const [gate, setGate] = useState<Gate | null>(null); const [history, setHistory] = useState<Mt4HistorySnapshot | null>(null); const [paired, setPaired] = useState(false); const [phrase, setPhrase] = useState(''); const [notice, setNotice] = useState(''); const [logs, setLogs] = useState<Log[]>(loadLogs); const [now, setNow] = useState(0); const [connectionState, setConnectionState] = useState<'stable' | 'recovering' | 'manual-stop' | 'paused' | 'waiting'>('waiting'); const [aiPolicy, setAiPolicy] = useState<AiPolicy | null>(null); const [confirmationPolicy, setConfirmationPolicy] = useState<AiPolicy | null>(null); const [aiStatus, setAiStatus] = useState<AiTerminalStatus>({ state: 'idle', detail: 'terminal-not-configured', lastUpdatedAt: null, etag: null }); const [evaluationSync, setEvaluationSync] = useState({ pending: 0, detail: '' }); const [policyRefreshNonce, setPolicyRefreshNonce] = useState(0); const lastCandle = useRef<number | null>(null); const lastAiAssessment = useRef<number | null>(null); const lastRecoveryAt = useRef(0); const recoveryBusy = useRef(false); const gateFailures = useRef(0); const aiTerminal = useRef(new AiTerminalClient());
  const t = useCallback((zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en, [language]); const bi = useCallback((zh: string, ja: string, en: string) => t(zh, ja, en), [t]);
  const logDetail = useCallback((detail: string) => detail.replace(/(?:只记录，不执行。|記録のみ、実行しません。|Records only; never executes\.)$/, t('只记录，不执行。', '記録のみ、実行しません。', 'Records only; never executes.')), [t]);
  const quote = useMemo<MarketQuote>(() => { const base = QUOTES.find((x) => x.symbol === session.executionSymbol) ?? QUOTES[0]; const live = findMt4Quote(snapshot, session.executionSymbol); const epoch = Number(snapshot?.gmt_epoch); const receivedAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : ''; return live ? { ...base, bid: live.bid, ask: live.ask, receivedAt, source: 'mt4' } : base; }, [session.executionSymbol, snapshot]);
  const bars = useMemo(() => history?.bars ?? [] as OhlcBar[], [history]); const timeframe = session.executionTimeframe; const model = adaptiveState.timeframeDecisions[timeframe]?.selectedModel ?? adaptiveState.selectedModel; const activeModel = modelDefinition(model); const signal = useMemo(() => buildResearchSignal(bars, quote.symbol, timeframe, model), [bars, model, quote.symbol, timeframe]); const completed = bars.at(-2);
  const composedDecision = useMemo(() => composeDecision({ signal, selectedRuleModel: model, policy: aiPolicy }), [aiPolicy, model, signal]);
  const decisionReason = useMemo(() => {
    // The terminal contract supplies a Chinese rationale today. Other interface
    // languages receive a translated decision explanation rather than a fake quote.
    const aiReason = language === 'zh' ? aiPolicy?.rationale_zh : undefined;
    switch (composedDecision.reasonCode) {
      case 'ai-policy-unavailable': return bi('AI 暂无可用且未过期的判断，当前仅使用快速规则模型；AI 恢复后会在下一根 M5/M15 完成K线重新参与。', 'AIの有効期限内方針がないため、現在は高速ルールモデルのみを使用しています。AI復帰後、次のM5/M15確定足で再参加します。', 'No current AI policy; the fast rule model is active until the next valid M5/M15 assessment.');
      case 'ai-veto-wait': return `${bi('AI 建议暂不建立新仓。', 'AIは新規建てを見送るよう提案しています。', 'AI recommends no new entry.')} ${aiReason ?? ''}`;
      case 'ai-veto-close': return `${bi('AI 建议优先退出或处理已有仓位。', 'AIは既存ポジションの退出・処理を優先するよう提案しています。', 'AI recommends managing or exiting open positions.')} ${aiReason ?? ''}`;
      case 'rule-trigger-not-ready': return `${bi('AI 方向许可，但本根快速规则尚未形成可执行触发，继续观察。', 'AIの方向は許可されていますが、現在足の高速ルールが未成立です。監視を続けます。', 'AI direction is allowed, but the fast trigger is not ready.')} ${aiReason ?? ''}`;
      case 'ai-rule-direction-conflict': return `${bi('AI 与快速规则方向不一致，因此不建立新仓，等待下一根完成K线复核。', 'AIと高速ルールの方向が不一致のため、新規建てを見送り次の確定足で再評価します。', 'AI and the fast rule disagree; wait for the next completed bar.')} ${aiReason ?? ''}`;
      default: return `${bi('AI 判断与快速规则方向一致，仍会在执行前复核点差、仓位和保护条件。', 'AI判断と高速ルールが一致しています。実行前にスプレッド・保有数・保護条件を再確認します。', 'AI and fast rule agree; spread, positions, and protections are rechecked before execution.')} ${aiReason ?? ''}`;
    }
  }, [aiPolicy?.rationale_zh, bi, composedDecision.reasonCode, language]);
  const historyReady = Boolean(history && bars.length >= 600 && (history.clock.status === 'aligned' || history.clock.status === 'offset-corrected')); const positions = useMemo(() => (gate?.demo_positions ?? []).filter((x) => x.symbol.replace('/', '') === quote.symbol.replace('/', '')), [gate?.demo_positions, quote.symbol]); const lots = positions.reduce((a, x) => a + x.lots, 0); const average = lots ? positions.reduce((a, x) => a + x.open_price * x.lots, 0) / lots : 0; const pip = quote.symbol.endsWith('/JPY') ? .01 : .0001;
  const gateReady = gate?.status === 'ready' && !gate?.killed && !gate?.pending && !gate?.close_pending; const cooldown = !session.useCooldown || !session.lastActionAt || now - session.lastActionAt >= session.cooldownMinutes * 60_000;
  const gateReason = useMemo(() => {
    if (gate?.killed && gate.kill_reason === 'manual-emergency') return t('人工急停中；不会自动解除', '手動緊急停止中。自動解除しません', 'Manual emergency stop active; it is never auto-released');
    if (gate?.killed && gate.kill_reason === 'startup-safe') return t('执行服务处于启动保护暂停；请在设置中重新启动后再继续。', '実行サービスは起動保護で停止中です。設定から再開してください。', 'The execution service is in startup-protection pause; restart it from Settings before continuing.');
    if (gate?.killed) return t('执行服务已暂停；不会反复自动重启。', '実行サービスは停止中です。繰り返し自動再起動しません。', 'The execution service is stopped; it will not be restarted automatically in a loop.');
    if (gate?.pending || gate?.close_pending) return t('上一条 Demo 指令正在等待 MT4 确认', '直前のDemo指示はMT4確認待ち', 'The previous Demo order is waiting for MT4 confirmation');
    if (!gate) return connectionState === 'recovering' ? t('本机执行连接恢复中', '端末内実行接続を復旧中', 'Reconnecting the local execution link') : t('本机执行服务暂时不可达', '端末内実行サービスに一時接続不可', 'The local execution service is temporarily unreachable');
    if (!paired) return t('本机服务在线；本页尚未恢复配对，不会下达新 Demo 指令', '端末サービスはオンラインですが、このページのペアリングは未復旧です。新しいDemo指示は送信しません', 'The local service is online; pairing on this page is not restored yet and no new Demo order will be sent');
    return t('本机执行连接尚未稳定', '端末内実行接続が未安定', 'The local execution link is not stable yet');
  }, [connectionState, gate, paired, t]);
  const blocks = useMemo(() => { const result: string[] = []; if (!historyReady || quote.source !== 'mt4') result.push(t('MT4 历史或实时报价未校准', 'MT4履歴または実レートが未補正', 'MT4 history or live quotes are not calibrated')); if (session.useSpreadCap && (session.maxSpreadPips < .1 || session.maxSpreadPips > 50)) result.push(t('Demo 点差上限须为 0.1–50.0 pips', 'Demoスプレッド上限は0.1–50.0 pips', 'The Demo spread cap must be 0.1–50.0 pips')); else if (session.useSpreadCap && quote.spreadPips > session.maxSpreadPips) result.push(t(`点差 ${quote.spreadPips.toFixed(1)} 超过上限`, `スプレッド ${quote.spreadPips.toFixed(1)} が上限超過`, `Spread ${quote.spreadPips.toFixed(1)} exceeds the cap`)); return result; }, [historyReady, quote.source, quote.spreadPips, session.maxSpreadPips, session.useSpreadCap, t]);
  const rationale = useMemo(() => { const d = adaptiveState.timeframeDecisions[timeframe]; if (!adaptiveState.enabled) return t('自主研究暂停时保留上一次选择；其他页面的查看操作不会影响演练。', '自律研究停止中は前回選択を維持し、他画面の閲覧操作は演習に影響しません。', 'While autonomous research is paused the last selection is kept; browsing other pages never affects the exercise.'); if (!d) return t(`${timeframe} 正在收集数据，暂时维持“${activeModel.zh}”。`, `${timeframe}はデータ収集中のため「${activeModel.ja}」を維持します。`, `${timeframe} is still collecting data; keeping "${activeModel.id}" for now.`); return t(`${timeframe} 选择“${activeModel.zh}”：在 ${d.dataMarkets} 个已校准市场中综合领先，连续领先 ${d.leaderStreak}/3。每根完成K线都会重新决定多、空、加仓、退出或观望。`, `${timeframe}は「${activeModel.ja}」を選択：補正済み${d.dataMarkets}市場で総合首位、連続首位 ${d.leaderStreak}/3。確定足ごとに買い・売り・加算・退出・待機を再判定します。`, `${timeframe} picked "${activeModel.id}": leading across ${d.dataMarkets} calibrated markets, streak ${d.leaderStreak}/3. Every completed candle re-decides long, short, add-on, exit or standby.`); }, [activeModel.id, activeModel.ja, activeModel.zh, adaptiveState.enabled, adaptiveState.timeframeDecisions, t, timeframe]);

  useEffect(() => { const id = setTimeout(() => { const next = loadSession(); lastCandle.current = next.lastBarTime; setSession(next); setRestored(true); }, 0); return () => clearTimeout(id); }, []); useEffect(() => { if (restored) localStorage.setItem(STATE, JSON.stringify(session)); }, [restored, session]);
  useEffect(() => { const id = setTimeout(() => { removeExpiredAiPolicies(); setAiPolicy(loadAiPolicy(session.executionSymbol, timeframe)); }, 0); return () => clearTimeout(id); }, [session.executionSymbol, timeframe]);
  useEffect(() => { let live = true; const refresh = async () => { try { const limit = timeframe === 'M1' ? 3000 : 5000; const r = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(session.executionSymbol.replace('/', ''))}&timeframe=${timeframe}&limit=${limit}`, { cache: 'no-store' }); if (!r.ok) throw new Error(); if (live) setHistory(await r.json() as Mt4HistorySnapshot); } catch { if (live) setHistory(null); } }; void refresh(); const id = setInterval(() => { void refresh(); }, 15_000); return () => { live = false; clearInterval(id); }; }, [session.executionSymbol, timeframe]);
  useEffect(() => {
    if (timeframe === 'M1') {
      const id = setTimeout(() => { setAiPolicy(null); setAiStatus({ state: 'idle', detail: 'm1-fast-rule-only', lastUpdatedAt: null, etag: null }); }, 0);
      return () => clearTimeout(id);
    }
    let live = true;
    const refresh = async () => {
      const result = await aiTerminal.current.getCurrentPolicy(session.executionSymbol, timeframe);
      const confirmation = await aiTerminal.current.getCurrentPolicy(session.executionSymbol, timeframe === 'M5' ? 'M15' : 'M5');
      if (!live) return;
      setConfirmationPolicy(confirmation.policy);
      setAiStatus((previous) => previous.state === result.status.state && previous.detail === result.status.detail && previous.etag === result.status.etag ? previous : result.status);
      if (result.policy && result.status.state === 'ready') {
        saveAiPolicy(result.policy);
        setAiPolicy(result.policy);
      } else if (result.status.state === 'invalid') {
        setAiPolicy(null);
      }
    };
    void refresh();
    const id = setInterval(() => { void refresh(); }, 5_000);
    return () => { live = false; clearInterval(id); };
  }, [session.executionSymbol, timeframe]);
  useEffect(() => {
    if (!completed || timeframe === 'M1' || completed.time === lastAiAssessment.current) return;
    lastAiAssessment.current = completed.time;
    const summary = buildAiMarketSummary({ symbol: quote.symbol, timeframe, quote, bars, selectedRuleModel: model, positions: positions.map((position) => ({ side: position.side, lots: position.lots, open_price: position.open_price, profit: position.profit })), previousPolicy: aiPolicy });
    if (!summary) return;
    void aiTerminal.current.submitAssessment(summary).then((status) => setAiStatus((previous) => previous.state === status.state && previous.detail === status.detail ? previous : status));
  }, [aiPolicy, bars, completed, model, policyRefreshNonce, positions, quote, timeframe]);
  // The terminal owns the official evaluation ledger. This is only a durable
  // browser delivery queue, so a page switch or brief terminal restart cannot
  // erase a completed M5/M15 decision before the terminal receives it.
  useEffect(() => {
    let live = true;
    const flush = async () => {
      const result = await flushEvaluationOutbox(aiTerminal.current);
      if (live) setEvaluationSync((previous) => previous.pending === result.pending && previous.detail === (result.newestError ?? '') ? previous : { pending: result.pending, detail: result.newestError ?? '' });
    };
    void flush();
    const id = setInterval(() => void flush(), 5_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  const refreshGate = useCallback(async () => { try { const r = await fetch('http://127.0.0.1:8790/api/status', { cache: 'no-store' }); if (!r.ok) throw new Error('gate-status-unavailable'); const next = await r.json() as Gate; gateFailures.current = 0; setGate((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); } catch { gateFailures.current += 1; /* Browser throttling must not erase the last server-confirmed state. */ if (gateFailures.current >= 3) setConnectionState('waiting'); } }, []); useEffect(() => { const initial = setTimeout(() => void refreshGate(), 0); const id = setInterval(() => { setNow(Date.now()); void refreshGate(); }, 2_000); const resume = () => void refreshGate(); window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume); return () => { clearTimeout(initial); clearInterval(id); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); }; }, [refreshGate]);
  const verify = useCallback(async () => { let code = sessionStorage.getItem(CODE); try { if (!code) { const start = await fetch('http://127.0.0.1:8787/api/demo/start', { method: 'POST' }); const state = await start.json() as { pairing_code?: string }; if (!start.ok || !state.pairing_code) return false; code = state.pairing_code; sessionStorage.setItem(CODE, code); } const r = await fetch('http://127.0.0.1:8790/api/pair', { method: 'POST', headers: { 'X-Enkei-Demo-Code': code } }); if (!r.ok) throw new Error(); sessionStorage.setItem(VERIFIED, 'true'); setPaired(true); return true; } catch { sessionStorage.removeItem(VERIFIED); setPaired(false); return false; } }, []); useEffect(() => { if (!restored) return; const initial = setTimeout(() => void verify(), 0); return () => clearTimeout(initial); }, [restored, verify]);
  const recoverConnection = useCallback(async () => {
    if (!session.armed || recoveryBusy.current || Date.now() - lastRecoveryAt.current < 8_000) return;
    if (gate?.killed && gate.kill_reason === 'manual-emergency') { setConnectionState('manual-stop'); return; }
    recoveryBusy.current = true; lastRecoveryAt.current = Date.now(); setConnectionState('recovering');
    try {
      const start = await fetch('http://127.0.0.1:8787/api/demo/start', { method: 'POST' });
      const started = await start.json() as { pairing_code?: string };
      if (!start.ok || !started.pairing_code) throw new Error('service-start-failed');
      sessionStorage.setItem(CODE, started.pairing_code);
      const pair = await fetch('http://127.0.0.1:8790/api/pair', { method: 'POST', headers: { 'X-Enkei-Demo-Code': started.pairing_code } });
      if (!pair.ok) throw new Error('pairing-recovery-failed');
      sessionStorage.setItem(VERIFIED, 'true'); setPaired(true);
      const status = await (await fetch('http://127.0.0.1:8790/api/status', { cache: 'no-store' })).json() as Gate;
      if (status.killed && status.kill_reason === 'startup-safe') {
        const reset = await fetch('http://127.0.0.1:8790/api/kill/reset', { method: 'POST', headers: { 'X-Enkei-Demo-Code': started.pairing_code } });
        if (!reset.ok) throw new Error('startup-safe-release-failed');
      }
      await refreshGate(); setConnectionState('stable'); setNotice(t('自动演练已恢复本机执行连接；人工急停不会被自动解除。', '自動演習が端末内実行接続を復旧しました。手動緊急停止は自動解除されません。', 'Automated practice has restored the local execution link; the manual emergency stop is never auto-released.'));
    } catch { setConnectionState('waiting'); }
    finally { recoveryBusy.current = false; }
  }, [gate, refreshGate, session.armed, t]);
  useEffect(() => { if (!restored || !session.armed) return; if (gate?.killed && gate.kill_reason === 'manual-emergency') { const id = setTimeout(() => setConnectionState('manual-stop'), 0); return () => clearTimeout(id); } if (gateReady && paired) { const id = setTimeout(() => setConnectionState('stable'), 0); return () => clearTimeout(id); } const initial = setTimeout(() => void recoverConnection(), 750); const id = setInterval(() => void recoverConnection(), 5_000); return () => { clearTimeout(initial); clearInterval(id); }; }, [gate, gateReady, paired, recoverConnection, restored, session.armed]);
  const append = useCallback((kind: Log['kind'], barTime: number, detail: string) => setLogs((old) => {
    // A single completed bar may be observed by several one-second polls. Keep one readable receipt.
    if (old.some((item) => item.kind === kind && item.barTime === barTime && item.detail === detail)) return old;
    const next = [{ id: `${Date.now()}-${Math.random()}`, time: new Date().toISOString(), barTime, kind, detail }, ...old].slice(0, 100);
    localStorage.setItem(LOGS, JSON.stringify(next));
    return next;
  }), []);
  const service = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8787/api/demo/start', { method: 'POST' });
      const data = await response.json() as { pairing_code?: string };
      if (!response.ok || !data.pairing_code) throw new Error();
      sessionStorage.setItem(CODE, data.pairing_code); sessionStorage.removeItem(VERIFIED); setPaired(false);
      setNotice(t('代码已输入，尚未真正配对；请点击“验证连接”。', 'コードは入力済みです。まだペアリング完了ではないため「接続を検証」を押してください。', 'The code has been entered but pairing is not complete yet; click “Verify connection”.'));
    } catch { setNotice(t('无法启动 Demo 服务，请先在运营页面启动本机服务。', 'Demoサービスを起動できません。先に運用画面から端末サービスを起動してください。', 'The Demo service could not start; start the local service from the Operations page first.')); }
  };
  const connect = async () => {
    if (await verify()) { sessionStorage.setItem(VERIFIED, 'true'); setNotice(t('已验证连接；本浏览器切换页面无需重新配对。', '接続を検証しました。このブラウザ内の画面切替で再ペアリングは不要です。', 'Connection verified; switching pages in this browser does not require re-pairing.')); }
    else setNotice(t('配对失败，未创建任何指令。', 'ペアリング失敗。指示は作成されていません。', 'Pairing failed; no order was created.'));
  };
  const release = async () => {
    const code = sessionStorage.getItem(CODE); if (!code || !paired) { setNotice(t('请先验证连接。', '先に接続を検証してください。', 'Verify the connection first.')); return; }
    try { const response = await fetch('http://127.0.0.1:8790/api/kill/reset', { method: 'POST', headers: { 'X-Enkei-Demo-Code': code } }); if (!response.ok) throw new Error(); void refreshGate(); setNotice(t('Demo 急停已解除；仍须启用自动演练。', 'Demo緊急停止を解除しました。自動演習は別途有効化が必要です。', 'The Demo emergency stop has been released; automated practice still needs to be enabled.')); }
    catch { setNotice(t('无法解除急停。', '緊急停止を解除できません。', 'The emergency stop could not be released.')); }
  };
  const enableAutomation = async () => {
    const expectedPhrase = language === 'zh' ? '确认自动演练' : language === 'ja' ? '自動演習を確認' : 'AUTO-DEMO';
    if (phrase !== expectedPhrase || !session.demoOnly || !session.acceptScope) { setNotice(t('请输入“确认自动演练”，并勾选两项确认。', '「自動演習を確認」と入力し、2つの確認を完了してください。', 'Type AUTO-DEMO and tick both confirmations.')); return; }
    if (!paired) { setNotice(t('请先启动并验证 Demo 连接。', '先にDemo接続を起動して検証してください。', 'Start and verify the Demo connection first.')); return; }
    if (gate?.killed) {
      const code = sessionStorage.getItem(CODE);
      if (!code) { setNotice(t('Demo 配对信息已失效，请重新验证连接。', 'Demoペアリング情報が失効しました。接続を再検証してください。', 'The Demo pairing has expired; verify the connection again.')); return; }
      try {
        const response = await fetch('http://127.0.0.1:8790/api/kill/reset', { method: 'POST', headers: { 'X-Enkei-Demo-Code': code } });
        if (!response.ok) throw new Error();
        await refreshGate();
      } catch { setNotice(t('无法解除 Demo 急停，自动演练未启动。', 'Demo緊急停止を解除できないため、自動演習は開始されませんでした。', 'The Demo emergency stop could not be released, so automated practice was not started.')); return; }
    }
    setSession((s) => ({ ...s, armed: true })); setPhrase('');
    setNotice(t('自动演练已启用：将在新完成K线中自主决定多空、加仓、退出或观望。', '自動演習を有効化しました。新しい確定足で買い・売り・加算・退出・待機を自律選択します。', 'Automated practice enabled: on each new completed candle it will autonomously decide long, short, add-on, exit or standby.'));
  };
  const closeAll = useCallback(async (reason: string, bar: number) => {
    const code = sessionStorage.getItem(CODE); if (!code) return;
    try {
      const response = await fetch('http://127.0.0.1:8790/api/close', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Demo-Code': code }, body: JSON.stringify({ ticket: 0, confirmation: 'DEMO' }) });
      const data = await response.json() as { close?: { id?: string }; error?: string };
      if (!response.ok) throw new Error(data.error);
      // The terminal's outcome contract requires confirmed fill and P/L data.
      // A close request is not an outcome, so it stays in the local execution
      // audit until MT4 publishes an actual closed position.
      setSession((s) => ({ ...s, lastActionAt: Date.now() })); append('close', bar, `${reason}; ${t('已请求 EA 主动退出', 'EAへ能動退出を要求', 'EA proactive exit requested')} ${data.close?.id ?? ''}`); void refreshGate();
    } catch (error) { append('blocked', bar, `${reason}; ${error instanceof Error ? error.message : 'close rejected'}`); }
  }, [append, refreshGate, t]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (!restored || !completed) return;
      if (lastCandle.current === null) { lastCandle.current = completed.time; setSession((s) => ({ ...s, lastBarTime: completed.time })); return; }
      if (completed.time <= lastCandle.current) return;
      lastCandle.current = completed.time;
      setSession((s) => ({ ...s, lastBarTime: completed.time }));
      const base = `${quote.symbol} ${timeframe} ${activeModel.id} ${signal.direction} ${signal.score}`;
      if (timeframe !== 'M1' && aiPolicy?.version === 'enkei-ai-feedback/v2' && aiPolicy.policy_id) {
        const blockedBy = [
          ...blocks.map(() => 'market-data-or-spread'),
          ...(!gateReady ? ['local-gate-not-ready'] : []),
          ...(!paired ? ['browser-not-paired'] : []),
          ...(!cooldown ? ['cooldown'] : []),
          ...(signal.direction === 'wait' ? ['fast-rule-wait'] : []),
          ...(signal.score < session.minimumScore ? ['score-threshold'] : []),
        ];
        const adopted = composedDecision.authority === 'ai-and-rule' || composedDecision.authority === 'ai-veto';
        enqueueEvaluationEvent({
          event_id: createAiEventId(), type: 'decision', policy_id: aiPolicy.policy_id,
          request_id: aiPolicy.request_id,
          symbol: quote.symbol.replace('/', ''), timeframe,
          decision_generated_at: new Date().toISOString(), adopted,
          reject_reason: adopted ? null : composedDecision.authority === 'conflict-wait' ? 'rule_conflict' : 'missing',
          final_action: composedDecision.action,
          gate_summary: { rules_checked: 6, rules_passed: Math.max(0, 6 - blockedBy.length), blocked_by: blockedBy },
          ai_provider: aiPolicy.provider, ai_model: aiPolicy.model_id, ai_model_version: aiPolicy.model_version,
          ai_direction: aiPolicy.action_bias, ai_confidence: aiPolicy.confidence, market_regime: aiPolicy.market_regime,
          strategy_model: activeModel.id, strategy_version: activeModel.version, strategy_score: signal.score,
          rationale: aiPolicy.rationale_zh, invalidation: aiPolicy.invalidation,
          evidence: { news: aiPolicy.news_context, feature_summary: aiPolicy.feature_summary },
          environment: 'demo',
        });
      }
      if (!session.armed) { append('observed', completed.time, `${base}; ${t('只记录，不执行。', '記録のみ、実行しません。', 'Records only; never executes.')}`); return; }
      const management = aiPolicy ? decidePositionManagement(aiPolicy, confirmationPolicy, positions.map((x) => x.side)) : null;
      const aiExit = session.useExitScore && management?.action === 'close-all';
      if (aiExit && gateReady && paired) { void closeAll(`${base}; ${management?.classification === 'confirmed-reversal' ? t('AI 跨周期确认趋势反转', 'AIが時間足横断でトレンド反転を確認', 'AI confirmed a cross-timeframe trend reversal') : t('AI 明确退出', 'AIの明確な退出', 'AI explicit exit')}`, completed.time); return; }
      if (blocks.length || !gateReady || !paired || !cooldown || signal.direction === 'wait' || (session.useMinimumScore && signal.score < session.minimumScore)) {
        const why = blocks.length ? blocks.join('；') : !gateReady || !paired ? gateReason : !cooldown ? t('冷却中', 'クールダウン中', 'Cooling down') : signal.direction === 'wait' ? t('策略观望：没有建立新仓、加仓、退出或反转条件', '戦略待機：新規・加算・退出・反転条件なし', 'Strategy standby: no entry, add-on, exit or reversal condition met') : t(`信号低于自定义阈值 ${session.minimumScore}`, `シグナルが任意閾値 ${session.minimumScore} 未満`, `Score below custom threshold ${session.minimumScore}`);
        append('blocked', completed.time, `${base}; ${why}`); return;
      }
      if (positions.length >= session.maxPositions) { append('blocked', completed.time, `${base}; ${t(`已达多仓位上限 ${session.maxPositions}`, `複数ポジション上限 ${session.maxPositions} 到達`, `Max position count ${session.maxPositions} reached`)}`); return; }
      if (lots + session.entryLots > 1.00001) { append('blocked', completed.time, `${base}; ${t('总手数将超过 1.00 硬上限', '合計ロットが1.00上限を超過', 'Total lots would exceed the 1.00 hard cap')}`); return; }
      const same = positions.length === 0 || positions.every((x) => x.side === signal.direction);
      const pullback = !session.useScaleIn || positions.length === 0 || (signal.direction === 'long' ? quote.ask <= average - session.scaleInPips * pip : quote.bid >= average + session.scaleInPips * pip);
      if (!same || !pullback) { append('blocked', completed.time, `${base}; ${t(`未达到同向回撤加仓间距 ${session.scaleInPips} pips`, `同方向の加算間隔 ${session.scaleInPips} pips 未達`, `Same-direction pullback spacing ${session.scaleInPips} pips not met`)}`); return; }
      const code = sessionStorage.getItem(CODE); if (!code) return;
      const stop = 30;
      const stopLoss = signal.direction === 'long' ? quote.bid - stop * pip : quote.ask + stop * pip;
      const takeProfit = signal.direction === 'long' ? quote.ask + stop * 2 * pip : quote.bid - stop * 2 * pip;
      void (async () => {
        try {
          if (!aiPolicy?.policy_id || !aiPolicy.request_id || timeframe === 'M1') throw new Error(t('缺少可追溯的 M5/M15 AI 政策，拒绝提交 Demo 订单', '追跡可能なM5/M15 AI方針がないためDemo注文を拒否しました', 'A traceable M5/M15 AI policy is required for Demo execution'));
          const response = await fetch('http://127.0.0.1:8790/api/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Demo-Code': code }, body: JSON.stringify({ symbol: quote.symbol, side: signal.direction, lots: session.entryLots, stopLoss, takeProfit, maxSpreadPips: session.useSpreadCap ? session.maxSpreadPips : 0, confirmation: 'DEMO', policyId: aiPolicy.policy_id, requestId: aiPolicy.request_id, timeframe }) });
          const data = await response.json() as { ticket?: { id?: string }; error?: string };
          if (!response.ok) throw new Error(data.error);
          setSession((s) => ({ ...s, lastActionAt: Date.now() }));
          append('ticket', completed.time, `${base}; ${positions.length ? t('回撤加仓已提交 EA，等待执行回执', '押し目・戻り加算をEAへ送信、実行応答待ち', 'Add-on submitted to EA; awaiting execution receipt') : t('新建仓已提交 EA，等待执行回执', '新規建てをEAへ送信、実行応答待ち', 'Entry submitted to EA; awaiting execution receipt')} ${data.ticket?.id ?? ''}`);
          void refreshGate();
        } catch (error) { append('blocked', completed.time, `${base}; ${error instanceof Error ? error.message : 'ticket rejected'}`); }
      })();
    }, 0);
    return () => clearTimeout(id);
  }, [activeModel.id, activeModel.version, aiPolicy, append, average, blocks, closeAll, completed, composedDecision.action, composedDecision.authority, confirmationPolicy, cooldown, gateReady, gateReason, lots, paired, pip, positions, quote.ask, quote.bid, quote.symbol, refreshGate, restored, session, signal.direction, signal.score, t, timeframe]);
  useEffect(() => {
    // MT4 is the source of truth for an outcome.  Only a closed position with
    // actual prices and timestamps may become an AI-terminal result event.
    for (const position of gate?.demo_closed_positions ?? []) {
      if (position.symbol.replace('/', '') !== quote.symbol.replace('/', '')) continue;
      const order = claimPolicyOutcome(position);
      const opened = Date.parse(position.opened_at); const closed = Date.parse(position.closed_at);
      if (!order || order.symbol !== quote.symbol.replace('/', '') || !Number.isFinite(opened) || !Number.isFinite(closed) ||
        ![position.open_price, position.close_price, position.profit, position.swap, position.commission].every(Number.isFinite)) continue;
      enqueueEvaluationEvent({
        event_id: order.outcome_event_id, type: 'outcome', policy_id: order.policy_id, symbol: order.symbol, timeframe: order.timeframe,
        direction: position.side, entry_price: position.open_price, exit_price: position.close_price,
        floating_pnl: 0, closed_pnl: position.profit + position.swap + position.commission,
        duration_seconds: Math.max(0, Math.floor((closed - opened) / 1000)), opened_at: position.opened_at, closed_at: position.closed_at,
        environment: 'demo',
        spread_pips: position.spread_pips, slippage_pips: position.slippage_pips,
      });
    }
  }, [gate?.demo_closed_positions, quote.symbol]);
  const change = (key: keyof Session) => (e: React.ChangeEvent<HTMLInputElement>) => { const v = Number(e.target.value); if (Number.isFinite(v)) setSession((s) => ({ ...s, [key]: v })); }; const date = (x: string) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(x));
  const applyAiRisk = (value: DemoRiskSuggestion) => { setSession((current) => ({ ...current, ...value })); setNotice(bi('已应用经你确认的 AI 参数建议。', '確認済みのAIパラメータ提案を適用しました。', 'The confirmed AI parameter guidance has been applied.')); };
  return <section className="phase-panel demo-automation-panel" hidden={!visible}>
    <div className="phase-heading"><div><p className="eyebrow">{bi('第十三阶段：多仓位 Demo 自动演练', '第13段階：複数ポジションDemo自動演習', 'Phase 13 · multi-position Demo automation')}</p><h3>{t('Demo 自主交易演练', 'Demo 自律取引演習', 'Autonomous Demo trading practice')} <span>{bi('自主多空 · 多仓位 · 主动退出 · 随时急停', '自律売買・複数ポジション・能動退出・緊急停止', 'long/short · scale-in · active exit · stop anytime')}</span></h3></div><span className={session.armed ? 'demo-auto-chip armed' : 'demo-auto-chip'}>{session.armed ? bi('自动演练已启用', '自動演習が有効', 'enabled') : bi('仅观察', '観察のみ', 'observe only')}</span></div>
    <div className="demo-execution-warning"><span>!</span><p><b>{t('仅限 Rakuten MT4 Demo：每根完成K线都会自主选择做多、做空、回撤加仓、主动平仓或观望。不是实盘路径，也不构成收益承诺。', 'Rakuten MT4 Demo限定：確定足ごとに買い・売り・押し目加算・能動決済・待機を自律選択します。実取引経路でも収益保証でもありません。', 'Rakuten MT4 Demo only: on each completed candle it autonomously picks long, short, drawdown add-on, proactive exit or standby. This is not a live path and promises no returns.')}</b><small>{t('止损和目标价仅是 MT4 Demo 的最后保护线；模型可先主动退出或反转。', 'SL/TPはMT4 Demoの最後の保護線です。モデルは先に能動決済・反転できます。', 'Stop loss and target are only the last line of protection on the MT4 Demo; the model may exit or reverse first.')}</small></p></div>
    <div className="demo-auto-status"><article><span>{bi('当前执行模型', '現在の実行モデル', 'active model')}</span><b>{modelName(activeModel, language)}</b><small>{activeModel.id} / v{activeModel.version}</small></article><article><span>{bi('本根规则信号', '現在足のルール信号', 'bar rule signal')}</span><b>{signal.direction === 'long' ? t('偏多：允许买入', '買い優勢：買い可', 'long bias: entry allowed') : signal.direction === 'short' ? t('偏空：允许卖出', '売り優勢：売り可', 'short bias: entry allowed') : t('观望：不建新仓', '待機：新規なし', 'wait: no new position')}</b><small>{t(`信号 ${signal.score}；${signal.trend === 'bullish' ? '趋势偏多' : signal.trend === 'bearish' ? '趋势偏空' : '趋势中性'}`, `シグナル ${signal.score}；${signal.trend === 'bullish' ? '上向き' : signal.trend === 'bearish' ? '下向き' : '中立'}`, `score ${signal.score}`)}</small></article><article><span>{bi('AI 市场判断', 'AI市場判断', 'AI market policy')}</span><b className={aiStatus.state === 'ready' ? 'positive' : aiStatus.state === 'invalid' ? 'negative' : ''}>{aiPolicy && aiStatus.state === 'ready' ? `${aiPolicy.model_id} · ${aiPolicy.action_bias}` : aiStatus.state === 'updating' ? bi('分析中', '分析中', 'analysing') : aiStatus.state === 'unavailable' ? bi('等待 AI 终端', 'AI端末待ち', 'waiting for terminal') : bi('尚无有效政策', '有効な方針なし', 'no valid policy')}</b><small>{aiPolicy && aiStatus.state === 'ready' ? `${language === 'ja' ? aiPolicy.rationale_ja : language === 'en' ? aiPolicy.rationale_en : aiPolicy.rationale_zh} · ${bi('置信度', '確信度', 'confidence')} ${aiPolicy.confidence}% · ${aiPolicy.news_context.length ? bi(`${aiPolicy.news_context.length} 条新闻/研究依据`, `${aiPolicy.news_context.length}件のニュース・研究根拠`, `${aiPolicy.news_context.length} news/research sources`) : bi('无新闻依据', 'ニュース根拠なし', 'no news context')}` : bi('M5/M15 收盘提交市场摘要；无有效政策时自动回退规则模型。', 'M5/M15確定足で市場要約を送信。有効な方針がない場合はルールモデルへ自動復帰します。', 'M5/M15 close submits a summary; no policy falls back to rules.')}</small></article><article><span>{bi('合成建议', '統合提案', 'composed decision')}</span><b className={composedDecision.authority === 'ai-and-rule' || composedDecision.authority === 'rule-fallback' ? 'positive' : composedDecision.authority === 'conflict-wait' ? 'negative' : ''}>{composedDecision.action === 'long' ? t('一致：偏多', '一致：買い', 'aligned: long') : composedDecision.action === 'short' ? t('一致：偏空', '一致：売り', 'aligned: short') : composedDecision.action === 'close' ? t('AI 建议退出', 'AIは退出を提案', 'AI suggests close') : t('观望', '待機', 'wait')}</b><small>{t('原因：', '根拠：', 'reason: ')}{decisionReason}</small></article><article><span>{bi('当前 Demo 仓位', '現在のDemoポジション', 'open positions')}</span><b>{positions.length}/{session.maxPositions}</b><small>{t('总手数', '合計ロット', 'total lots')} {lots.toFixed(2)} · {t('浮动盈亏', '含み損益', 'unrealized P/L')} {positions.reduce((a, x) => a + x.profit, 0).toFixed(2)}</small></article><article><span>{bi('本机执行连接', '端末内実行接続', 'execution link')}</span><b className={gateReady && paired ? 'positive' : gate?.killed ? 'negative' : ''}>{gateReady && paired ? bi('稳定就绪', '安定・準備完了', 'stable & ready') : connectionState === 'recovering' ? bi('自动恢复中', '自動復旧中', 'recovering') : connectionState === 'manual-stop' ? bi('人工急停中', '手動緊急停止中', 'manual stop') : connectionState === 'paused' ? bi('执行已暂停', '実行一時停止', 'execution paused') : bi('等待恢复', '復旧待ち', 'waiting')}</b><small>{gateReady && paired ? bi('每两秒健康检查', '2秒ごとのヘルス確認', '2-second health check') : gateReason}</small></article></div>
    <div className="demo-model-explanation"><b>{bi('自主选择与本根操作依据', '自律選択と現在足の根拠', 'selection & action rationale')}</b><span>{rationale}</span><small>{modelLogic(activeModel, language)} · {signal.direction === 'wait' ? t('当前未达到入场或反转条件，因此保持观望并继续监测。', '現在はエントリー・反転条件を満たさないため、待機して監視を継続します。', 'Entry or reversal conditions are not met; continue observing.') : t('下一步还会检查点差、仓位、回撤间距和 MT4 Demo 执行状态。', '次にスプレッド・保有数・加算間隔・MT4 Demo実行状態を確認します。', 'Next, the system checks spread, position limits, spacing and MT4 Demo status.')}</small></div>
    <div className={blocks.length ? 'demo-auto-preflight' : 'demo-auto-preflight ready'}><b>{blocks.length ? bi('本根 K 线暂不执行', 'この確定足は未実行', 'bar not eligible') : bi('本根 K 线可进入 Demo 最终确认', 'この確定足はDemo最終確認へ進めます', 'eligible')}</b><span>{blocks.length ? blocks.join('；') : bi('EA 将最终核验账户、点差、仓位上限与保护价。', 'EAが口座・スプレッド・ポジション上限・保護価格を最終確認します。', 'EA rechecks account, spread, caps, and protection prices.')} {timeframe !== 'M1' && (evaluationSync.pending ? `${bi(`评估回执等待同步：${evaluationSync.pending} 条`, `評価記録の同期待ち：${evaluationSync.pending}件`, `${evaluationSync.pending} evaluation events waiting to sync`)}${evaluationSync.detail ? ` · ${bi('最近错误', '最新エラー', 'latest error')}: ${evaluationSync.detail}` : ''}` : bi('评估回执已同步或等待终端首个 v2 结果。', '評価記録は同期済み、または端末の最初のv2結果待ちです。', 'Evaluation delivery is synced or awaiting the terminal’s first v2 result.'))}</span></div>
    <AiEvaluationLedger language={language} symbol={quote.symbol} timeframe={timeframe} displayTimeZone={displayTimeZone} />
    <details className="demo-auto-settings" open={!session.armed}><summary>{bi('自动演练设置与本机连接', '自動演習設定と端末接続', 'automation settings & local connection')}<small>{session.armed ? bi('当前已收起高级设置；停止后可修改', '現在は詳細設定を折りたたみ。停止後に変更可', 'advanced settings collapsed while active') : bi('AI 建议优先；仍可精细调整', 'AI提案を優先・微調整可能', 'AI guidance first; fine tuning remains available')}</small></summary><AiRiskAdvisor language={language} mode="demo" positionCeiling={session.maxPositions} policy={aiPolicy} regime={aiPolicy?.market_regime} confidence={aiPolicy?.confidence} currentSpread={quote.spreadPips} onRefresh={() => { if (timeframe === 'M1' || !completed) throw new Error('demo-history-unavailable'); lastAiAssessment.current = null; setPolicyRefreshNonce((value) => value + 1); setNotice(t('已提交 Demo AI 建议刷新，正在等待真实政策回传。', 'Demo AI提案の更新を送信し、実際の方針応答を待っています。', 'Demo AI guidance refresh submitted; waiting for the real policy response.')); }} onApplyDemo={applyAiRisk} /><div className="demo-auto-controls">
      <label>{bi('自主执行模型', '自律実行モデル', 'autonomous model')}<b>{modelName(activeModel, language)}</b><small>{t('其他页面的手动查看不会改动这里。', '他画面の手動閲覧はここを変更しません。', 'Manual viewing on other pages does not change this model.')}</small></label>
      <label>{bi('演练周期', '演習時間足', 'timeframe')}<select value={timeframe} disabled={session.armed || !restored} onChange={(e) => { lastCandle.current = null; setSession((s) => ({ ...s, executionTimeframe: e.target.value as ExecutionTimeframe, lastBarTime: null })); }}>{(['M1', 'M5', 'M15'] as ExecutionTimeframe[]).map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>{bi('演练货币对', '演習通貨ペア', 'pair')}<select value={session.executionSymbol} disabled={session.armed || !restored} onChange={(e) => { lastCandle.current = null; setSession((s) => ({ ...s, executionSymbol: e.target.value as PairSymbol, lastBarTime: null })); }}>{QUOTES.map((x) => <option key={x.symbol}>{x.symbol}</option>)}</select></label>
      <label><span><input type="checkbox" checked={session.useMinimumScore} onChange={(e) => setSession(s => ({...s, useMinimumScore:e.target.checked}))} /> {bi('启用信号阈值', 'シグナル閾値を使用', 'use score threshold')}</span><b>{session.minimumScore}</b><input type="number" step="1" disabled={!session.useMinimumScore} value={session.minimumScore} onChange={change('minimumScore')} /></label>
      <label><span><input type="checkbox" checked={session.useCooldown} onChange={(e) => setSession(s => ({...s, useCooldown:e.target.checked}))} /> {bi('启用冷却时间', 'クールダウンを使用', 'use cooldown')}</span><b>{session.cooldownMinutes}</b><input type="number" min="0" step="1" disabled={!session.useCooldown} value={session.cooldownMinutes} onChange={change('cooldownMinutes')} /></label>
      <label>{bi('用户最大并行仓位', 'ユーザー最大同時ポジション', 'user position ceiling')}<b>{session.maxPositions}</b><input type="number" min="1" max="10" step="1" disabled={session.armed || !restored} value={session.maxPositions} onChange={change('maxPositions')} /><small>{gate?.demo_account ? t(`MT4 已回传：净值 ${Number(gate.demo_account.equity).toFixed(2)}、可用保证金 ${Number(gate.demo_account.free_margin).toFixed(2)}；每次下单仍保留至少 20% 净值作为保证金缓冲。`, `MT4受信済み：有効証拠金 ${Number(gate.demo_account.equity).toFixed(2)}、余剰証拠金 ${Number(gate.demo_account.free_margin).toFixed(2)}。各注文で最低20%を余力として保持します。`, `MT4 reported equity ${Number(gate.demo_account.equity).toFixed(2)} and free margin ${Number(gate.demo_account.free_margin).toFixed(2)}; each order preserves at least a 20% equity margin reserve.`) : t('等待 MT4 账户资金回传；在此之前默认上限为 2，EA 仍会执行最终保证金检查。', 'MT4口座資金の受信待ち。受信前は既定上限2、EAが最終証拠金確認を行います。', 'Waiting for MT4 account capacity; until then the default is 2 and the EA performs the final margin check.')}</small></label>
      <label>{bi('每次手数', '1回ロット', 'entry lots')}<b>{session.entryLots.toFixed(2)}</b><input type="number" min="0.01" max="1.00" step="0.01" disabled={session.armed || !restored} value={session.entryLots} onChange={change('entryLots')} /><small>{t('总计不超过 1.00 lots', '合計1.00 lots以下', 'Never more than 1.00 lots in total')}</small></label>
      <label><span><input type="checkbox" checked={session.useScaleIn} onChange={(e) => setSession(s => ({...s, useScaleIn:e.target.checked}))} /> {bi('启用加仓间距', '加算間隔を使用', 'use scale-in spacing')}</span><b>{session.scaleInPips} pips</b><input type="number" min="0" step=".1" disabled={!session.useScaleIn} value={session.scaleInPips} onChange={change('scaleInPips')} /></label>
      <label><span><input type="checkbox" checked={session.useExitScore} onChange={(e) => setSession(s => ({...s, useExitScore:e.target.checked}))} /> {bi('启用弱信号退出', '弱シグナル退出を使用', 'use weak-signal exit')}</span><b>{session.exitScore}</b><input type="number" step="1" disabled={!session.useExitScore} value={session.exitScore} onChange={change('exitScore')} /></label>
      <label><span><input type="checkbox" checked={session.useSpreadCap} onChange={(e) => setSession(s => ({...s, useSpreadCap:e.target.checked}))} /> {bi('启用点差上限', 'スプレッド上限を使用', 'use spread cap')}</span><b>{session.maxSpreadPips.toFixed(1)} pips</b><input type="number" min="0.1" max="50" step=".1" disabled={!session.useSpreadCap} value={session.maxSpreadPips} onChange={change('maxSpreadPips')} /></label>
      <div><label><input type="checkbox" checked={session.demoOnly} disabled={session.armed || !restored} onChange={(e) => setSession((s) => ({ ...s, demoOnly: e.target.checked }))} />{bi('我确认仅限 Demo 账户', 'Demo口座のみを確認', 'Demo only')}</label><label><input type="checkbox" checked={session.acceptScope} disabled={session.armed || !restored} onChange={(e) => setSession((s) => ({ ...s, acceptScope: e.target.checked }))} />{bi('我接受多仓位、主动退出及总手数上限', '複数ポジション・能動退出・合計上限を了承', 'accept multi-position scope')}</label></div>
      <div><button disabled={!restored || session.armed} onClick={() => void service()}>{bi('启动 Demo 服务', 'Demoサービスを起動', 'start service')}</button><button disabled={!restored || paired || session.armed} onClick={() => void connect()}>{paired ? bi('已验证连接', '接続検証済み', 'verified') : bi('验证连接', '接続を検証', 'verify')}</button><button disabled={!paired || session.armed} onClick={() => void release()}>{bi('解除 Demo 急停', 'Demo緊急停止を解除', 'release stop')}</button><input value={phrase} disabled={session.armed || !restored} maxLength={16} onChange={(e) => setPhrase(language === 'en' ? e.target.value.toUpperCase() : e.target.value)} placeholder={language === 'zh' ? '确认自动演练' : language === 'ja' ? '自動演習を確認' : 'AUTO-DEMO'} />{session.armed ? <button className="stop" onClick={() => { setSession((s) => ({ ...s, armed: false })); setNotice(t('自动演练已停止；已存在的 Demo 仓位不会被这个按钮改变。', '自動演習を停止しました。既存Demoポジションはこのボタンで変更されません。', 'Automated practice has stopped; existing Demo positions are not changed by this button.')); }}>{bi('停止自动演练', '自動演習を停止', 'stop')}</button> : <button disabled={!restored} onClick={() => void enableAutomation()}>{bi('启用自主演练', '自律演習を有効化', 'enable')}</button>}</div>
    </div></details>
    {notice && <p className="demo-execution-notice">{notice}</p>}
    <details className="demo-auto-log" open><summary className="section-title"><b>{bi('自动演练审计记录', '自動演習監査記録', 'automation audit')}</b><span>{bi('默认显示最近 8 条 · 全部 100 条可展开', '既定は直近8件・全100件は展開可能', 'showing latest 8; expand for all 100')}</span></summary>{logs.slice(0, 8).map((x) => <article key={x.id}><time>{date(x.time)}</time><b className={x.kind}>{x.kind === 'ticket' ? bi('已创建指令', '指示を作成', 'entry') : x.kind === 'close' ? bi('已请求退出', '退出を要求', 'active exit') : x.kind === 'blocked' ? bi('暂不执行', '未実行', 'blocked') : bi('已观察', '観察済み', 'observed')}</b><span>{logDetail(x.detail)}</span></article>)}{logs.length > 8 && <details className="demo-audit-more"><summary>{bi(`查看其余 ${logs.length - 8} 条`, `残り ${logs.length - 8} 件を表示`, `show ${logs.length - 8} more`)}</summary>{logs.slice(8).map((x) => <article key={x.id}><time>{date(x.time)}</time><b className={x.kind}>{x.kind}</b><span>{logDetail(x.detail)}</span></article>)}</details>}{logs.length === 0 && <p className="empty-state">{bi('启用后会从下一根完整K线开始记录', '有効化後は次の確定足から記録します', 'records begin on next completed bar')}</p>}</details>
  </section>;
}
