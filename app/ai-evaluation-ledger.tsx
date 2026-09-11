'use client';

import { useEffect, useState } from 'react';
import { resolveAiTerminalUrl, toTerminalSymbol } from '../lib/ai-terminal';
import { pendingEvaluationEvents } from '../lib/ai-evaluation-outbox';

type Language = 'zh' | 'ja' | 'en';
type LedgerRow = {
  type?: 'decision' | 'outcome'; event_id?: string; policy_id?: string;
  decision_generated_at?: string; opened_at?: string; closed_at?: string;
  final_action?: string | null; direction?: string; adopted?: boolean;
};
type Summary = { total?: number; total_events?: number; decisions?: number; outcomes?: number; latest_at?: string; totals?: { decisions?: number; outcomes?: number } };

export default function AiEvaluationLedger({ language, symbol, timeframe, displayTimeZone = 'Asia/Tokyo' }: { language: Language; symbol: string; timeframe: 'M1' | 'M5' | 'M15'; displayTimeZone?: string }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'awaiting'>('loading');
  const text = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (timeframe === 'M1') { if (active) { setRows([]); setSummary(null); setState('awaiting'); } return; }
      const base = resolveAiTerminalUrl();
      try {
        const query = `symbol=${encodeURIComponent(toTerminalSymbol(symbol))}&timeframe=${timeframe}&limit=8`;
        const [ledgerResponse, summaryResponse] = await Promise.all([
          fetch(`${base}/v1/ledger?${query}`, { cache: 'no-store' }),
          fetch(`${base}/v1/ledger/summary?${query}`, { cache: 'no-store' }),
        ]);
        if (!ledgerResponse.ok || !summaryResponse.ok) throw new Error('terminal-v2-ledger-unavailable');
        const ledger = await ledgerResponse.json() as { items?: LedgerRow[]; events?: LedgerRow[] } | LedgerRow[];
        const nextSummary = await summaryResponse.json() as Summary;
        if (active) { setRows(Array.isArray(ledger) ? ledger : ledger.events ?? ledger.items ?? []); setSummary(nextSummary); setState('ready'); }
      } catch { if (active) setState('awaiting'); }
    };
    void refresh();
    const id = setInterval(() => void refresh(), 5_000);
    return () => { active = false; clearInterval(id); };
  }, [symbol, timeframe]);

  const localPending = pendingEvaluationEvents().filter((event) => event.symbol === toTerminalSymbol(symbol) && event.timeframe === timeframe).length;
  const formatTime = (value: string) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  return <details className="ai-evaluation-ledger">
    <summary>{text('AI 评估记录', 'AI評価記録', 'AI evaluation record')}<small>{state === 'ready' ? text('由 AI 终端统一保存', 'AI端末が一元保存', 'stored by the AI terminal') : text('等待 AI 终端 v2 评估接口', 'AI端末 v2 評価API待ち', 'awaiting AI terminal v2 evaluation API')}</small></summary>
    <div className="ai-evaluation-summary">
      <article><span>{text('周期', '時間足', 'timeframe')}</span><b>{timeframe}</b></article>
      <article><span>{text('终端回执', '端末受信', 'terminal receipts')}</span><b>{summary?.total_events ?? summary?.total ?? ((summary?.totals?.decisions ?? 0) + (summary?.totals?.outcomes ?? 0))}</b></article>
      <article><span>{text('待发送事件', '送信待ち', 'delivery queue')}</span><b>{localPending}</b></article>
    </div>
    {state === 'ready' && rows.length ? <div className="ai-evaluation-rows">{rows.map((row, index) => {
      const at = row.decision_generated_at ?? row.closed_at ?? row.opened_at;
      const label = row.type === 'outcome' ? text('结果回执', '結果受信', 'outcome') : text('决策回执', '判断受信', 'decision');
      const detail = row.type === 'outcome' ? (row.direction ?? '—') : (row.final_action ?? (row.adopted ? text('已采纳', '採用', 'adopted') : text('未采纳', '未採用', 'not adopted')));
      return <article key={row.event_id ?? `${at ?? 'event'}-${index}`}><time>{at ? formatTime(at) : '—'}</time><b>{label}</b><span>{String(detail)} · {row.policy_id ? row.policy_id.slice(0, 8) : '—'}</span></article>;
    })}</div> : <p className="empty-state">{timeframe === 'M1' ? text('M1 不进入 AI 评估链路；它只保留快速规则和本机报价。', 'M1はAI評価経路に入りません。高速ルールと端末レートのみを使用します。', 'M1 stays on local fast rules and does not enter the AI evaluation path.') : state === 'awaiting' ? text('主程序会保留待发送事件；AI 终端恢复后将自动补送，不会伪造评估结果。', '主プログラムは送信待ちイベントを保持します。AI端末の復旧後に自動送信され、評価結果は偽装しません。', 'The app retains delivery events and will replay them after the terminal is available; it never fabricates evaluations.') : text('尚无终端评估记录。', '端末評価記録はまだありません。', 'No terminal evaluation records yet.')}</p>}
  </details>;
}
