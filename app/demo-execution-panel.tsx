'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketQuote, RiskConfig } from '../lib/market-data';

type Language = 'zh' | 'ja' | 'en';
type DemoPosition = { ticket: number; symbol: string; side: 'long' | 'short'; lots: number; open_price: number; current_price: number; stop_loss: number; take_profit: number; profit: number; swap: number; commission: number };
type ClosedDemoPosition = { ticket: number; symbol: string; side: 'long' | 'short'; lots: number; open_price: number; close_price: number; opened_at: string; closed_at: string; profit: number; swap: number; commission: number };
type QuoteTick = { time: number; mid: number; symbol: string };
type GateStatus = { build_version?: string; status: 'ready' | 'ticket-pending' | 'killed' | string; pending?: boolean; close_pending?: boolean; killed?: boolean; audit?: string[][]; limits?: { max_lots: number; ticket_ttl_seconds: number }; demo_positions?: DemoPosition[]; demo_closed_positions?: ClosedDemoPosition[]; demo_positions_updated_at?: string | null; demo_positions_updated_at_epoch?: number | null; safety?: { live_accounts?: boolean; automatic_entries?: boolean; demo_position_view?: boolean } };
const SESSION_PAIRING_CODE = 'enkei-demo-gate-pairing-code';
const SESSION_PAIRING_VERIFIED = 'enkei-demo-gate-pairing-verified';

