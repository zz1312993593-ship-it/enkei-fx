'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResearchModel } from '../lib/model-catalog';
import { ERROR_CATALOG } from '../lib/error-catalog';
import { APP_VERSION } from '../lib/app-version';
import { fetchLatestVersion, isNewerVersion, RELEASES_PAGE_URL } from '../lib/version-check';
import type { PairSymbol, RiskConfig, Timeframe } from '../lib/market-data';
import TokenUsagePanel from './token-usage-panel';

type Language = 'zh' | 'ja' | 'en';
type CheckState = 'checking' | 'ready' | 'warning' | 'offline';
interface Check { id: string; label: string; detail: string; state: CheckState; }
interface Backup { version: 1; exportedAt: string; app: 'enkei-local-operations'; preferences: { risk: RiskConfig; symbol: PairSymbol; timeframe: Timeframe; model: ResearchModel }; localRecords: Record<string, string | null>; }
interface RuntimeStatus { services?: { quote_bridge?: boolean; panel?: boolean; demo_gate?: boolean; supervisor?: boolean }; }
interface StartupCheck { status?: string; checkedAt?: string; checks?: Array<{ name?: string; ok?: boolean }>; }

const BACKUP_KEYS = ['enkei-adaptive-research-state', 'enkei-backtest-state', 'enkei-candidate-notes', 'enkei-demo-rehearsals', 'enkei-event-notes', 'enkei-forward-paper-queue', 'enkei-forward-validation-protocol', 'enkei-forward-validation-observations', 'enkei-model-activations', 'enkei-paper-state', 'enkei-research-journal'];

function download(name: string, value: unknown) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }
function loadAudit() { try { return JSON.parse(window.localStorage.getItem('enkei-operations-audit') ?? '[]') as Array<{ time: string; action: string; detail: string }>; } catch { return []; } }

