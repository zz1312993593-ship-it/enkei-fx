'use client';

import { useEffect, useState } from 'react';
import type { PairSymbol, SignalDirection, Timeframe } from '../lib/market-data';

type JournalDecision = 'observe' | 'long' | 'short' | 'no-trade';
type JournalReview = 'pending' | 'validated' | 'rejected';

interface JournalEntry {
  id: string;
  createdAt: string;
  symbol: PairSymbol;
  timeframe: Timeframe;
  signal: SignalDirection;
  decision: JournalDecision;
  note: string;
  review: JournalReview;
}

let journalSequence = 0;

function createEntry(input: Omit<JournalEntry, 'id' | 'createdAt' | 'review'>): JournalEntry {
  journalSequence += 1;
  return { ...input, id: `journal-${Date.now()}-${journalSequence}`, createdAt: new Date().toISOString(), review: 'pending' };
}

function loadJournal() {
  if (typeof window === 'undefined') return [] as JournalEntry[];
  try {
    const saved = window.localStorage.getItem('enkei-research-journal');
    return saved ? JSON.parse(saved) as JournalEntry[] : [];
  } catch {
    window.localStorage.removeItem('enkei-research-journal');
    return [] as JournalEntry[];
  }
}

export default function JournalPanel({ language, symbol, timeframe, signal, displayTimeZone = 'Asia/Tokyo' }: { language: 'zh' | 'ja' | 'en'; symbol: PairSymbol; timeframe: Timeframe; signal: SignalDirection; displayTimeZone?: string }) {
  const [entries, setEntries] = useState<JournalEntry[]>(loadJournal);
  const [decision, setDecision] = useState<JournalDecision>('observe');
  const [note, setNote] = useState('');
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const date = (value: string) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone, hourCycle: 'h23' }).format(new Date(value));

  useEffect(() => { window.localStorage.setItem('enkei-research-journal', JSON.stringify(entries)); }, [entries]);

  const addEntry = () => {
    setEntries((current) => [createEntry({ symbol, timeframe, signal, decision, note: note.trim() }), ...current].slice(0, 80));
    setNote('');
    setDecision('observe');
  };
  const setReview = (id: string, review: JournalReview) => setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, review } : entry));
  const pending = entries.filter((entry) => entry.review === 'pending').length;
  const validated = entries.filter((entry) => entry.review === 'validated').length;
  const labelDecision = (value: JournalDecision) => value === 'long' ? t('偏多研究', '買い研究', 'Long-leaning research') : value === 'short' ? t('偏空研究', '売り研究', 'Short-leaning research') : value === 'no-trade' ? t('不交易', '取引しない', 'No trade') : t('观察', '観察', 'Observe');
  const labelSignal = (value: SignalDirection) => value === 'long' ? t('偏多', '買い優勢', 'Long-leaning') : value === 'short' ? t('偏空', '売り優勢', 'Short-leaning') : t('观望', '待機', 'Standby');

  return (
    <section className="phase-panel journal-panel">
      <div className="phase-heading"><div><p className="eyebrow">RESEARCH JOURNAL · LOCAL ONLY</p><h3>{t('信号与回溯', 'シグナルと振り返り', 'Signals & review')} <span>{t('本机记录', '端末内記録', 'Local records')}</span></h3></div></div>
      <div className="journal-safety"><span>✓</span><p><b>{t('不生成订单', '注文は生成しません', 'Creates no orders')}</b><small>{t('这是一份研究日志，只保存你的判断与后续复盘。', '研究ログとして、判断と後日の振り返りだけを保存します。', 'This is a research journal that stores only your judgements and later reviews.')}</small></p></div>
      <div className="journal-summary"><article><span>{t('总记录', '総記録', 'Total records')}</span><strong>{entries.length}</strong></article><article><span>{t('待复盘', '振り返り待ち', 'Awaiting review')}</span><strong>{pending}</strong></article><article><span>{t('已验证成立', '検証成立', 'Verified')}</span><strong>{validated}</strong></article></div>
      <div className="journal-form">
        <div><p className="eyebrow">CURRENT CONTEXT</p><b>{symbol} · {timeframe} · {labelSignal(signal)}</b><span>{t('记录策略信号出现时你的判断，不要把它当作下单建议。', 'シグナル発生時の判断を記録します。注文助言ではありません。', 'Records your judgement when a strategy signal appears; it is not an order suggestion.')}</span></div>
        <label><span>{t('你的决定', 'あなたの判断', 'Your decision')}</span><select value={decision} onChange={(event) => setDecision(event.target.value as JournalDecision)}><option value="observe">{t('观察', '観察', 'Observe')}</option><option value="long">{t('偏多研究', '買い研究', 'Long-leaning research')}</option><option value="short">{t('偏空研究', '売り研究', 'Short-leaning research')}</option><option value="no-trade">{t('不交易', '取引しない', 'No trade')}</option></select></label>
        <label className="journal-note"><span>{t('理由（可选）', '理由（任意）', 'Reason (optional)')}</span><input value={note} maxLength={120} onChange={(event) => setNote(event.target.value)} placeholder={t('例如：等待美国数据公布后再判断', '例：米国指標発表後に再判断', 'e.g. wait for US data before deciding')} /></label>
        <button onClick={addEntry}>{t('保存研究记录', '研究記録を保存', 'Save research record')}</button>
      </div>
      <div className="journal-list"><div className="section-title"><b>{t('最近记录', '最近の記録', 'Recent records')}</b><button onClick={() => setEntries([])}>{t('清空本机记录', '端末内記録を消去', 'Clear local records')}</button></div>
        {entries.map((entry) => <div className="journal-row" key={entry.id}><time>{date(entry.createdAt)}</time><div><b>{entry.symbol} · {entry.timeframe} · {labelDecision(entry.decision)}</b><small>{t('信号', 'シグナル', 'Signal')}: {labelSignal(entry.signal)}{entry.note ? ` · ${entry.note}` : ''}</small></div><div className="review-actions"><button className={entry.review === 'validated' ? 'active positive' : ''} onClick={() => setReview(entry.id, 'validated')}>{t('成立', '成立', 'Held')}</button><button className={entry.review === 'rejected' ? 'active negative' : ''} onClick={() => setReview(entry.id, 'rejected')}>{t('不成立', '不成立', 'Failed')}</button><button className={entry.review === 'pending' ? 'active' : ''} onClick={() => setReview(entry.id, 'pending')}>{t('待定', '保留', 'Pending')}</button></div></div>)}
        {entries.length === 0 && <p className="empty-state">{t('还没有研究记录。先保存一次当前判断，之后再做复盘。', '研究記録はまだありません。現在の判断を保存してから振り返りましょう。', 'No research records yet. Save the current judgement once, then review it later.')}</p>}
      </div>
    </section>
  );
}