export default function DemoExecutionPanel({ language, quote, risk }: { language: Language; quote: MarketQuote; risk: RiskConfig }) {
  const [code, setCode] = useState('');
  const [paired, setPaired] = useState(false);
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [lots, setLots] = useState('0.01');
  const [stopPips, setStopPips] = useState('30');
  const [rewardRisk, setRewardRisk] = useState('2');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState('');
  const [ticks, setTicks] = useState<QuoteTick[]>([]);
  const statusFailures = useRef(0);
  const t = (zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en;
  const bilingual = (zh: string, ja: string, english: string) => t(zh, ja, english);
  const auditEvent = (event: string) => {
    const labels: Record<string, [string, string]> = {
      'ticket-created': ['指令已创建', '指示を作成'], 'ticket-rejected': ['指令被拒绝', '指示を拒否'],
      'ticket-expired': ['指令已过期', '指示が期限切れ'], 'execution-success': ['执行成功', '実行成功'],
      'execution-failed': ['执行失败', '実行失敗'], 'kill-active': ['急停已激活', '緊急停止を有効化'],
      'kill-reset': ['急停已重置', '緊急停止を解除'], 'ticket-cancelled': ['指令已取消', '指示を取消'],
    };
    const label = labels[event];
    return label ? bilingual(label[0], label[1], event) : event;
  };
  const auditDetail = (detail: string) => {
    if (detail.includes('execution-disabled')) return bilingual('执行开关关闭', '実行スイッチ無効', detail);
    if (detail.includes('expired-or-invalid-time')) return bilingual('已过期或时间校验未通过', '期限切れまたは時刻検証未通過', detail);
    if (detail.includes('Manual emergency stop activated')) return bilingual('人工急停已激活', '手動の緊急停止を有効化', detail);
    if (detail.includes('Manual emergency stop reset')) return bilingual('人工急停已重置', '手動の緊急停止を解除', detail);
    if (detail.includes('spread-limit')) return bilingual('实际点差超过确认服务允许范围', '実スプレッドが確認サービスの許容範囲を超過', detail);
    if (detail.includes('open-position-limit')) return bilingual('已达到 Demo EA 配置的并行持仓上限', 'Demo EA設定の同時保有上限に到達', 'Demo EA position limit reached');
    if (detail.includes('non-demo-account')) return bilingual('检测到非 Demo 账户，已拒绝执行', 'Demo以外の口座を検出したため実行を拒否', detail);
    if (detail.includes('invalid-stop-or-target')) return bilingual('止损或目标价格无效', 'ストップまたは目標価格が無効', detail);
    return detail;
  };
  const pip = quote.symbol.endsWith('/JPY') ? .01 : .0001;
  const decimals = quote.symbol.endsWith('/JPY') ? 3 : 5;
  const stop = Math.max(5, Math.min(200, Number(stopPips) || 30));
  const reward = Math.max(1, Math.min(5, Number(rewardRisk) || 2));
  const priceLevels = useMemo(() => side === 'long'
    ? { stopLoss: quote.bid - stop * pip, takeProfit: quote.ask + stop * reward * pip }
    : { stopLoss: quote.ask + stop * pip, takeProfit: quote.bid - stop * reward * pip }, [pip, quote.ask, quote.bid, reward, side, stop]);
  const openPnl = (status?.demo_positions ?? []).reduce((sum, item) => sum + item.profit + item.swap + item.commission, 0);
  const lastClosed = status?.demo_closed_positions?.[0];
  const lastClosedPnl = lastClosed ? lastClosed.profit + lastClosed.swap + lastClosed.commission : null;
  useEffect(() => {
    if (quote.source !== 'mt4') return;
    const sample = window.setTimeout(() => setTicks((current) => {
      const next = { time: Date.now(), mid: (quote.bid + quote.ask) / 2, symbol: quote.symbol };
      // Keep a useful ten-minute local trace rather than a tiny decorative sparkline.
      return current.at(-1)?.symbol === quote.symbol ? [...current, next].slice(-600) : [next];
    }), 0);
    return () => window.clearTimeout(sample);
  }, [quote.ask, quote.bid, quote.source, quote.symbol]);
  const tickRange = useMemo(() => {
    const values = ticks.map((item) => item.mid);
    const low = Math.min(...values, quote.bid);
    const high = Math.max(...values, quote.ask);
    return { low, high: high === low ? high + pip : high };
  }, [pip, quote.ask, quote.bid, ticks]);
  const tickPolyline = useMemo(() => ticks.map((item, index) => {
    const x = ticks.length <= 1 ? 0 : (index / (ticks.length - 1)) * 100;
    const y = 96 - ((item.mid - tickRange.low) / (tickRange.high - tickRange.low)) * 92;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' '), [tickRange.high, tickRange.low, ticks]);
  // The gate may return a burst of identical housekeeping rows after a restart.
  // Keep the receipt useful: preserve the newest occurrence of each semantic
  // event, rather than filling the whole page with repeated reset notices.
  const auditRows = useMemo(() => {
    const seen = new Set<string>();
    return (status?.audit ?? []).filter((row) => row[0] !== 'time').filter((row) => {
      const key = `${row[2] ?? ''}|${row[3] ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [status?.audit]);
  const request = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const needsPairing = method !== 'GET';
    const response = await fetch(`http://127.0.0.1:8790${path}`, { method, headers: needsPairing ? { 'Content-Type': 'application/json', ...(code ? { 'X-Enkei-Demo-Code': code } : {}) } : undefined, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json() as GateStatus & { error?: string; ticket?: { id: string; expires_at: string } };
    if (!response.ok) throw new Error(payload.error ?? 'Gateway request failed.');
    return payload;
  }, [code]);
  const refresh = useCallback(async () => { try { const next = await request('/api/status'); statusFailures.current = 0; setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); } catch { statusFailures.current += 1; if (statusFailures.current >= 3) setStatus(null); } }, [request]);
  useEffect(() => {
    let active = true;
    const restore = window.setTimeout(() => {
      void (async () => {
        try {
          const stagedCode = window.sessionStorage.getItem('enkei-demo-gate-local-code');
          if (stagedCode) { window.sessionStorage.removeItem('enkei-demo-gate-local-code'); if (active) setCode(stagedCode); }
          const storedCode = stagedCode ?? window.sessionStorage.getItem(SESSION_PAIRING_CODE);
          if (!storedCode) return;
          // A code being present is deliberately not treated as a connection.
          // Only an earlier successful verification may be resumed automatically.
          if (window.sessionStorage.getItem(SESSION_PAIRING_VERIFIED) !== 'true') { if (active) setCode(storedCode); return; }
          const response = await fetch('http://127.0.0.1:8790/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Enkei-Demo-Code': storedCode } });
          if (!response.ok) throw new Error('pairing rejected');
          if (active) { setCode(storedCode); setPaired(true); }
        } catch {
          try { window.sessionStorage.removeItem(SESSION_PAIRING_CODE); window.sessionStorage.removeItem(SESSION_PAIRING_VERIFIED); } catch {}
          if (active) setPaired(false);
        }
      })();
    }, 0);
    return () => { active = false; window.clearTimeout(restore); };
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  const pair = async () => { try { await request('/api/pair', 'POST', {}); setPaired(true); try { window.sessionStorage.setItem(SESSION_PAIRING_CODE, code); window.sessionStorage.setItem(SESSION_PAIRING_VERIFIED, 'true'); } catch {} setNotice(t('已验证连接到本机 Demo 执行确认服务。当前浏览器会话内将保持验证状态。', '端末内Demo実行確認サービスへの接続を検証しました。現在のブラウザセッションで検証状態を保持します。', 'Verified connection to the local Demo execution confirmation service. The verification stays valid for this browser session.')); await refresh(); } catch (error) { setPaired(false); try { window.sessionStorage.removeItem(SESSION_PAIRING_CODE); window.sessionStorage.removeItem(SESSION_PAIRING_VERIFIED); } catch {} setNotice(error instanceof Error ? error.message : t('验证连接失败。', '接続検証に失敗しました。', 'Connection verification failed.')); } };
  const submit = async () => {
    try {
      const payload = await request('/api/ticket', 'POST', { symbol: quote.symbol, side, lots: Number(lots), stopLoss: priceLevels.stopLoss, takeProfit: priceLevels.takeProfit, maxSpreadPips: risk.maxSpreadPips, confirmation });
      const ticket = payload.ticket;
      setNotice(ticket ? `${t('Demo 指令已创建，90 秒内有效：', 'Demo指示を作成しました。90秒間有効：', 'Demo order created, valid for 90 seconds:')}${ticket.id}` : t('Demo 指令已创建。', 'Demo指示を作成しました。', 'Demo order created.'));
      setConfirmation(''); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('Demo 指令被拒绝。', 'Demo指示は拒否されました。', 'Demo order rejected.')); }
  };
  const emergency = async (reset = false) => { try { await request(reset ? '/api/kill/reset' : '/api/kill', 'POST', {}); setNotice(reset ? t('急停已重置；仍不会自动创建指令。', '緊急停止を解除しました。自動指示は作成されません。', 'Emergency stop reset; orders are still never created automatically.') : t('急停已激活；所有待执行 Demo 指令都会被阻止。', '緊急停止を有効化しました。すべてのDemo指示を停止します。', 'Emergency stop activated; all pending Demo orders are blocked.')); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : t('操作失败。', '操作に失敗しました。', 'The operation failed.')); } };
  const closeAll = async () => {
    if (!(status?.demo_positions?.length) || closingAll || !paired) return;
    if (!window.confirm(t('确认立即平掉本 EA 的全部 Demo 持仓？指令提交后由 MT4 执行。', 'このEAのDemo保有をすべて直ちに決済しますか？ MT4が実行します。', 'Close all Demo positions opened by this EA now? MT4 will execute the request.'))) return;
    setClosingAll(true); setNotice('');
    try {
      await request('/api/close', 'POST', { ticket: 0, confirmation: 'DEMO' });
      setNotice(t('全部 Demo 平仓指令已提交，正在等待 MT4 回执。', 'Demo全決済指示を送信し、MT4の応答を待っています。', 'Close-all Demo request submitted; waiting for the MT4 receipt.'));
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('全部平仓失败。', '全決済に失敗しました。', 'Close all failed.')); }
    finally { setClosingAll(false); }
  };
  const cancel = async () => { try { await request('/api/cancel', 'POST', {}); setNotice(t('待执行 Demo 指令已取消。', '待機中のDemo指示を取消しました。', 'The pending Demo order has been cancelled.')); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : t('取消失败。', '取消に失敗しました。', 'Cancellation failed.')); } };

  return <section className="phase-panel demo-execution-panel">
    <div className="phase-heading"><div><p className="eyebrow">{bilingual('第九阶段：Demo 执行确认服务', '第9段階：Demo実行確認サービス', 'Phase 9 · Demo execution confirmation')}</p><h3>{t('Demo 执行确认服务', 'Demo実行確認サービス', 'Demo execution confirmation service')} <span>{t('配对验证 · 小额硬上限 · 随时急停', 'ペアリング検証・少額上限・緊急停止', 'Pairing verification · small hard caps · emergency stop anytime')}</span></h3></div><span className="demo-gate-chip">{bilingual('仅限模拟', 'Demo限定', 'Demo only')}</span></div>
    <div className="demo-live-strip"><article><span>{t('当前报价', '現在のレート', 'Current quote')}</span><b>{quote.bid.toFixed(decimals)} / {quote.ask.toFixed(decimals)}</b><small>{quote.source === 'mt4' ? t('MT4 只读，每秒刷新', 'MT4読取専用・毎秒更新', 'MT4 read-only, refreshed every second') : t('等待 MT4 报价', 'MT4レート待機', 'Waiting for MT4 quotes')}</small></article><article><span>{t('当前持仓 / 浮动盈亏', '現在の保有 / 評価損益', 'Open positions / floating P&L')}</span><b className={openPnl >= 0 ? 'positive' : 'negative'}>{status?.demo_positions?.length ?? 0} · {openPnl.toFixed(2)}</b><small>{t('只统计本 EA 的 Demo 仓位', 'このEAのDemo保有だけを集計', 'Counts only this EA\'s Demo positions')}</small></article><article><span>{t('最近已平仓结果', '直近の決済結果', 'Latest closed results')}</span><b className={lastClosedPnl === null || lastClosedPnl >= 0 ? 'positive' : 'negative'}>{lastClosedPnl === null ? '—' : lastClosedPnl.toFixed(2)}</b><small>{lastClosed ? `#${lastClosed.ticket} · ${lastClosed.closed_at}` : t('尚无已平仓记录', '決済済み記録はまだありません', 'No closed records yet')}</small></article></div>
    <div className="execution-safety-actions"><button className="close-all-button" onClick={() => void closeAll()} disabled={!paired || !status?.demo_positions?.length || status?.killed || status?.close_pending || closingAll}>{closingAll || status?.close_pending ? t('平仓处理中…', '決済処理中…', 'Closing…') : t('一键平掉全部 Demo 持仓', 'Demo保有を一括決済', 'Close all Demo positions')}</button><small>{t('仅关闭本 EA 创建的 Demo 持仓；不会影响其他人工仓位。', 'このEAが作成したDemo保有のみ決済し、手動保有には影響しません。', 'Closes only Demo positions created by this EA; manual positions are untouched.')}</small></div>
    <div className="demo-execution-warning"><span>!</span><p><b>{t('这是乐天 MT4 Demo 的受控执行演练，不是实盘入口。', 'これは楽天MT4 Demoの制御された実行演習であり、実取引の入口ではありません。', 'This is a controlled execution exercise on the Rakuten MT4 Demo, not a live-trading entrance.')}</b><small>{t('“启动服务”只代表本机服务正在等待连接；只有配对码被输入并经本机验证后，浏览器才是“已验证连接”。', '「サービス起動」は端末内サービスが接続待機であることだけを示します。コードを入力し端末内で検証されて初めて、ブラウザは「接続検証済み」になります。', '“Start service” only means the local service is waiting for a connection; the browser counts as “verified” only after the pairing code is entered and validated locally.')}</small></p></div>
    <details className="demo-service-details"><summary>{t('连接与确认（仅首次使用）', '接続と確認（初回のみ）', 'Connection and confirmation (first use)')}<small>{paired ? t('当前浏览器已验证', 'このブラウザは検証済み', 'This browser is verified') : t('尚未完成验证', '検証が未完了', 'Verification needed')}</small></summary><div className="demo-gate-status"><article><span>{t('本机确认服务', '端末内確認サービス', 'Local confirmation service')}</span><b className={status?.status === 'ready' ? 'positive' : status?.killed ? 'negative' : ''}>{status?.status === 'ready' ? t('就绪', '準備完了', 'Ready') : status?.status === 'ticket-pending' ? t('指令待执行', '指示待機中', 'Order pending') : status?.killed ? t('急停中', '緊急停止中', 'Emergency-stopped') : t('未启动', '未起動', 'Not started')}</b><small>{t('服务已启动不等于浏览器已连接。', 'サービス起動はブラウザ接続済みを意味しません。', 'A started service does not mean the browser is connected.')}</small></article><article><span>{t('配对状态', 'ペアリング状態', 'Pairing status')}</span><b className={paired ? 'positive' : code ? '' : 'negative'}>{paired ? t('已验证连接', '接続検証済み', 'Verified') : code ? t('已输入，待验证', '入力済み・検証待ち', 'Entered, pending verification') : t('未输入配对码', 'コード未入力', 'No pairing code entered')}</b><small>{t('点击“验证并连接”后才真正完成。', '「検証して接続」を押して初めて完了します。', 'It is only completed after clicking “Verify & connect”.')}</small></article><article><span>{t('有效期', '有効期限', 'Validity')}</span><b>{status?.limits?.ticket_ttl_seconds ?? 90}s</b><small>{t('过期指令会被拒绝。', '期限切れの指示は拒否されます。', 'Expired orders are rejected.')}</small></article><article><span>{t('实盘状态', '実取引状態', 'Live-trading status')}</span><b className="negative">{t('全局锁定', '全体ロック', 'Globally locked')}</b><small>{t('实盘通道独立提供；未在下方实盘模块启用前始终锁定。', '実取引経路は独立して用意されています。下の実取引モジュールで有効化しない限りロックされたままです。', 'The live channel is provided separately; it stays locked until enabled in the live module below.')}</small></article></div>
    <div className="demo-pairing"><div><p className="eyebrow">{bilingual('步骤 1：验证连接本机服务', '手順1：端末内サービスへの接続を検証', 'Step 1 · Verify local connection')}</p><b>{t('启动服务后，配对码可能已被填入浏览器会话，但它仍只是“已输入”。请点击“验证并连接”完成实际验证。', 'サービス起動後、コードがブラウザセッションに入力済みの場合がありますが、それは「入力済み」に過ぎません。「検証して接続」で実際の検証を完了してください。', 'After the service starts, the pairing code may already be filled into the browser session, but it still only counts as “entered”. Click “Verify & connect” to complete the actual verification.')}</b><small>{t('验证成功只在当前浏览器会话保持；刷新、切换页面无需重输。关闭浏览器或重启服务后须重新验证。', '検証成功は現在のブラウザセッションだけで保持します。再読込・画面切替では再入力不要ですが、ブラウザ終了またはサービス再起動後は再検証が必要です。', 'A successful verification is kept only for this browser session; refreshing and switching pages do not require re-entry. After closing the browser or restarting the service, verify again.')}</small></div><input type="text" inputMode="text" autoComplete="off" value={code} onChange={(event) => { setCode(event.target.value.trim()); setPaired(false); try { window.sessionStorage.removeItem(SESSION_PAIRING_VERIFIED); } catch {} }} placeholder={t('输入配对码', 'ペアリングコードを入力', 'Enter pairing code')} /><button onClick={pair} disabled={!code || paired}>{paired ? t('已验证连接', '接続検証済み', 'Verified') : t('验证并连接', '検証して接続', 'Verify & connect')}</button><button className={status?.killed ? 'reset' : 'kill'} onClick={() => emergency(Boolean(status?.killed))}>{status?.killed ? t('解除急停', '緊急停止を解除', 'Release emergency stop') : t('紧急停止', '緊急停止', 'Emergency stop')}</button></div></details>
    <div className="demo-ticket"><div className="demo-ticket-head"><div><p className="eyebrow">{bilingual('步骤 2：创建一张模拟指令', '手順2：Demo指示を1枚作成', 'Step 2 · Create one Demo ticket')}</p><b>{quote.symbol} · {quote.bid.toFixed(decimals)} / {quote.ask.toFixed(decimals)}</b><small>{t(`风险抽屉点差上限：${risk.maxSpreadPips.toFixed(1)} pips；EA 将在执行前再检查。`, `リスク設定のスプレッド上限：${risk.maxSpreadPips.toFixed(1)} pips。EAが実行前に再確認します。`, `Risk drawer spread cap: ${risk.maxSpreadPips.toFixed(1)} pips; the EA re-checks before execution.`)}</small></div><div className="demo-side"><button className={side === 'long' ? 'active long' : ''} onClick={() => setSide('long')}>{bilingual('模拟买入', 'Demo買い', 'Demo buy')}</button><button className={side === 'short' ? 'active short' : ''} onClick={() => setSide('short')}>{bilingual('模拟卖出', 'Demo売り', 'Demo sell')}</button></div></div><div className="demo-ticket-inputs"><label><span>{t('手数 / lots', '数量 / lots', 'Lots')}</span><select value={lots} onChange={(event) => setLots(event.target.value)}><option>0.01</option><option>0.02</option><option>0.03</option><option>0.05</option><option>0.10</option></select></label><label><span>{t('止损距离', 'ストップ幅', 'Stop distance')}</span><input type="number" min="5" max="200" value={stopPips} onChange={(event) => setStopPips(event.target.value)} /><small>pips</small></label><label><span>{t('目标 R', '目標R', 'Target R')}</span><input type="number" min="1" max="5" step="0.1" value={rewardRisk} onChange={(event) => setRewardRisk(event.target.value)} /></label><article><span>{t('止损价', 'ストップ価格', 'Stop price')}</span><b>{priceLevels.stopLoss.toFixed(decimals)}</b></article><article><span>{t('目标价', '目標価格', 'Target price')}</span><b>{priceLevels.takeProfit.toFixed(decimals)}</b></article></div><div className="demo-confirm"><label><input type="checkbox" checked={paired} readOnly />{t('我已确认本机确认服务已验证连接', '端末内確認サービスへの接続が検証済みであることを確認', 'I confirm the local confirmation service connection is verified')}</label><label><input value={confirmation} maxLength={4} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} placeholder="DEMO" />{t('输入 DEMO 以创建一张 90 秒有效指令', 'DEMOと入力して90秒有効の指示を作成', 'Type DEMO to create a 90-second order')}</label><button onClick={submit} disabled={!paired || status?.killed || status?.pending || confirmation !== 'DEMO'}>{t('创建 Demo 指令', 'Demo指示を作成', 'Create Demo order')}</button><button className="cancel" onClick={cancel} disabled={!paired || !status?.pending}>{t('取消待执行指令', '待機指示を取消', 'Cancel pending order')}</button></div></div>
    {notice && <p className="demo-execution-notice">{notice}</p>}
    <div className="demo-realtime-panel"><div className="section-title"><b>{bilingual('秒级行情与 Demo 持仓', '秒次レートとDemo保有', 'one-second quote & Demo positions')}</b><span>{t('网页每秒刷新；MT4 是成交与盈亏的唯一来源。', 'Webは毎秒更新。MT4が約定・損益の唯一の基準です。', 'The page refreshes every second; MT4 is the single source of fills and P&L.')} {status?.demo_positions_updated_at ? `${t('最近回传', '最終受信', 'Latest report')} ${status.demo_positions_updated_at}` : t('等待 MT4 仓位回传', 'MT4保有の受信待ち', 'Waiting for the MT4 position report')}</span></div>{(status?.demo_positions ?? []).map((position) => <article className="demo-position-row" key={position.ticket}><b>#{position.ticket} · {position.symbol} · {position.side === 'long' ? t('买入', '買い', 'Buy') : t('卖出', '売り', 'Sell')} {position.lots.toFixed(2)}</b><span>{t('开仓', '建値', 'Open')} {position.open_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)} → {t('现价', '現値', 'Price')} {position.current_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</span><span>{t('止损', 'SL', 'SL')} {position.stop_loss.toFixed(position.symbol.includes('JPY') ? 3 : 5)} · {t('目标', 'TP', 'TP')} {position.take_profit.toFixed(position.symbol.includes('JPY') ? 3 : 5)}</span><strong className={position.profit + position.swap + position.commission >= 0 ? 'positive' : 'negative'}>{t('浮动盈亏', '評価損益', 'Floating P&L')} {(position.profit + position.swap + position.commission).toFixed(2)}</strong></article>)}{!(status?.demo_positions?.length) && <p className="empty-state">{t('当前没有由本 EA 创建的 Demo 持仓。', '現在このEAが作成したDemo保有はありません。', 'No Demo positions created by this EA right now.')}</p>}</div>
    <div className="demo-closed-ledger"><div className="section-title"><b>{bilingual('Demo 已平仓记录', 'Demo決済済み記録', 'closed Demo ledger')}</b><span>{t('由 MT4 每秒回传，保留最近 50 笔本 EA 交易；关闭或重开浏览器不会清空。', 'MT4が毎秒送信。直近50件のEA取引を保持し、ブラウザを閉じても消えません。', 'Reported by MT4 every second; keeps the latest 50 trades of this EA and is not cleared by closing or reopening the browser.')}</span></div>{(status?.demo_closed_positions ?? []).slice(0, 12).map((position) => <article key={position.ticket}><b>#{position.ticket} · {position.symbol} · {position.side === 'long' ? t('买入', '買い', 'Buy') : t('卖出', '売り', 'Sell')} {position.lots.toFixed(2)}</b><span>{position.open_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)} → {position.close_price.toFixed(position.symbol.includes('JPY') ? 3 : 5)} · {position.closed_at}</span><strong className={position.profit + position.swap + position.commission >= 0 ? 'positive' : 'negative'}>{(position.profit + position.swap + position.commission).toFixed(2)}</strong></article>)}{!(status?.demo_closed_positions?.length) && <p className="empty-state">{t('暂无由本 EA 回传的已平仓记录。完成一次平仓后会在此保留。', 'このEAから送信された決済済み記録はまだありません。決済後にここへ保持されます。', 'No closed records reported by this EA yet. Records are kept here after each close.')}</p>}</div>
    <div className="demo-tick-chart"><div><b>{bilingual('秒级报价轨迹', '秒次レート推移', 'one-second quote trace')}</b><small>{ticks.length ? t(`当前浏览器已采样 ${ticks.length} 个秒级报价点；离开页面不会作为历史保存。`, `このブラウザで ${ticks.length} 件の秒次レートを取得済み。画面を離れると履歴として保存されません。`, `This browser has sampled ${ticks.length} per-second quote points; leaving the page does not keep them as history.`) : t('等待 MT4 秒级报价。', 'MT4の秒次レートを待機中です。', 'Waiting for MT4 per-second quotes.')}</small></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={t('秒级报价图', '秒次レート図', 'Per-second quote chart')}><polyline points={tickPolyline} /></svg><span>{tickRange.low.toFixed(decimals)} — {tickRange.high.toFixed(decimals)}</span></div>
    <details className="demo-audit"><summary className="section-title"><b>{bilingual('执行审计回执', '実行監査レシート', 'execution audit')}</b><span>{t(`已压缩 ${auditRows.length} 类事件；展开查看最近 8 条`, `${auditRows.length}種類のイベントを圧縮。展開して直近8件を表示`, `${auditRows.length} event types compressed; expand for latest 8`)}</span></summary>{auditRows.slice(0, 8).map((row, index) => <article key={`${row.join('-')}-${index}`}><time>{row[0] ?? '—'}</time><b>{auditEvent(row[2] ?? '—')}</b><span>{auditDetail(row[3] ?? '—')}</span></article>)}{auditRows.length === 0 && <p className="empty-state">{t('尚无执行回执。未启动确认服务或未创建指令时不会产生记录。', '実行レシートはまだありません。確認サービス未起動または未作成時は記録されません。', 'No execution receipts yet. Records appear only after the confirmation service runs and orders are created.')}</p>}</details>
    <div className="demo-execution-rules"><article><p className="eyebrow">FAIL-CLOSED</p><b>{t('任一异常都拒绝执行', '異常時はすべて実行拒否', 'Any anomaly rejects execution')}</b><span>{t('非 Demo 账户、急停、过期、点差过大、止损/目标无效、已有仓位或未连接都会拒绝指令。', 'Demo以外、緊急停止、期限切れ、スプレッド超過、無効なSL/TP、既存保有、未接続のいずれも指示を拒否します。', 'Non-Demo account, emergency stop, expiry, excessive spread, invalid stop/target, existing positions or no connection all reject the order.')}</span></article><article><p className="eyebrow">MANUAL CONTROL</p><b>{t('没有隐藏自动触发', '隠れた自動起動なし', 'No hidden auto-triggers')}</b><span>{t('网页创建一张指令；MT4 EA 必须由你手动挂载并明确开启 Demo 执行。任何一步缺失都不会下单。', 'Webで一枚の指示を作成し、MT4 EAはあなたが手動で設定してDemo実行を明示的に有効化する必要があります。どちらかが欠ければ注文されません。', 'The web page creates one order; the MT4 EA must be mounted by you manually with Demo execution explicitly enabled. If any step is missing, nothing is sent.')}</span></article><article><p className="eyebrow">NO LIVE PATH</p><b>{t('实盘路径不存在', '実取引経路は存在しない', 'No live path exists')}</b><span>{t('本模块拒绝非 Demo 服务器；项目没有实盘凭证、实盘接口或实盘订单代码。', 'このモジュールはDemo以外のサーバーを拒否します。実口座認証情報、実口座API、実取引注文コードは含みません。', 'This module rejects non-Demo servers; the project contains no live credentials, live API or live order code.')}</span></article></div>
  </section>;
}
