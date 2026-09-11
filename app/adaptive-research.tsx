'use client';

import { useEffect, useRef, useState } from 'react';
import { audit, evaluateAdaptiveModels, loadAdaptiveState, saveAdaptiveState, type AdaptiveObservation, type AdaptiveState, type AutonomousTimeframe } from '../lib/adaptive-research';
import { modelDefinition, modelName, modelShort, type ResearchModel } from '../lib/model-catalog';
import type { Mt4HistorySnapshot, Mt4SupervisorSnapshot } from '../lib/mt4-bridge';
import { QUOTES, type RiskConfig } from '../lib/market-data';

type Language = 'zh' | 'ja' | 'en';
interface QueueCandidate { model: ResearchModel; time: string; score: number; }
const AUTONOMOUS_TIMEFRAMES: AutonomousTimeframe[] = ['M1', 'M5', 'M15', 'H1'];
const RESEARCH_LIMIT: Record<AutonomousTimeframe, number> = { M1: 3000, M5: 5000, M15: 5000, H1: 8000 };
function isQualified(history: Mt4HistorySnapshot) { return history.bars.length >= 600 && (history.clock.status === 'aligned' || history.clock.status === 'offset-corrected'); }
function loadObservations() { if (typeof window === 'undefined') return [] as AdaptiveObservation[]; try { return JSON.parse(window.localStorage.getItem('enkei-forward-validation-observations') ?? '[]') as AdaptiveObservation[]; } catch { return []; } }
function loadQueue() { if (typeof window === 'undefined') return [] as QueueCandidate[]; try { return JSON.parse(window.localStorage.getItem('enkei-forward-paper-queue') ?? '[]') as QueueCandidate[]; } catch { return []; } }

