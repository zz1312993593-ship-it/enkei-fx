'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MarketQuote, RiskConfig } from '../lib/market-data';
import type { ResearchModel } from '../lib/research-signal';
import { modelDefinition } from '../lib/model-catalog';

interface PaperPosition {
  id: string;
  symbol: MarketQuote['symbol'];
  side: 'long' | 'short';
  units: number;
  entry: number;
  stopPips: number;
  openedAt: string;
}

interface PaperLog {
  id: string;
  time: string;
  createdAt?: string;
  textZh: string;
  textJa: string;
  textEn?: string;
}

interface PaperState {
  balance: number;
  dayKey: string;
  dayOpeningBalance: number;
  positions: PaperPosition[];
  logs: PaperLog[];
}

type PaperPositionWithPnl = PaperPosition & { pnlPips: number; pnlJpy: number };

const STARTING_BALANCE = 1_000_000;
function tokyoDayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const INITIAL_STATE: PaperState = {
  balance: STARTING_BALANCE,
  dayKey: tokyoDayKey(),
  dayOpeningBalance: STARTING_BALANCE,
  positions: [],
  logs: [{ id: 'initial', time: '14:32', textZh: '内部模拟账户已就绪，没有连接券商。', textJa: '内部ペーパー口座を準備しました。ブローカーには接続していません。' }],
};

let paperSequence = 0;

function createLog(textZh: string, textJa: string, textEn = textZh): PaperLog {
  paperSequence += 1;
  const now = new Date();
  return {
    id: `paper-${now.getTime()}-${paperSequence}`,
    time: new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(now),
    createdAt: now.toISOString(),
    textZh,
    textJa,
    textEn,
  };
}

function createPositionId() {
  paperSequence += 1;
  return `position-${Date.now()}-${paperSequence}`;
}

function loadPaperState(): PaperState {
  if (typeof window === 'undefined') return INITIAL_STATE;
  const saved = window.localStorage.getItem('enkei-paper-state');
  if (!saved) return INITIAL_STATE;
  try {
    const parsed = JSON.parse(saved) as Partial<PaperState>;
    const dayKey = tokyoDayKey();
    const balance = Number.isFinite(parsed.balance) ? parsed.balance as number : STARTING_BALANCE;
    return { ...INITIAL_STATE, ...parsed, balance, dayKey, dayOpeningBalance: parsed.dayKey === dayKey && Number.isFinite(parsed.dayOpeningBalance) ? parsed.dayOpeningBalance as number : balance };
  } catch {
    window.localStorage.removeItem('enkei-paper-state');
    return INITIAL_STATE;
  }
}

function pipSize(symbol: MarketQuote['symbol']) {
  return symbol.endsWith('/JPY') ? 0.01 : 0.0001;
}

function pipValueJpy(symbol: MarketQuote['symbol'], units: number) {
  return (symbol.endsWith('/JPY') ? 10 : 14.6) * (units / 1000);
}

function resetForNewTokyoDay(state: PaperState): PaperState {
  const dayKey = tokyoDayKey();
  if (state.dayKey === dayKey) return state;
  return {
    ...state,
    dayKey,
    dayOpeningBalance: state.balance,
    logs: [createLog('已进入新的日本交易日；日内风险预算已重新开始计算。', '新しい日本取引日になったため、日次リスク予算を再計算しました。'), ...state.logs].slice(0, 12),
  };
}

