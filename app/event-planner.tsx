'use client';

import { useEffect, useMemo, useState } from 'react';

type Language = 'zh' | 'ja' | 'en';
type WindowKey = '1d' | '3d' | '5d' | '7d' | 'week' | 'month' | 'quarter';
type Impact = 'high' | 'medium' | 'low';

interface EventItem {
  id: string;
  time: string;
  title: string;
  titleJa?: string;
  titleEn?: string;
  impact: Impact;
  note?: string;
  noteJa?: string;
  noteEn?: string;
  source: 'template' | 'personal';
}

const windows: Array<{ id: WindowKey; zh: string; ja: string; en: string; days: number }> = [
  { id: '1d', zh: '日', ja: '日', en: 'Day', days: 1 }, { id: '3d', zh: '三日', ja: '3日', en: '3 days', days: 3 }, { id: '5d', zh: '五日', ja: '5日', en: '5 days', days: 5 },
  { id: '7d', zh: '七日', ja: '7日', en: '7 days', days: 7 }, { id: 'week', zh: '周', ja: '週', en: 'Week', days: 7 }, { id: 'month', zh: '月', ja: '月', en: 'Month', days: 31 }, { id: 'quarter', zh: '季', ja: '四半期', en: 'Quarter', days: 92 },
];

function dateForOffset(offset: number, hour: number, minute: number) {
  const now = new Date();
  const result = new Date(now.getTime() + offset * 86_400_000);
  result.setHours(hour, minute, 0, 0);
  return result.toISOString();
}

// datetime-local has no timezone of its own. Interpret the entered wall-clock
// time in the timezone selected in the header instead of the PC's timezone.
function fromTimeZoneInput(value: string, timeZone: string) {
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
  return new Date(Math.floor(epoch / 1000) * 1000).toISOString();
}

function initialTemplate(): EventItem[] {
  return [
    { id: 'template-1', time: dateForOffset(0, 21, 30), title: '美国重要经济数据（请核对）', titleJa: '米国重要経済指標（要確認）', titleEn: 'Major US economic data (verify)', impact: 'high', source: 'template', note: '本地模板：开始模拟前请以官方日历核验。', noteJa: '端末テンプレート：模擬開始前に公式カレンダーを確認してください。', noteEn: 'Local template: verify against the official calendar before rehearsal.' },
    { id: 'template-2', time: dateForOffset(1, 8, 30), title: '日本宏观数据 / 央行相关日程（请核对）', titleJa: '日本マクロ指標・中央銀行日程（要確認）', titleEn: 'Japan macro data / central-bank schedule (verify)', impact: 'medium', source: 'template', note: '本地模板：可添加你自己的判断。', noteJa: '端末テンプレート：自分の判断メモを追加できます。', noteEn: 'Local template: add your own assessment.' },
    { id: 'template-3', time: dateForOffset(3, 21, 30), title: '美国就业或通胀相关数据（请核对）', titleJa: '米国雇用・インフレ関連指標（要確認）', titleEn: 'US employment or inflation data (verify)', impact: 'high', source: 'template' },
  ];
}

function loadPersonalEvents() {
  if (typeof window === 'undefined') return [] as EventItem[];
  try { return JSON.parse(window.localStorage.getItem('enkei-event-notes') ?? '[]') as EventItem[]; } catch { return []; }
}

export default function EventPlanner({ language, timeZone = 'Asia/Tokyo' }: { language: Language; timeZone?: string }) {
  const [windowKey, setWindowKey] = useState<WindowKey>('1d');
  const [items, setItems] = useState<EventItem[]>(loadPersonalEvents);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [impact, setImpact] = useState<Impact>('medium');
  const [when, setWhen] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const selected = windows.find((item) => item.id === windowKey) ?? windows[0];
  const template = useMemo(() => initialTemplate(), []);
  const visible = useMemo(() => [...template, ...items]
    .filter((item) => new Date(item.time).getTime() >= now - 60_000)
    .filter((item) => new Date(item.time).getTime() <= now + selected.days * 86_400_000)
    .sort((left, right) => left.time.localeCompare(right.time)), [items, now, selected.days, template]);

  useEffect(() => { window.localStorage.setItem('enkei-event-notes', JSON.stringify(items)); }, [items]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);

  const addEvent = () => {
    if (!title.trim() || !when) return;
    const isoTime = fromTimeZoneInput(when, timeZone);
    if (!isoTime) return;
    setItems((current) => [...current, { id: `personal-${Date.now()}`, title: title.trim(), time: isoTime, note: note.trim() || undefined, impact, source: 'personal' }]);
    setTitle(''); setNote(''); setWhen(''); setImpact('medium');
  };
  const format = (value: string) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone, hourCycle: 'h23' }).format(new Date(value));
  const eventTitle = (item: EventItem) => language === 'zh' ? item.title : language === 'ja' ? item.titleJa ?? item.title : item.titleEn ?? item.title;
  const eventNote = (item: EventItem) => language === 'zh' ? item.note : language === 'ja' ? item.noteJa ?? item.note : item.noteEn ?? item.note;

  return <article className="event-card event-planner">
    <div className="event-heading"><div className="card-kicker">{t('未来事件', '今後のイベント', 'Upcoming events')}</div><span>{t('本机备忘', '端末内メモ', 'local notes')} · {timeZone === 'Asia/Tokyo' ? 'JST' : timeZone === 'America/New_York' ? 'ET' : timeZone === 'Europe/London' ? 'UK' : 'CST'}</span></div>
    <div className="event-windows">{windows.map((item) => <button key={item.id} className={item.id === windowKey ? 'active' : ''} onClick={() => setWindowKey(item.id)}>{language === 'zh' ? item.zh : language === 'ja' ? item.ja : item.en}</button>)}</div>
    <p className="event-disclaimer">{t('模板不会自动宣称为实时日历；关键事件请在开始模拟前按官方来源核对。', 'テンプレートはリアルタイム日程ではありません。重要イベントは模擬開始前に公式情報で確認してください。', 'Templates are not a live calendar; verify important events with an official source before rehearsal.')}</p>
    <div className="event-list">
      {visible.map((item) => <div className="event-row" key={item.id}><time>{format(item.time)}</time><p><strong>{eventTitle(item)}</strong>{eventNote(item) && <small>{eventNote(item)}</small>}</p><span className={item.impact}>{item.impact === 'high' ? t('高', '高', 'High') : item.impact === 'medium' ? t('中', '中', 'Medium') : t('低', '低', 'Low')}</span></div>)}
      {visible.length === 0 && <p className="empty-state">{t('该范围内尚未添加事件。', 'この期間にはイベントがありません。', 'No events in this range.')}</p>}
    </div>
    <details className="event-note-form"><summary>{t('添加个人备注 / 事件', '個人メモ / イベントを追加', 'Add personal note / event')}</summary><div><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('事件标题', 'イベント名', 'Event title')} /><input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} /><select value={impact} onChange={(event) => setImpact(event.target.value as Impact)}><option value="low">{t('低', '低', 'Low')}</option><option value="medium">{t('中', '中', 'Medium')}</option><option value="high">{t('高', '高', 'High')}</option></select><input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('你的备注（可选）', 'メモ（任意）', 'Your note (optional)')} /><button onClick={addEvent}>{t('加入本机日历', '端末内カレンダーに追加', 'Add to local calendar')}</button></div></details>
  </article>;
}