// Autonomous research never reads the user's browsing model or page timeframe.
export function AdaptiveResearchEngine({ risk, onStateChange }: { risk: RiskConfig; onStateChange: (state: AdaptiveState) => void }) {
  const latest = useRef({ risk, onStateChange });
  const evaluating = useRef(false);
  useEffect(() => { latest.current = { risk, onStateChange }; }, [onStateChange, risk]);
  useEffect(() => {
    let alive = true;
    async function evaluate() {
      if (evaluating.current) return;
      evaluating.current = true;
      try {
        const { risk: currentRisk, onStateChange: publish } = latest.current;
        const saved = loadAdaptiveState();
        if (!saved.enabled) { if (alive) publish(saved); return; }
        const observations = loadObservations();
        let confirmedWeights: Partial<Record<ResearchModel, number>> = {};
        try {
          const response = await fetch('http://127.0.0.1:8710/v1/learning/control', { cache: 'no-store' });
          if (response.ok) {
            const control = await response.json() as { settings?: { mode?: string; paused?: boolean }; active?: { weights?: Partial<Record<ResearchModel, number>> } };
            if (control.settings?.mode === 'cautious' && !control.settings.paused) confirmedWeights = control.active?.weights ?? {};
          }
        } catch { /* Learning control is optional; base research remains available. */ }
        const dynamicSuspensions = (['trend-breakout', 'ema-cross', 'trend-pullback', 'range-reversion', 'momentum-pulse'] as ResearchModel[]).filter((model) => {
          const reviewed = observations.filter((item) => item.model === model && (item.outcome === 'consistent' || item.outcome === 'inconsistent'));
          return reviewed.length >= 20 && reviewed.filter((item) => item.outcome === 'inconsistent').length / reviewed.length > .35;
        });
        const suspendedModels = Array.from(new Set([...saved.suspendedModels, ...dynamicSuspensions]));
        const audits = [...saved.audits];
        dynamicSuspensions.filter((model) => !saved.suspendedModels.includes(model)).forEach((model) => audits.unshift(audit('suspended', `模型暂停：${model} 前向复核不一致率超过 35%。`)));
        const decisions = { ...saved.timeframeDecisions };
        for (const timeframe of AUTONOMOUS_TIMEFRAMES) {
          const responses = await Promise.all(QUOTES.map(async (quote) => {
            try {
              const response = await fetch(`http://127.0.0.1:8788/api/history?symbol=${encodeURIComponent(quote.symbol.replace('/', ''))}&timeframe=${timeframe}&limit=${RESEARCH_LIMIT[timeframe]}`);
              if (!response.ok) return null;
              const history = await response.json() as Mt4HistorySnapshot;
              return isQualified(history) ? { symbol: quote.symbol, bars: history.bars } : null;
            } catch { return null; }
          }));
          const histories = responses.filter((item): item is NonNullable<typeof item> => item !== null);
          const previous = decisions[timeframe];
          const selectedBefore = previous?.selectedModel ?? 'trend-breakout';
          const scores = evaluateAdaptiveModels(histories, timeframe, currentRisk, observations, suspendedModels, confirmedWeights);
          const top = scores.find((item) => item.eligible) ?? null;
          const currentScore = scores.find((item) => item.model === selectedBefore);
          const leaderStreak = top ? previous?.leaderModel === top.model ? previous.leaderStreak + 1 : 1 : 0;
          let selectedModel = selectedBefore;
          if (!previous && top) { selectedModel = top.model; audits.unshift(audit('switch', `自主选择：${timeframe} 首次采用 ${top.model}（${histories.length}/6 个合格市场）。`)); }
          else if (top && top.model !== selectedBefore && leaderStreak >= 3 && top.score >= (currentScore?.score ?? Number.NEGATIVE_INFINITY) + 12) { selectedModel = top.model; audits.unshift(audit('switch', `自主切换：${timeframe} ${selectedBefore} → ${top.model}（连续 ${leaderStreak} 次领先且分差达标）。`)); }
          decisions[timeframe] = { timeframe, selectedModel, leaderModel: top?.model ?? null, leaderStreak, lastEvaluationAt: new Date().toISOString(), dataMarkets: histories.length, scores };
          audits.unshift(audit(histories.length >= 2 ? 'evaluation' : 'waiting', histories.length >= 2 ? `${timeframe} 已评估 ${histories.length}/6 个合格市场；当前领先：${top?.model ?? '无'}。` : `${timeframe} 等待数据：仅 ${histories.length}/6 个市场可用。`));
        }
        const compatibility = decisions.M15;
        const additions = (compatibility?.scores ?? []).filter((item) => item.eligible).map((item) => ({ model: item.model, score: item.score, time: new Date().toISOString() }));
        if (additions.length) { const existing = loadQueue(); window.localStorage.setItem('enkei-forward-paper-queue', JSON.stringify([...additions.filter((item) => !existing.some((old) => old.model === item.model)), ...existing].slice(0, 5))); }
        const next: AdaptiveState = { ...saved, selectedModel: compatibility?.selectedModel ?? saved.selectedModel, leaderModel: compatibility?.leaderModel ?? null, leaderStreak: compatibility?.leaderStreak ?? 0, lastEvaluationAt: new Date().toISOString(), dataMarkets: compatibility?.dataMarkets ?? 0, scores: compatibility?.scores ?? [], suspendedModels, timeframeDecisions: decisions, audits: audits.slice(0, 100) };
        saveAdaptiveState(next);
        if (alive) publish(next);
      } finally { evaluating.current = false; }
    }
    void evaluate();
    const timer = window.setInterval(() => void evaluate(), 300_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return null;
}

export default function AdaptiveResearchPanel({ language, state, onStateChange, activeModel, displayTimeZone = 'Asia/Tokyo' }: { language: Language; state: AdaptiveState; onStateChange: (state: AdaptiveState) => void; activeModel: ResearchModel; displayTimeZone?: string }) {
  const [notice, setNotice] = useState('');
  const [supervisor, setSupervisor] = useState<Mt4SupervisorSnapshot | null>(null);
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const auditText = (text: string) => {
    let match = /^(M1|M5|M15|H1) 已评估 (\d+)\/6 个合格市场；当前领先：(.+)。$/.exec(text);
    if (match) return t(`${match[1]} 已评估 ${match[2]}/6 个合格市场；当前领先：${match[3]}。`, `${match[1]} は適格市場 ${match[2]}/6 件を評価済み。現在の先頭：${match[3]}。`, `${match[1]} evaluated ${match[2]}/6 qualified markets; current leader: ${match[3]}.`);
    match = /^(M1|M5|M15|H1) 等待数据：仅 (\d+)\/6 个市场可用。$/.exec(text);
    if (match) return t(text, `${match[1]} はデータ待機中：利用可能な市場は ${match[2]}/6 件です。`, `${match[1]} is waiting for data; only ${match[2]}/6 markets are available.`);
    match = /^自主切换：(M1|M5|M15|H1) (.+) → (.+)（连续 (\d+) 次领先且分差达标）。$/.exec(text);
    if (match) return t(text, `自動切替：${match[1]} ${match[2]} → ${match[3]}（${match[4]} 回連続で先頭、スコア差条件を達成）。`, `Autonomous switch: ${match[1]} ${match[2]} → ${match[3]} (${match[4]} consecutive leads and score-gap requirement met).`);
    match = /^自主选择：(M1|M5|M15|H1) 首次采用 (.+)（(\d+)\/6 个合格市场）。$/.exec(text);
    if (match) return t(text, `自動選択：${match[1]} は初回モデルとして ${match[2]} を採用（適格市場 ${match[3]}/6 件）。`, `Autonomous selection: ${match[1]} first adopted ${match[2]} (${match[3]}/6 qualified markets).`);
    return text === '自主研究已由用户暂停。' ? t(text, '自律リサーチはユーザーにより一時停止されました。', 'Autonomous research was paused by the user.') : text === '自主研究已由用户恢复。' ? t(text, '自律リサーチはユーザーにより再開されました。', 'Autonomous research was resumed by the user.') : text;
  };
  const update = (next: AdaptiveState) => { saveAdaptiveState(next); onStateChange(next); };
  const toggle = () => { const next = { ...state, enabled: !state.enabled, audits: [audit(state.enabled ? 'waiting' : 'evaluation', state.enabled ? '自主研究已由用户暂停。' : '自主研究已由用户恢复。'), ...state.audits].slice(0, 100) }; update(next); setNotice(next.enabled ? t('自主研究已恢复', '自動研究を再開しました', 'Autonomous research resumed') : t('自主研究已暂停', '自動研究を一時停止しました', 'Autonomous research paused')); };
  const date = (value: string | null) => value ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : '—';
  useEffect(() => { let alive = true; const refresh = async () => { try { const r = await fetch('http://127.0.0.1:8788/api/supervisor'); if (alive) setSupervisor(await r.json() as Mt4SupervisorSnapshot); } catch { if (alive) setSupervisor({ status: 'waiting' }); } }; void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => { alive = false; window.clearInterval(timer); }; }, []);
  const decisionRows = AUTONOMOUS_TIMEFRAMES.map((timeframe) => state.timeframeDecisions[timeframe]).filter(Boolean);
  return <section className="phase-panel adaptive-panel">
    <div className="phase-heading"><div><p className="eyebrow">第七阶段 · 自主研究控制器 · Adaptive research</p><h3>{t('自主研究控制器', '自律リサーチ・コントローラー', 'Autonomous research controller')} <span>{t('按周期独立评估 · 不受浏览页面影响', '時間足ごとに独立評価・閲覧画面の影響なし', 'Independent evaluation per timeframe · unaffected by page browsing')}</span></h3></div><button className={`adaptive-toggle ${state.enabled ? 'on' : ''}`} onClick={toggle}>{state.enabled ? t('自主研究：开启', '自動研究：オン', 'Autonomous research: on') : t('自主研究：暂停', '自動研究：停止', 'Autonomous research: paused')}</button></div>
    <div className="adaptive-safety"><span>◈</span><p><b>{t('系统只在固定的可解释模型间自主选择；研究查看、回测与模型窗口的手动选择不会影响 Demo 演练。', 'システムは固定の説明可能モデル間でのみ自律選択します。閲覧・検証・モデル画面の手動選択はDemo演習に影響しません。', 'The system only chooses among fixed, explainable models; manual selection in research views, backtests and the model window never affects the Demo exercise.')}</b><small>{t('每五分钟分别评估 M1、M5、M15、H1；切换需要多次确认，不能承诺未来收益。', '5分ごとにM1・M5・M15・H1を別々に評価します。切替は複数回の確認を要し、将来利益は保証しません。', 'M1, M5, M15 and H1 are evaluated separately every five minutes; switching requires multiple confirmations and no future profit is promised.')}</small></p></div>
    <div className="adaptive-status"><article><span>{t('后台研究服务', 'バックグラウンド研究', 'Background research service')}</span><b className={supervisor?.status === 'research-watch-ready' ? 'positive' : ''}>{supervisor?.status === 'research-watch-ready' ? t('就绪', '準備完了', 'ready') : t('等待中', '待機中', 'waiting')}</b><small>{notice || t('只读取本机 MT4 历史数据。', '端末内MT4履歴を読取専用で使用します。', 'reads local MT4 history only.')}</small></article><article><span>{t('浏览模型', '閲覧モデル', 'view model')}</span><b>{modelName(modelDefinition(activeModel), language)}</b><small>{t('仅供查看，不会改变自主执行选择。', '閲覧専用で、自律実行の選択を変更しません。', 'view only; does not change autonomous selection.')}</small></article><article><span>{t('最近自主评估', '最終自律評価', 'last autonomous evaluation')}</span><b>{date(state.lastEvaluationAt)}</b><small>{t('M15 兼容摘要', 'M15互換サマリー', 'M15 compatibility summary')}</small></article></div>
    <div className="adaptive-models"><div className="section-title"><b>{t('各周期当前自主选择', '各時間足の現在の自律選択', 'current autonomous model by timeframe')}</b><span>{t('不同周期可选择不同模型；页面操作不会改写这里。', '時間足ごとに異なるモデルを選択可能。画面操作では変更されません。', 'Each timeframe can use a different model; viewing does not change execution.')}</span></div>{decisionRows.map((decision) => { const selected = modelDefinition(decision!.selectedModel); const leader = decision!.leaderModel ? modelDefinition(decision!.leaderModel) : null; return <article key={decision!.timeframe}><div><span>{decision!.timeframe}</span><b>{modelName(selected, language)}</b><small>{t('自主执行模型', '自律実行モデル', 'autonomous model')}</small></div><div><span>{t('合格市场', '適格市場', 'qualified markets')}</span><b>{decision!.dataMarkets}/6</b></div><div><span>{t('当前领先', '現在の先頭', 'current leader')}</span><b>{leader ? modelShort(leader, language) : '—'}</b></div><div><span>{t('领先确认', '先頭確認', 'leader streak')}</span><b>{decision!.leaderStreak}/3</b></div></article>; })}{decisionRows.length === 0 && <p className="empty-state">{t('正在等待本机 MT4 历史完成首次自主评估。', '端末内MT4履歴による初回の自律評価を待機中です。', 'Waiting for the first autonomous evaluation from local MT4 history.')}</p>}</div>
    <div className="adaptive-audit"><div className="section-title"><b>{t('自主决策审计', '自律判断の監査', 'Autonomous decision audit')}</b><span>{t('本机记录', '端末内記録', 'Local records')}</span></div>{state.audits.slice(0, 12).map((item) => <article key={item.id}><time>{date(item.time)}</time><b>{item.type === 'switch' ? t('自主切换', '自動切替', 'Autonomous switch') : item.type === 'waiting' ? t('等待数据', 'データ待機', 'Waiting for data') : t('已评估', '評価済み', 'Evaluated')}</b><span>{auditText(item.text)}</span></article>)}</div>
  </section>;
}
