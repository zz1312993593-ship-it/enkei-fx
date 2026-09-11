'use client';

import { useEffect, useMemo, useState } from 'react';
import { resolveAiTerminalUrl } from '../lib/ai-terminal';

type Language = 'zh' | 'ja' | 'en';
type Counts = { calls?: number; input_tokens?: number; output_tokens?: number; total_tokens?: number };
type Usage = {
  source?: string; generated_at?: string; reported_calls?: number; unreported_calls?: number;
  totals?: Counts; today?: { date?: string; reported_calls?: number; totals?: Counts };
  latest?: Counts & { request_id?: string; provider?: string; model_id?: string; updated_at?: string } | null;
  by_route?: Record<string, Counts & { provider?: string; model_id?: string }>;
  by_transport?: Record<string, Counts>;
  activity?: { daily?: Record<string, Counts>; peak_request?: { total_tokens?: number } | null; longest_request_ms?: number; current_streak_days?: number; longest_streak_days?: number };
};

const number = (value: number | undefined) => typeof value === 'number' ? value.toLocaleString() : '—';

export default function TokenUsagePanel({ language, compact = false }: { language: Language; compact?: boolean }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [online, setOnline] = useState(false);
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`${resolveAiTerminalUrl()}/v1/usage`, { cache: 'no-store' });
        if (!response.ok) throw new Error('usage unavailable');
        const next = await response.json() as Usage;
        if (active) { setUsage(next); setOnline(true); }
      } catch { if (active) setOnline(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    const resume = () => void load();
    window.addEventListener('focus', resume);
    window.addEventListener('enkei-ai-terminal-url-changed', resume);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('enkei-ai-terminal-url-changed', resume); };
  }, []);
  const routes = useMemo(() => Object.entries(usage?.by_route ?? {}).sort((a, b) => (b[1].total_tokens ?? 0) - (a[1].total_tokens ?? 0)), [usage]);
  const weekTotal = useMemo(() => Object.entries(usage?.activity?.daily ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(-7).reduce((sum, [, value]) => sum + (value.total_tokens ?? 0), 0), [usage]);
  const transportName = (key: string) => key === 'direct' ? t('供应商直连', 'プロバイダー直接', 'Direct') : key === 'librechat_agents_api' ? 'LibreChat' : key === 'local_ollama' ? t('本地 Ollama', 'ローカル Ollama', 'Local Ollama') : key;
  return <section className={`token-usage-panel${compact ? ' compact' : ''}`}>
    <header><div><b>{t('实时 Token 用量', 'リアルタイム Token 使用量', 'Live Token usage')}</b><small>{t('仅统计供应商实际返回值，不估算', 'プロバイダー実測値のみ・推定なし', 'Provider-reported values only; no estimates')}</small></div><span className={online ? 'online' : 'offline'}>{online ? t('每 5 秒刷新', '5秒ごとに更新', 'refreshes every 5s') : t('等待 AI 终端', 'AI端末待ち', 'waiting for terminal')}</span></header>
    <div className="token-usage-metrics">
      <article><span>{t('本次输入', '今回の入力', 'Latest input')}</span><b>{number(usage?.latest?.input_tokens)}</b></article>
      <article><span>{t('本次输出', '今回の出力', 'Latest output')}</span><b>{number(usage?.latest?.output_tokens)}</b></article>
      <article><span>{t('本次总计', '今回の合計', 'Latest total')}</span><b>{number(usage?.latest?.total_tokens)}</b></article>
      <article><span>{t('今日累计', '本日の累計', 'Today')}</span><b>{number(usage?.today?.totals?.total_tokens)}</b><small>{number(usage?.today?.reported_calls)} {t('次已报告', '件報告済み', 'reported calls')}</small></article>
      <article><span>{t('未报告次数', '未報告回数', 'Unreported')}</span><b>{number(usage?.unreported_calls)}</b></article>
      <article><span>{t('最近更新时间', '最終更新', 'Last update')}</span><b>{usage?.latest?.updated_at ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(usage.latest.updated_at)) : '—'}</b></article>
    </div>
    {!compact && <div className="token-period-summary">
      <article><span>{t('今日使用', '本日の使用量', 'Today')}</span><b>{number(usage?.today?.totals?.total_tokens)}</b><small>Token</small></article>
      <article><span>{t('本周使用', '今週の使用量', 'This week')}</span><b>{number(weekTotal)}</b><small>Token</small></article>
      <article><span>{t('累计使用', '累計使用量', 'Lifetime')}</span><b>{number(usage?.totals?.total_tokens)}</b><small>Token</small></article>
    </div>}
    {!compact && <div className="token-usage-details">
      <div><b>{t('按供应商与模型', 'プロバイダー・モデル別', 'By provider and model')}</b>{routes.length ? routes.map(([key, value]) => <span key={key}><strong>{value.provider ?? key} / {value.model_id ?? '—'}</strong><em>{number(value.total_tokens)} Token · {number(value.calls)} {t('次', '回', 'calls')}</em></span>) : <small>{t('尚无供应商报告数据', '報告データなし', 'No reported usage yet')}</small>}</div>
      <div><b>{t('按路由方式', 'ルート別', 'By route')}</b>{Object.entries(usage?.by_transport ?? {}).map(([key, value]) => <span key={key}><strong>{transportName(key)}</strong><em>{number(value.total_tokens)} Token · {number(value.calls)} {t('次', '回', 'calls')}</em></span>)}</div>
    </div>}
  </section>;
}