export default function PaperPanel({ language, quote, risk, displayTimeZone = 'Asia/Tokyo', researchModel }: { language: 'zh' | 'ja' | 'en'; quote: MarketQuote; risk: RiskConfig; displayTimeZone?: string; researchModel: ResearchModel }) {
  const [state, setState] = useState<PaperState>(loadPaperState);
  const [marketMovePips, setMarketMovePips] = useState(0);
  const [stopPips, setStopPips] = useState(20);
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const locale = language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US';
  const logTime = (log: PaperLog) => {
    if (!log.createdAt) return log.time;
    const timestamp = new Date(log.createdAt);
    return Number.isNaN(timestamp.getTime()) ? log.time : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: displayTimeZone, hourCycle: 'h23' }).format(timestamp);
  };
  const activeModel = modelDefinition(researchModel);
  const pip = pipSize(quote.symbol);
  const markBid = quote.bid + marketMovePips * pip;
  const markAsk = quote.ask + marketMovePips * pip;

  useEffect(() => {
    window.localStorage.setItem('enkei-paper-state', JSON.stringify(state));
  }, [state]);

  const positionsWithPnl = useMemo(() => state.positions.map((position) => {
    const positionPip = pipSize(position.symbol);
    const current = position.symbol === quote.symbol
      ? (position.side === 'long' ? markBid : markAsk)
      : position.entry;
    const pnlPips = position.side === 'long' ? (current - position.entry) / positionPip : (position.entry - current) / positionPip;
    return { ...position, pnlPips, pnlJpy: pnlPips * pipValueJpy(position.symbol, position.units) };
  }), [markAsk, markBid, quote.symbol, state.positions]);
  const floatingPnl = positionsWithPnl.reduce((total, position) => total + position.pnlJpy, 0);
  const equity = state.balance + floatingPnl;
  const dailyPnlJpy = equity - state.dayOpeningBalance;
  const lossBudgetJpy = state.dayOpeningBalance * (risk.dailyLossLimitPct / 100);
  const lossUsedJpy = Math.max(0, -dailyPnlJpy);
  const lossBudgetRemainingJpy = Math.max(0, lossBudgetJpy - lossUsedJpy);
  const riskAmountJpy = state.balance * (risk.riskPerTradePct / 100);
  const unitsPerThousand = Math.floor(riskAmountJpy / (stopPips * pipValueJpy(quote.symbol, 1000)));
  const suggestedUnits = Math.min(10_000, Math.max(1_000, unitsPerThousand * 1000));
  const stopRiskJpy = stopPips * pipValueJpy(quote.symbol, suggestedUnits);
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 });

  const moveMarket = (deltaPips: number) => {
    const nextMove = marketMovePips + deltaPips;
    const nextBid = quote.bid + nextMove * pip;
    const nextAsk = quote.ask + nextMove * pip;
    setMarketMovePips(nextMove);
    setState((current) => {
      const session = resetForNewTokyoDay(current);
      const stopped = session.positions.map((position) => {
        if (position.symbol !== quote.symbol) return null;
        const currentPrice = position.side === 'long' ? nextBid : nextAsk;
        const pnlPips = position.side === 'long'
          ? (currentPrice - position.entry) / pipSize(position.symbol)
          : (position.entry - currentPrice) / pipSize(position.symbol);
        return { ...position, pnlPips, pnlJpy: pnlPips * pipValueJpy(position.symbol, position.units) };
      }).filter((position): position is PaperPositionWithPnl => position !== null && position.pnlPips <= -position.stopPips);
      if (stopped.length === 0) return session;
      const closedIds = new Set(stopped.map((position) => position.id));
      const realized = stopped.reduce((total, position) => total + position.pnlJpy, 0);
      return {
        ...session,
        balance: session.balance + realized,
        positions: session.positions.filter((position) => !closedIds.has(position.id)),
        logs: [
          ...stopped.map((position) => createLog(
            `${position.symbol} 触发强制止损，模拟平仓 ${Math.round(position.pnlJpy)}日元。`,
            `${position.symbol} の強制ストップが発動し、${Math.round(position.pnlJpy)}円で模擬決済しました。`,
          )),
          ...session.logs,
        ].slice(0, 12),
      };
    });
  };

  const openPosition = (side: PaperPosition['side']) => {
    if (lossUsedJpy >= lossBudgetJpy) {
      setState((current) => {
        const session = resetForNewTokyoDay(current);
        return { ...session, logs: [createLog('订单被风控拒绝：今日的模拟亏损上限已触发。', 'リスク制御により拒否：本日の模擬損失上限に到達。'), ...session.logs].slice(0, 12) };
      });
      return;
    }
    if (state.positions.length >= risk.maxOpenPositions) {
      setState((current) => ({ ...current, logs: [createLog('订单被风控拒绝：达到最大持仓数。', 'リスク制御により拒否：最大保有数に到達。'), ...current.logs].slice(0, 12) }));
      return;
    }
    if (stopRiskJpy > lossBudgetRemainingJpy) {
      setState((current) => ({ ...current, logs: [createLog('订单被风控拒绝：该仓位的止损金额将超过剩余风险预算。', 'リスク制御により拒否：このポジションのストップ損失額が残りリスク予算を超えます。'), ...current.logs].slice(0, 12) }));
      return;
    }
    const entry = side === 'long' ? markAsk : markBid;
    const position: PaperPosition = { id: createPositionId(), symbol: quote.symbol, side, units: suggestedUnits, entry, stopPips, openedAt: new Date().toISOString() };
    setState((current) => ({
      ...current,
      positions: [...current.positions, position],
      logs: [createLog(`${quote.symbol} 模拟${side === 'long' ? '买入' : '卖出'} ${suggestedUnits.toLocaleString()}单位；强制止损${stopPips} pips。`, `${quote.symbol} ペーパー${side === 'long' ? '買い' : '売り'} ${suggestedUnits.toLocaleString()}通貨；必須ストップ${stopPips} pips。`), ...current.logs].slice(0, 12),
    }));
  };

  const closePosition = (position: PaperPositionWithPnl) => {
    setState((current) => {
      const session = resetForNewTokyoDay(current);
      return {
        ...session,
        balance: session.balance + position.pnlJpy,
        positions: session.positions.filter((item) => item.id !== position.id),
        logs: [createLog(`${position.symbol} 模拟平仓，结果 ${position.pnlJpy >= 0 ? '+' : ''}${Math.round(position.pnlJpy)}日元。`, `${position.symbol} ペーパー決済、損益 ${position.pnlJpy >= 0 ? '+' : ''}${Math.round(position.pnlJpy)}円。`), ...session.logs].slice(0, 12),
      };
    });
  };

  const reset = () => {
    setState({ ...INITIAL_STATE, logs: [createLog('内部模拟账户已重置。', '内部ペーパー口座をリセットしました。')] });
    setMarketMovePips(0);
  };

  return (
    <section className="phase-panel paper-panel">
      <div className="phase-heading">
        <div><p className="eyebrow">INTERNAL PAPER · NO BROKER CONNECTION</p><h3>{t('内部模拟交易', '内部ペーパートレード', 'Internal paper trading')} <span>{quote.symbol}</span></h3></div>
        <div className="paper-actions"><button onClick={() => moveMarket(-5)}>−5 pips</button><button onClick={() => moveMarket(5)}>＋5 pips</button></div>
      </div>
      <div className="paper-safety"><span>✓</span><p><b>{t('与乐天完全隔离', '楽天口座から完全分離', 'Fully isolated from Rakuten')}</b><small>{t('这里的买卖只改变浏览器本机的模拟账本。', 'ここでの売買はブラウザ内の模擬台帳だけを変更します。', 'Buying and selling here changes only the simulated ledger in this browser.')}</small></p></div>
      <div className="paper-research-link"><span>{t('第 3 步 · 内部模拟', '第3段階・内部ペーパー', 'Step 3 · internal paper')}</span><b>{language === 'zh' ? activeModel.zh : language === 'ja' ? activeModel.ja : activeModel.id}</b><small>{t('信号仅供你手动决定是否测试；此处不会自动开仓，也没有券商连接。', 'シグナルはあなたが手動でテストを決めるためだけのものです。自動発注もブローカー接続もありません。', 'Signals are for manual review only; this panel never opens trades or connects to a broker.')} {displayTimeZone === 'Asia/Tokyo' ? 'JST' : displayTimeZone === 'America/New_York' ? 'ET' : displayTimeZone === 'Europe/London' ? 'UK' : 'CST'}</small></div>
      <div className="paper-summary">
        <article><span>{t('模拟余额', '模擬残高', 'Paper balance')}</span><strong>{money.format(state.balance)}</strong><small>{t('初始资金 ¥1,000,000', '初期資金 ¥1,000,000', 'Initial capital ¥1,000,000')}</small></article>
        <article><span>{t('模拟权益', '模擬純資産', 'Paper equity')}</span><strong>{money.format(equity)}</strong><small className={floatingPnl >= 0 ? 'positive' : 'negative'}>{t('浮动', '含み', 'Floating')} {floatingPnl >= 0 ? '+' : ''}{money.format(floatingPnl)}</small></article>
        <article><span>{t('当前报价', '現在レート', 'Current quote')}</span><strong>{markBid.toFixed(quote.symbol.endsWith('/JPY') ? 3 : 5)}</strong><small>{marketMovePips >= 0 ? '+' : ''}{marketMovePips.toFixed(1)} pips</small></article>
        <article><span>{t('今日风险预算', '本日のリスク予算', 'Risk budget today')}</span><strong>{money.format(lossBudgetRemainingJpy)}</strong><small>{t('日本时间日内；上限', '日本時間・日次上限', 'Intraday in Japan time; cap')} {money.format(lossBudgetJpy)}</small></article>
      </div>
      <div className="paper-order-card">
        <div><p className="eyebrow">RISK-SIZED PAPER TICKET</p><h4>{quote.symbol} · {suggestedUnits.toLocaleString()} {t('单位', '通貨', 'Units')}</h4><span>{t(`按单笔风险 ${risk.riskPerTradePct.toFixed(2)}% 计算；${stopPips} pips止损约为 ${Math.round(stopRiskJpy)}日元，触及后自动平仓。`, `1取引リスク ${risk.riskPerTradePct.toFixed(2)}% から算出。${stopPips} pipsのストップ損失は約${Math.round(stopRiskJpy)}円で、自動決済します。`, `Sized from ${risk.riskPerTradePct.toFixed(2)}% risk per trade; a ${stopPips} pips stop is about ¥${Math.round(stopRiskJpy)} and closes automatically.`)}</span></div>
        <div className="paper-stop-control"><label><span>{t('强制止损', '必須ストップ', 'Mandatory stop')}</span><input type="range" min="5" max="100" step="1" value={stopPips} onChange={(event) => setStopPips(Number(event.target.value))} /><b>{stopPips} pips</b></label></div>
        <div><button className="sell-paper" onClick={() => openPosition('short')}>{t('模拟卖出', 'ペーパー売り', 'Paper sell')}<b>{markBid.toFixed(quote.symbol.endsWith('/JPY') ? 3 : 5)}</b></button><button className="buy-paper" onClick={() => openPosition('long')}>{t('模拟买入', 'ペーパー買い', 'Paper buy')}<b>{markAsk.toFixed(quote.symbol.endsWith('/JPY') ? 3 : 5)}</b></button></div>
      </div>
      <div className="daily-risk-strip"><span>{t('日本交易日', '日本取引日', 'Japan trading day')} {state.dayKey}</span><b className={dailyPnlJpy >= 0 ? 'positive' : 'negative'}>{t('今日模拟损益', '本日の模擬損益', 'Paper P&L today')} {dailyPnlJpy >= 0 ? '+' : ''}{money.format(dailyPnlJpy)}</b><small>{t('达到日内亏损上限后，本日不再允许新的模拟开仓。', '日次損失上限に達すると、その日の新規ペーパー注文は停止します。', 'After the intraday loss cap is reached, no new paper positions are allowed today.')}</small></div>
      <div className="paper-grid">
        <article className="positions-panel"><div className="section-title"><b>{t('模拟持仓', '模擬ポジション', 'Paper positions')}</b><span>{t('刷新后保留在本机', '端末内に保存', 'Kept locally across refreshes')}</span></div>
          {positionsWithPnl.map((position) => (
            <div className="position-row" key={position.id}><div><b>{position.symbol}</b><small>{position.side === 'long' ? t('买入', '買い', 'Buy') : t('卖出', '売り', 'Sell')} · {position.units.toLocaleString()}</small></div><p><strong className={position.pnlJpy >= 0 ? 'positive' : 'negative'}>{position.pnlJpy >= 0 ? '+' : ''}{Math.round(position.pnlJpy)}円</strong><small>{position.pnlPips >= 0 ? '+' : ''}{position.pnlPips.toFixed(1)} pips</small></p><button onClick={() => closePosition(position)}>{t('平仓', '決済', 'Close')}</button></div>
          ))}
          {positionsWithPnl.length === 0 && <p className="empty-state">{t('没有模拟持仓。可使用上方按钮测试完整订单流程。', '模擬ポジションはありません。上のボタンで注文フローを確認できます。', 'No paper positions. Use the buttons above to test the full order flow.')}</p>}
        </article>
        <article className="paper-log"><div className="section-title"><b>{t('审计日志', '監査ログ', 'Audit log')}</b><button onClick={reset}>{t('重置模拟账户', '口座をリセット', 'Reset paper account')}</button></div>{state.logs.map((log) => <div className="log-row" key={log.id}><time>{logTime(log)}</time><p>{language === 'zh' ? log.textZh : language === 'ja' ? log.textJa : log.textEn ?? log.textZh}</p></div>)}</article>
      </div>
    </section>
  );
}
