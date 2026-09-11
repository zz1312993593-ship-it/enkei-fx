'use client';

// 批K：首次启动引导。选择界面语言与显示时区后写入本机长期记忆（localStorage），
// 再次启动不再出现；可在 设置 → 风险与偏好 重新打开。
import { useState } from 'react';

type Language = 'zh' | 'ja' | 'en';
type DisplayTimeZone = 'Asia/Tokyo' | 'America/New_York' | 'Europe/London' | 'Asia/Shanghai';

const TIME_ZONES: Array<{ id: DisplayTimeZone; zh: string; ja: string; en: string; short: string }> = [
  { id: 'Asia/Tokyo', zh: '日本时间', ja: '日本時間', en: 'Japan time', short: 'JST' },
  { id: 'America/New_York', zh: '美国东部', ja: '米国東部', en: 'US Eastern', short: 'ET' },
  { id: 'Europe/London', zh: '英国时间', ja: '英国時間', en: 'UK time', short: 'UK' },
  { id: 'Asia/Shanghai', zh: '中国时间', ja: '中国時間', en: 'China time', short: 'CST' },
];

const LANGUAGES: Array<{ id: Language; label: string; note: { zh: string; ja: string; en: string } }> = [
  { id: 'ja', label: '日本語', note: { zh: '界面将使用日语显示', ja: 'このアプリは日本語で表示されます', en: 'The interface will be shown in Japanese' } },
  { id: 'en', label: 'English', note: { zh: '界面将使用英文显示', ja: 'このアプリは英語で表示されます', en: 'The interface will be shown in English' } },
  { id: 'zh', label: '中文', note: { zh: '界面将使用中文显示', ja: 'このアプリは中国語で表示されます', en: 'The interface will be shown in Chinese' } },
];

export default function FirstRunWelcome({ initialLanguage, initialTimeZone, onFinish }: {
  initialLanguage: Language;
  initialTimeZone: DisplayTimeZone;
  onFinish: (language: Language, timeZone: DisplayTimeZone) => void;
}) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [timeZone, setTimeZone] = useState<DisplayTimeZone>(initialTimeZone);
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  return (
    <div className="welcome-layer" role="dialog" aria-modal="true" aria-label={t('初始设置', '初期設定', 'First-run setup')}>
      <div className="welcome-card">
        <p className="eyebrow">ENKEI FX · FIRST RUN</p>
        <h1>円衡 FX</h1>
        <p className="welcome-lede">{t(
          '开始前请选择界面语言与显示时区。这两项会被长期记忆，随时可在 设置 → 风险与偏好 中修改。',
          '開始前に表示言語とタイムゾーンを選択してください。選択は端末に保存され、設定 → リスクと設定 からいつでも変更できます。',
          'Pick your interface language and display time zone. Both are remembered on this device and can be changed any time under Settings → Risk & preferences.',
        )}</p>

        <section aria-label={t('界面语言', '表示言語', 'Interface language')}>
          <h2>{t('1. 界面语言', '1. 表示言語', '1. Interface language')}</h2>
          <div className="welcome-lang-grid">
            {LANGUAGES.map((item) => (
              <button key={item.id} className={`welcome-lang ${language === item.id ? 'active' : ''}`} aria-pressed={language === item.id} onClick={() => setLanguage(item.id)}>
                <b>{item.label}</b><small>{item.note[language]}</small>
              </button>
            ))}
          </div>
        </section>

        <section aria-label={t('显示时区', '表示タイムゾーン', 'Display time zone')}>
          <h2>{t('2. 显示时区', '2. 表示タイムゾーン', '2. Display time zone')}</h2>
          <div className="welcome-tz-grid">
            {TIME_ZONES.map((zone) => (
              <button key={zone.id} className={`welcome-tz ${timeZone === zone.id ? 'active' : ''}`} aria-pressed={timeZone === zone.id} onClick={() => setTimeZone(zone.id)}>
                <b>{zone.short}</b><small>{language === 'zh' ? zone.zh : language === 'ja' ? zone.ja : zone.en}</small>
              </button>
            ))}
          </div>
        </section>

        <ul className="welcome-safety">
          <li>{t('本程序只读取你本机 MT4 的行情；不会替你下单。', '本アプリは端末内MT4のレートのみを読み取ります。注文は代行しません。', 'This app only reads market data from your local MT4; it never places orders for you.')}</li>
          <li>{t('实盘功能默认全局锁定；Demo 演练需要配对与急停确认。', '実取引は既定でロック。Demo演習にはペアリングと緊急停止の確認が必要です。', 'Live trading stays locked by default; Demo practice requires pairing and the kill switch.')}</li>
        </ul>

        <button className="welcome-start" onClick={() => onFinish(language, timeZone)}>
          {t('进入工作台', 'ワークベンチへ進む', 'Enter the workbench')}
        </button>
      </div>
    </div>
  );
}