export default function OperationsPanel({ language, risk, symbol, timeframe, model, bridgeLive, historyReady, displayTimeZone = 'Asia/Tokyo', onRestore }: { language: Language; risk: RiskConfig; symbol: PairSymbol; timeframe: Timeframe; model: ResearchModel; bridgeLive: boolean; historyReady: boolean; displayTimeZone?: string; onRestore: (preferences: Backup['preferences']) => void }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [audit, setAudit] = useState(() => typeof window === 'undefined' ? [] : loadAudit());
  const [notice, setNotice] = useState('');
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [startupCheck, setStartupCheck] = useState<StartupCheck | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [newerVersion, setNewerVersion] = useState<string | null>(null);
  useEffect(() => {
    // 轻量新版本提示：失败完全静默，不打扰离线用户。
    let active = true;
    void fetchLatestVersion().then((latest) => {
      if (active && latest && isNewerVersion(latest, APP_VERSION)) setNewerVersion(latest);
    }).catch(() => { /* 静默 */ });
    return () => { active = false; };
  }, []);
  const busyRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastHealthSignature = useRef('');
  const t = useCallback((zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en, [language]);
  const bilingual = useCallback((zh: string, ja: string, english: string) => t(zh, ja, english), [t]);
  const addAudit = useCallback((action: string, detail: string) => {
    setAudit((current) => {
      const next = [{ time: new Date().toISOString(), action, detail }, ...current].slice(0, 80);
      window.localStorage.setItem('enkei-operations-audit', JSON.stringify(next));
      return next;
    });
  }, []);
  const refreshRuntime = useCallback(async () => {
    try {
      const response = await fetch('http://127.0.0.1:8787/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('runtime unavailable');
      setRuntime(await response.json() as RuntimeStatus);
    } catch { setRuntime(null); }
  }, []);
  const runChecks = useCallback(async (showChecking = false) => {
    if (showChecking || checks.length === 0) setChecks([{ id: 'bridge', label: bilingual('行情桥', 'レートブリッジ', 'quote bridge'), detail: t('检查中', '確認中', 'Checking'), state: 'checking' }, { id: 'history', label: bilingual('历史与时钟', '履歴と時刻', 'history & clock'), detail: t('检查中', '確認中', 'Checking'), state: 'checking' }, { id: 'supervisor', label: bilingual('后台研究', 'バックグラウンド研究', 'background supervisor'), detail: t('检查中', '確認中', 'Checking'), state: 'checking' }, { id: 'demo', label: bilingual('Demo 执行确认服务', 'Demo実行確認サービス', 'Demo confirmation'), detail: t('检查中', '確認中', 'Checking'), state: 'checking' }]);
    const probe = async (url: string) => { try { const response = await fetch(url, { cache: 'no-store' }); return response.ok ? await response.json() as Record<string, unknown> : null; } catch { return null; } };
    const [snapshot, supervisor, demo, startup] = await Promise.all([probe('http://127.0.0.1:8788/api/snapshot'), probe('http://127.0.0.1:8788/api/supervisor'), probe('http://127.0.0.1:8790/api/status'), probe('/runtime-self-check.json')]);
    setStartupCheck(startup as StartupCheck | null);
    const next: Check[] = [
      { id: 'bridge', label: bilingual('行情桥', 'レートブリッジ', 'quote bridge'), state: snapshot && Number(snapshot.age_ms) <= 10_000 ? 'ready' : 'offline', detail: snapshot && Number(snapshot.age_ms) <= 10_000 ? bilingual('本机只读报价正常', '端末内読取レートは正常', 'local read-only quote healthy') : bilingual('未检测到新鲜报价', '新鮮なレートを検出できません', 'no fresh quote') },
      { id: 'history', label: bilingual('历史与时钟', '履歴と時刻', 'history & clock'), state: historyReady ? 'ready' : bridgeLive ? 'warning' : 'offline', detail: historyReady ? bilingual('当前周期历史已校准', '現在の時間足履歴は補正済み', 'history clock verified') : bridgeLive ? bilingual('报价在线，历史或时钟尚未合格', 'レートはオンライン、履歴または時刻が未適格', 'history not qualified') : bilingual('等待只读桥恢复', '読取ブリッジの復旧を待機', 'bridge unavailable') },
      { id: 'supervisor', label: bilingual('后台研究', 'バックグラウンド研究', 'background supervisor'), state: supervisor?.status === 'research-watch-ready' ? 'ready' : supervisor ? 'warning' : 'offline', detail: supervisor ? `${bilingual('状态', '状態', 'status')}: ${String(supervisor.status ?? 'waiting')}` : bilingual('后台服务未启动', 'バックグラウンドサービス未起動', 'not running') },
      { id: 'demo', label: bilingual('Demo 执行确认服务', 'Demo実行確認サービス', 'Demo confirmation'), state: demo?.killed === true ? 'ready' : demo ? 'warning' : 'offline', detail: demo?.killed === true ? bilingual('急停保持有效', '緊急停止が有効', 'kill switch engaged') : demo ? bilingual('确认服务可用但未急停', '確認サービスは利用可能ですが緊急停止ではありません', 'confirmation available, not stopped') : bilingual('确认服务未启动；当前安全', '確認サービスは未起動・現在は安全', 'not running, safe') },
      { id: 'startup', label: bilingual('启动自检', '起動セルフチェック', 'startup self-check'), state: startup?.status === 'passed' ? 'ready' : startup ? 'warning' : 'offline', detail: startup?.status === 'passed' ? bilingual('启动组件完整', '起動コンポーネントは正常', 'required components verified') : bilingual('未取得自检结果', 'セルフチェック結果を取得できません', 'no self-check result') },
    ];
    const signature = next.map((item) => `${item.id}:${item.state}:${item.detail}`).join('|');
    if (showChecking || signature !== lastHealthSignature.current) setChecks(next);
    if (signature !== lastHealthSignature.current) { lastHealthSignature.current = signature; addAudit('health-change', next.map((item) => `${item.id}:${item.state}`).join(', ')); setNotice(t('运营状态已更新。', '運用状態を更新しました。', 'Operations status updated.')); }
  }, [addAudit, bilingual, bridgeLive, checks.length, historyReady, t]);
  useEffect(() => {
    const initial = window.setTimeout(() => void runChecks(false), 200);
    const timer = window.setInterval(() => { if (!document.hidden) void runChecks(false); }, 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [runChecks]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refreshRuntime(), 200);
    const timer = window.setInterval(() => { if (!document.hidden) void refreshRuntime(); }, 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshRuntime]);
  const exportBackup = () => { const localRecords = Object.fromEntries(BACKUP_KEYS.map((key) => [key, window.localStorage.getItem(key)])); const backup: Backup = { version: 1, exportedAt: new Date().toISOString(), app: 'enkei-local-operations', preferences: { risk, symbol, timeframe, model }, localRecords }; download(`enkei-operations-backup-${new Date().toISOString().slice(0, 10)}.json`, backup); addAudit('backup-export', `${BACKUP_KEYS.length} local record groups`); setNotice(t('本机配置与研究记录已导出。', '端末設定と研究記録を書き出しました。', 'Local configuration and research records exported.')); };
  const exportDiagnostics = useCallback(async () => {
    // 一键诊断包（脱敏）：只含 服务状态/版本/健康检查结果与操作建议，
    // 不包含 账户、配对码、密钥、行情内容或对话记录。
    const probe = async (url: string) => { try { const response = await fetch(url, { cache: 'no-store' }); return response.ok ? await response.json() as Record<string, unknown> : null; } catch { return null; } };
    const [runtimeFull, terminal, bridge] = await Promise.all([
      probe('http://127.0.0.1:8787/api/status'),
      probe('http://127.0.0.1:8710/health'),
      probe('http://127.0.0.1:8788/api/health'),
    ]);
    const runtimeStatus = runtimeFull as { services?: Record<string, boolean>; ai_terminal?: Record<string, unknown>; safety?: Record<string, unknown> } | null;
    const userActionable: string[] = [];
    const supportNeeded: string[] = [];
    if (!runtimeStatus?.services?.quote_bridge) userActionable.push(t('行情桥未运行：重启圆衡面板。', 'レートブリッジ未起動：円衡パネルを再起動。', 'Quote bridge down: restart the Enkei panel.'));
    if (!runtimeStatus?.services?.ai_terminal && !runtimeStatus?.ai_terminal?.running) userActionable.push(t('AI 终端未运行：在设置页重新启动。', 'AIターミナル未起動：設定画面で再起動。', 'AI terminal down: restart it from Settings.'));
    const bridgeHealth = bridge as { status?: string; quote_count?: number } | null;
    if (!bridgeHealth || bridgeHealth.status !== 'ready') userActionable.push(t('无新鲜报价：确认 MT4 已启动且 EA 挂载。', '新鮮なレートなし：MT4とEAの装着を確認。', 'No fresh quote: confirm MT4 is running with the EA attached.'));
    const health = terminal as { gateway?: { is_librechat_ready?: boolean; mode?: string }; routing?: Record<string, unknown> } | null;
    if (health?.gateway && health.gateway.is_librechat_ready === false) userActionable.push(t('统一分析体未配置：在“模型与 API”页完成接入。', '統合分析体未設定：「モデル/API」で設定。', 'Unified analysis not configured: finish setup in Models & API.'));
    if (checks.some((item) => item.state === 'offline' && item.id === 'startup')) supportNeeded.push(t('启动自检失败：附带本诊断包联系技术支持。', '起動セルフチェック失敗：本診断を添えてサポートへ。', 'Startup self-check failed: contact support with this bundle.'));
    if (userActionable.length === 0 && supportNeeded.length === 0) userActionable.push(t('一切正常，无需处理。', 'すべて正常です。', 'Everything looks normal; nothing to do.'));
    const bundle = {
      generatedAt: new Date().toISOString(),
      kind: 'enkei-diagnostics/1',
      masked: true,
      contains: 'service status, health results and guidance only — no accounts, pairing codes, secrets, quotes or chat records',
      app: { version: '1.8.x', language },
      services: runtimeStatus?.services ?? null,
      ai_terminal: runtimeStatus?.ai_terminal ? { running: runtimeStatus.ai_terminal.running, port: runtimeStatus.ai_terminal.port, auto_start: runtimeStatus.ai_terminal.auto_start, last_start_error: runtimeStatus.ai_terminal.last_start_error ?? null } : null,
      safety: runtimeStatus?.safety ?? null,
      terminal_gateway: health?.gateway ? { is_librechat_ready: health.gateway.is_librechat_ready, mode: health.gateway.mode } : null,
      bridge: bridgeHealth ? { status: bridgeHealth.status, quote_count: bridgeHealth.quote_count } : null,
      checks,
      guidance: { user_actionable: userActionable, support_needed: supportNeeded },
    };
    download(`enkei-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, bundle);
    addAudit('diagnostics-export', `user:${userActionable.length} support:${supportNeeded.length}`);
    setNotice(t('诊断包已导出（已脱敏）。', '診断パッケージを書き出しました（マスク済み）。', 'Diagnostics bundle exported (masked).'));
  }, [addAudit, checks, language, t]);
  const exportAudit = () => { download(`enkei-operations-audit-${new Date().toISOString().slice(0, 10)}.json`, { generatedAt: new Date().toISOString(), checks, audit, safety: { controlledLivePath: true, liveLockedByDefault: true, explicitDualArmingRequired: true, noCredentialStorage: true, failClosed: true } }); addAudit('audit-export', 'operations audit exported'); };
  const restore = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Backup>;
      if (parsed.version !== 1 || parsed.app !== 'enkei-local-operations' || !parsed.preferences || !parsed.localRecords) throw new Error('invalid backup');
      Object.entries(parsed.localRecords).forEach(([key, value]) => { if (BACKUP_KEYS.includes(key) && typeof value === 'string') window.localStorage.setItem(key, value); });
      window.localStorage.setItem('enkei-risk-config', JSON.stringify({ ...parsed.preferences.risk, requireStopLoss: true })); onRestore({ ...parsed.preferences, risk: { ...parsed.preferences.risk, requireStopLoss: true } }); addAudit('backup-restore', `backup from ${parsed.exportedAt ?? 'unknown'}`); setNotice(t('备份已恢复；当前页面已同步核心设置。', 'バックアップを復元し、現在の画面に主要設定を反映しました。', 'Backup restored; this page has synced the core settings.'));
    } catch { setNotice(t('备份格式不正确，未写入任何设置。', 'バックアップ形式が正しくないため、設定は変更されませんでした。', 'The backup format is invalid; no settings were written.')); }
  };
  // 防抖：同一动作在等待完成期间禁止重复触发，避免按钮连点造成重复请求。
  const runGuarded = (action: string, fn: () => Promise<void> | void) => {
    if (busyRef.current) return;
    busyRef.current = action;
    setBusyAction(action);
    const finish = () => { busyRef.current = null; setBusyAction(null); };
    try {
      const result = fn();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).finally(finish);
      } else {
        finish();
      }
    } catch {
      finish();
    }
  };
  const startDemoGate = async () => {
    if (!window.confirm(t('现在启动“Demo 执行确认服务”吗？它会保持急停，仍不会下单。', 'Demo実行確認サービスを起動しますか？ 緊急停止のままで、注文は出ません。', 'Start the “Demo execution confirmation service” now? It stays emergency-stopped and still places no orders.'))) return;
    try {
      const response = await fetch('http://127.0.0.1:8787/api/demo/start', { method: 'POST' });
      const payload = await response.json() as { pairing_code?: string; error?: string };
      if (!response.ok || !payload.pairing_code) throw new Error(payload.error ?? 'Demo gate unavailable');
      // Shared key: the Demo panels can use this pairing code without asking
      // the user to re-enter it during the same browser session. It is still
      // deliberately unverified until the user clicks verify in Demo.
      window.sessionStorage.setItem('enkei-demo-gate-pairing-code', payload.pairing_code);
      window.sessionStorage.removeItem('enkei-demo-gate-pairing-verified');
      addAudit('demo-gate-start', 'local Demo gate started in locked state');
      setNotice(t('Demo 执行确认服务已在“急停中”启动。配对码仅被保存为“已输入”；进入模拟验收页后仍须点击“验证并连接”，之后才能解除急停。', 'Demo実行確認サービスを緊急停止状態で起動しました。コードは「入力済み」に過ぎず、Demo検収で「検証して接続」を押してから緊急停止を解除できます。', 'The Demo execution confirmation service started in the emergency-stopped state. The pairing code is saved as “entered” only; on the Demo acceptance page you must still click “Verify & connect” before the emergency stop can be released.'));
      await refreshRuntime();
    } catch (error) { setNotice(error instanceof Error ? error.message : t('Demo 执行确认服务未能启动。', 'Demo実行確認サービスを起動できませんでした。', 'The Demo execution confirmation service could not start.')); }
  };
  const checkIcon = (state: CheckState) => state === 'ready' ? '✓' : state === 'warning' ? '!' : state === 'checking' ? '…' : '×';
  const auditAction = (action: string) => {
    const labels: Record<string, [string, string, string]> = {
      'health-change': ['运行状态更新', '稼働状態を更新', 'Runtime status updated'],
      'backup-export': ['导出本机备份', '端末バックアップを書き出し', 'Local backup exported'],
      'backup-restore': ['恢复本机备份', '端末バックアップを復元', 'Local backup restored'],
      'audit-export': ['导出运行审计', '運用監査を書き出し', 'Operations audit exported'],
      'demo-gate-start': ['启动 Demo 确认服务', 'Demo確認サービスを起動', 'Demo confirmation started'],
    };
    const label = labels[action];
    return label ? t(...label) : action;
  };
  const auditDetail = (detail: string) => {
    if (detail === 'operations audit exported') return bilingual('运营审计已导出', '運用監査を書き出しました', 'Operations audit exported');
    const groups = detail.match(/^(\d+) local record groups$/);
    if (groups) return bilingual(`已导出 ${groups[1]} 组本机记录`, `${groups[1]}件の端末記録を書き出しました`, `${groups[1]} local record groups exported`);
    const backup = detail.match(/^backup from (.+)$/);
    if (backup) return bilingual(`备份时间：${backup[1]}`, `バックアップ日時：${backup[1]}`, `Backup time: ${backup[1]}`);
    if (detail === 'local Demo gate started in locked state') return bilingual('本机 Demo 确认服务已启动，保持急停', '端末Demo確認サービスを起動、緊急停止を維持', 'Local Demo confirmation started in locked state');
    return detail;
  };
  const date = (value: string) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  const startSteps = useMemo(() => [
    { done: bridgeLive, text: bilingual('启动只读行情桥', '読取専用レートブリッジを起動', 'start quote bridge') },
    { done: historyReady, text: bilingual('确认当前周期历史和时钟已校准', '現在の時間足履歴と時刻補正を確認', 'verify history & clock') },
    { done: checks.find((item) => item.id === 'supervisor')?.state === 'ready', text: bilingual('启动后台研究服务', 'バックグラウンド研究サービスを起動', 'start supervisor') },
    { done: startupCheck?.status === 'passed', text: bilingual('启动自检通过', '起動セルフチェック合格', 'startup self-check passed') },
    { done: checks.find((item) => item.id === 'demo')?.state === 'ready' || checks.find((item) => item.id === 'demo')?.state === 'offline', text: bilingual('保持 Demo 确认服务急停或未启动', 'Demo確認サービスを緊急停止または未起動に保つ', 'keep Demo confirmation stopped') },
  ], [bilingual, bridgeLive, checks, historyReady, startupCheck?.status]);

  return <section className="phase-panel operations-panel">
    <TokenUsagePanel language={language} />
    <div className="operations-checks">{checks.map((item) => <article className={item.state} key={item.id}><span>{checkIcon(item.state)}</span><div><b>{item.label}</b><small>{item.detail}</small></div></article>)}</div>
    {newerVersion && <p className="update-banner"><b>{bilingual(`新版本 v${newerVersion} 已发布`, `新バージョン v${newerVersion} が公開されました`, `New version v${newerVersion} is available`)}</b><a href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer noopener">{bilingual('查看发布页（本程序不会自动更新）', 'リリースページ（自動更新はしません）', 'Open the release page (this app never auto-updates)')}</a></p>}
    <div className="operations-actions"><button disabled={busyAction !== null} onClick={() => runGuarded('check', () => runChecks(true))}>{busyAction === 'check' ? bilingual('检查中…', '確認中…', 'checking…') : bilingual('重新运行健康检查', 'ヘルスチェックを再実行', 'run health check')}</button><button disabled={busyAction !== null} onClick={() => runGuarded('runtime', refreshRuntime)}>{bilingual(`本机服务：${runtime?.services?.panel ? '在线' : '检查中'}`, `端末サービス：${runtime?.services?.panel ? 'オンライン' : '確認中'}`, 'local services')}</button><button disabled={busyAction !== null} onClick={() => runGuarded('demogate', startDemoGate)}>{busyAction === 'demogate' ? bilingual('启动中…', '起動中…', 'starting…') : bilingual('启动 Demo 确认服务（待验证连接）', 'Demo確認サービスを起動（接続検証待ち）', 'start service')}</button><button className="operations-help" onClick={() => setShowGuide((value) => !value)}>{showGuide ? bilingual('收起内置说明', '内蔵ガイドを閉じる', 'close guide') : bilingual('查看内置说明与错误代码', '内蔵ガイド・エラーコードを見る', 'view guide')}</button><button className="operations-help" onClick={() => window.open('/Usage-Guide.html', '_blank', 'noopener,noreferrer')}>{bilingual('在新页面打开完整说明书', '完全ガイドを別画面で開く', 'open full guide')}</button><button disabled={busyAction !== null} onClick={() => { void exportDiagnostics(); }}>{bilingual('导出一键诊断包（脱敏）', 'ワンクリック診断を書き出す（マスク済み）', 'export diagnostics bundle (masked)')}</button><button disabled={busyAction !== null} onClick={() => runGuarded('backup', exportBackup)}>{bilingual('导出配置与研究备份', '設定と研究バックアップを書き出す', 'export backup')}</button><button disabled={busyAction !== null} onClick={() => inputRef.current?.click()}>{bilingual('恢复本机备份', '端末バックアップを復元', 'restore backup')}</button><button disabled={busyAction !== null} onClick={() => runGuarded('audit', exportAudit)}>{bilingual('导出运行审计', '運用監査を書き出す', 'export audit')}</button><input ref={inputRef} type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void restore(file); event.currentTarget.value = ''; }} /></div>
    {showGuide && <section className="operations-guide"><b>{bilingual('应用说明与错误代码', '使い方・エラーコード', 'guide & error codes')}</b><div><article><strong>{bilingual('日常启动', '日常起動', 'daily startup')}</strong><span>{t('点击启动面板后，先看“启动自检”为通过；行情桥、历史时钟和后台研究合格后，才进入 Demo。', 'パネル起動後、「起動セルフチェック」が合格であることを確認し、レート・履歴時刻・研究が合格後にDemoへ進みます。', 'After starting the panel, first confirm “Startup self-check” passes; enter Demo only after the quote bridge, history clock and background research are qualified.')}</span></article><article><strong>{bilingual('Demo 演练', 'Demo 演習', 'Demo rehearsal')}</strong><span>{t('先启动服务、验证连接、解除急停，再在同一处设置模型和多仓位参数并启用。非人工断线会尝试恢复；人工急停绝不会自动解除。', 'サービス起動、接続検証、緊急停止解除後、同じ画面でモデルと複数ポジション設定を有効化します。非手動の切断は復旧を試みますが、手動緊急停止は自動解除しません。', 'Start the service, verify the connection and release the emergency stop, then set model and multi-position parameters and enable them in the same place. Non-manual disconnections attempt recovery; a manual emergency stop is never auto-released.')}</span></article></div>
      <div className="error-catalog">
        <strong>{bilingual('错误代码 · 原因与处理', 'エラーコード・原因と対処', 'Error codes · cause & fix')}</strong>
        <small>{t('标“支持”的条目建议附“一键诊断包”联系技术支持；其余可自行处理。', '「サポート」表示の項目は診断パッケージを添えて連絡してください。それ以外は自分で対処できます。', 'Items marked “support” should be reported with a diagnostics bundle; the rest you can fix yourself.')}</small>
        {ERROR_CATALOG.map((entry) => <article key={entry.code} className={`error-entry owner-${entry.owner}`}>
          <strong>{entry.code} · {entry.title[language]}</strong>
          <span><b>{t('原因', '原因', 'Cause')}:</b> {entry.cause[language]}</span>
          <span><b>{t('处理', '対処', 'Fix')}:</b> {entry.fix[language]}</span>
          {entry.owner === 'support' && <em>{t('需技术支持', 'サポート必要', 'support needed')}</em>}
        </article>)}
      </div>
    </section>}
    {notice && <p className="operations-notice">{notice}</p>}
    <div className="operations-grid"><article><p className="eyebrow">{bilingual('启动清单', '起動チェックリスト', 'startup checklist')}</p>{startSteps.map((item) => <div className={item.done ? 'done' : ''} key={item.text}><span>{item.done ? '✓' : '○'}</span>{item.text}</div>)}</article><article><p className="eyebrow">{bilingual('当前保护参数', '現在の保護パラメーター', 'current safeguards')}</p><div className="operations-metrics"><span>{bilingual('单笔风险', '1取引リスク', 'risk')} <b>{risk.riskPerTradePct.toFixed(2)}%</b></span><span>{bilingual('日内上限', '日次上限', 'daily limit')} <b>{risk.dailyLossLimitPct.toFixed(2)}%</b></span><span>{bilingual('最大持仓', '最大保有数', 'max positions')} <b>{risk.maxOpenPositions}</b></span><span>{bilingual('最大点差', '最大スプレッド', 'max spread')} <b>{risk.maxSpreadPips.toFixed(1)} pips</b></span></div></article><article><p className="eyebrow">{bilingual('恢复范围', '復元対象', 'restore scope')}</p><b>{t('研究与配置记录', '研究・設定記録', 'Research & configuration records')}</b><small>{t('恢复风险、当前货币对/周期/模型，以及本机回测、前向、日志和演练记录。不会恢复配对码、账户信息或任何订单。', 'リスク、現在の通貨ペア・時間足・モデル、および端末内の検証・前向き・ログ・演習記録を復元します。ペアリングコード、口座情報、注文は復元しません。', 'Restores risk, the current pair/timeframe/model and local backtest, forward, journal and practice records. Pairing codes, account information and orders are never restored.')}</small></article></div>
    <div className="operations-audit"><div className="section-title"><b>{bilingual('运营审计记录', '運用監査記録', 'operations audit log')}</b><span>{bilingual('仅保存在本机浏览器', '端末ブラウザ内のみ保存', 'local browser only')}</span></div>{audit.slice(0, 12).map((item, index) => <article key={`${item.time}-${index}`}><time>{date(item.time)}</time><b>{auditAction(item.action)}</b><span>{auditDetail(item.detail)}</span></article>)}{audit.length === 0 && <p className="empty-state">{bilingual('尚无运营操作记录', '運用操作の記録はまだありません', 'no operations records')}</p>}</div>
  </section>;
}
