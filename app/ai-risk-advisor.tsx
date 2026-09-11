'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RiskConfig } from '../lib/market-data';
import type { AiPolicy } from '../lib/ai-terminal';

type Language = 'zh' | 'ja' | 'en';
export type DemoRiskSuggestion = { minimumScore: number; cooldownMinutes: number; maxPositions: number; entryLots: number; scaleInPips: number; exitScore: number; maxSpreadPips: number };

function mix(low: number, high: number, level: number, digits = 2) {
  return Number((low + (high - low) * level).toFixed(digits));
}

export default function AiRiskAdvisor({ language, mode, policy, regime, confidence, currentSpread, positionCeiling = 2, onApplyDemo, onApplyLive, onRefresh }: {
  language: Language; mode: 'demo' | 'live'; policy?: AiPolicy | null; regime?: string | null; confidence?: number | null; currentSpread: number; positionCeiling?: number;
  onApplyDemo?: (value: DemoRiskSuggestion) => void; onApplyLive?: (value: RiskConfig) => void;
  onRefresh?: () => void | Promise<void>;
}) {
  const [intensity, setIntensity] = useState(50);
  const [autoApply, setAutoApply] = useState(false);
  const [refreshState, setRefreshState] = useState<'idle' | 'requested' | 'updated' | 'failed'>('idle');
  const appliedPolicy = useRef('');
  const refreshFromPolicy = useRef('');
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const highRiskRegime = /high|news|breakout|volatile|异常|新闻|高ボラ|ニュース|異常/i.test(regime ?? '');
  const confidenceFactor = Math.max(.65, Math.min(1, Number(confidence ?? 55) / 75));
  const level = intensity / 100;
  const recommendation = useMemo(() => {
    const safety = highRiskRegime ? .7 : 1;
    const live: RiskConfig = {
      riskPerTradePct: Math.max(.05, mix(.10, .55, level) * safety * confidenceFactor),
      dailyLossLimitPct: mix(.5, 2.5, level) * safety,
      maxOpenPositions: Math.min(positionCeiling, Math.max(1, Math.round(mix(1, highRiskRegime ? 3 : 6, level, 0)))),
      maxSpreadPips: Math.max(.5, Math.min(5, mix(Math.max(.8, currentSpread + .2), Math.max(1.5, currentSpread + 1), level, 1))),
      eventPauseMinutes: Math.round(mix(60, 15, level, 0) / 5) * 5,
      requireStopLoss: true,
    };
    const demo: DemoRiskSuggestion = {
      minimumScore: Math.round(mix(72, 48, level, 0) + (confidenceFactor < .8 ? 4 : 0)),
      cooldownMinutes: Math.round(mix(20, 0, level, 0)),
      maxPositions: Math.min(positionCeiling, Math.max(1, Math.round(mix(1, highRiskRegime ? 3 : 6, level, 0)))),
      entryLots: mix(.01, highRiskRegime ? .02 : .03, level),
      scaleInPips: Math.round(mix(14, 5, level, 0)),
      exitScore: Math.round(mix(48, 28, level, 0)),
      maxSpreadPips: live.maxSpreadPips,
    };
    return { live, demo };
  }, [confidenceFactor, currentSpread, highRiskRegime, level, positionCeiling]);
  const apply = useCallback(() => mode === 'demo' ? onApplyDemo?.(recommendation.demo) : onApplyLive?.(recommendation.live), [mode, onApplyDemo, onApplyLive, recommendation.demo, recommendation.live]);
  const refreshPolicy = async () => {
    if (!onRefresh || refreshState === 'requested') return;
    refreshFromPolicy.current = policy?.policy_id ?? '';
    setRefreshState('requested');
    try { await onRefresh(); } catch { setRefreshState('failed'); }
  };
  useEffect(() => { if (policy?.policy_id && refreshState === 'requested' && policy.policy_id !== refreshFromPolicy.current) setRefreshState('updated'); }, [policy?.policy_id, refreshState]);
  useEffect(() => { if (!autoApply || !policy?.policy_id || appliedPolicy.current === policy.policy_id) return; appliedPolicy.current = policy.policy_id; apply(); }, [apply, autoApply, policy?.policy_id]);
  const levelName = intensity < 34 ? t('保守', '保守', 'Conservative') : intensity > 66 ? t('积极', '積極', 'Aggressive') : t('均衡', '均衡', 'Balanced');
  return <section className="ai-risk-advisor">
    <div className="ai-risk-advisor-head"><div><b>{t('AI 动态参数建议', 'AI動的パラメータ提案', 'AI dynamic parameter guidance')}</b><small>{t('依据真实 AI 政策、市场状态、置信度和点差生成；每个新政策均可自动重算。', '実際のAI方針・市場状態・確信度・スプレッドから生成し、新方針ごとに再計算します。', 'Derived from the actual AI policy, regime, confidence and spread; recalculated on every new policy.')}</small></div><strong>{levelName} · {intensity}</strong></div>
    <div className="ai-risk-profile-buttons"><button disabled={!onRefresh || refreshState === 'requested'} onClick={() => void refreshPolicy()}>{refreshState === 'requested' ? t('正在请求真实 AI 判断…', 'AI判断を要求中…', 'Requesting AI decision…') : t('立即刷新建议', '提案を更新', 'Refresh guidance')}</button><label><input type="checkbox" checked={autoApply} onChange={(event) => setAutoApply(event.target.checked)} /> {t('新 AI 判断后自动应用', '新しいAI判断後に自動適用', 'Auto-apply after each new AI decision')}</label></div>
    {refreshState !== 'idle' && <small className={`ai-risk-refresh-state ${refreshState}`}>{refreshState === 'requested' ? t('请求已提交，正在等待带时间和原因的新政策。', '要求を送信しました。時刻と理由を含む新方針を待っています。', 'Request submitted; waiting for a new policy with time and rationale.') : refreshState === 'updated' ? t('已收到新的 AI 建议，下方时间与原因已同步。', '新しいAI提案を受信し、時刻と理由を同期しました。', 'New AI guidance received; time and rationale are synchronized below.') : t('刷新失败，请检查 AI 终端连接。', '更新に失敗しました。AI端末接続を確認してください。', 'Refresh failed; check the AI terminal connection.')}</small>}
    <div className="ai-risk-profile-buttons"><button onClick={() => setIntensity(15)}>{t('保守', '保守', 'Conservative')}</button><button onClick={() => setIntensity(50)}>{t('均衡', '均衡', 'Balanced')}</button><button onClick={() => setIntensity(85)}>{t('积极', '積極', 'Aggressive')}</button></div>
    <input aria-label={t('风险偏好', 'リスク選好', 'Risk preference')} type="range" min="0" max="100" step="1" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} />
    <p>{t('建议时间', '提案時刻', 'Guidance time')}：{policy?.generated_at ? new Date(policy.generated_at).toLocaleString() : '—'} · {t('依据', '根拠', 'basis')}：{regime || t('市场状态待补充', '市場状態待ち', 'regime pending')} · {t('置信度', '確信度', 'confidence')} {confidence ?? '—'}% · {t('点差', 'スプレッド', 'spread')} {currentSpread.toFixed(1)} pips</p>
    <p>{t('选择原因', '選択理由', 'Why')}：{policy ? (language === 'ja' ? policy.rationale_ja : language === 'en' ? policy.rationale_en : policy.rationale_zh) || policy.rationale_zh : t('等待真实 AI 判断，不以占位数据冒充建议。', '実際のAI判断待ち。仮データは提案として表示しません。', 'Waiting for a real AI decision; placeholders are not presented as guidance.')}{policy?.request_id ? ` · request ${policy.request_id}` : ''}</p>
    {mode === 'demo' ? <div className="ai-risk-values"><span>{t('信号门槛', 'シグナル閾値', 'Score')} {recommendation.demo.minimumScore}</span><span>{t('冷却', '待機', 'Cooldown')} {recommendation.demo.cooldownMinutes}m</span><span>{t('仓位数', '保有数', 'Positions')} {recommendation.demo.maxPositions}</span><span>{t('每次手数', 'ロット', 'Lots')} {recommendation.demo.entryLots.toFixed(2)}</span><span>{t('加仓间距', '追加間隔', 'Scale-in')} {recommendation.demo.scaleInPips}p</span><span>{t('弱信号退出', '弱信号退出', 'Exit score')} {recommendation.demo.exitScore}</span></div>
      : <div className="ai-risk-values"><span>{t('单笔风险', '1取引リスク', 'Risk/trade')} {recommendation.live.riskPerTradePct.toFixed(2)}%</span><span>{t('日亏上限', '日次損失上限', 'Daily cap')} {recommendation.live.dailyLossLimitPct.toFixed(2)}%</span><span>{t('最大持仓', '最大保有', 'Positions')} {recommendation.live.maxOpenPositions}</span><span>{t('点差上限', '最大スプレッド', 'Spread cap')} {recommendation.live.maxSpreadPips.toFixed(1)}p</span><span>{t('事件暂停', 'イベント停止', 'Event pause')} {recommendation.live.eventPauseMinutes}m</span></div>}
    <button className="ai-risk-apply" disabled={!policy} onClick={apply}>{t('确认并应用本组参数', '確認して適用', 'Confirm and apply')}</button>
    <small>{highRiskRegime ? t('高波动／新闻环境已自动压低风险上限。', '高ボラ・ニュース環境のため上限を自動抑制。', 'Caps are reduced for a high-volatility/news regime.') : t('建议不会自动改动交易设置，可随时恢复原值。', '提案は自動変更せず、元の値へ戻せます。', 'Guidance never changes settings automatically and can be reverted.')}</small>
  </section>;
}
