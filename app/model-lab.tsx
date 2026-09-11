'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RESEARCH_MODELS, modelDefinition, modelLogic, modelName, modelRegime, modelShort, type ResearchModel } from '../lib/model-catalog';
import { buildResearchSignal } from '../lib/research-signal';
import type { OhlcBar, PairSymbol, Timeframe } from '../lib/market-data';

type Language = 'zh' | 'ja' | 'en';

interface ModelActivation {
  id: string;
  model: ResearchModel;
  time: string;
  symbol: PairSymbol;
  timeframe: Timeframe;
}

function loadActivations() {
  if (typeof window === 'undefined') return [] as ModelActivation[];
  try { return JSON.parse(window.localStorage.getItem('enkei-model-activations') ?? '[]') as ModelActivation[]; } catch { return []; }
}

export default function ModelLab({ language, model, onModelChange, bars, symbol, timeframe, sourceReady, displayTimeZone = 'Asia/Tokyo', autonomous }: { language: Language; model: ResearchModel; onModelChange: (model: ResearchModel) => void; bars: OhlcBar[]; symbol: PairSymbol; timeframe: Timeframe; sourceReady: boolean; displayTimeZone?: string; autonomous?: { enabled: boolean; selectedModel: ResearchModel; rows: Array<{ tf: string; modelName: string }> } }) {
  const [activations, setActivations] = useState<ModelActivation[]>(loadActivations);
  const [strategyEnabled, setStrategyEnabled] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('enkei-observation-strategy-enabled') === '1');
  const [pendingModel, setPendingModel] = useState<ResearchModel | null>(null);
  // 批B：真实路由控制（GET/PUT /v1/routing，写 providers.json 热生效）
  const [routingDraft, setRoutingDraft] = useState<{
    M5: { provider: string; model_role: string };
    M15: { provider: string; model_role: string };
    models: Record<string, { fast?: string; deep?: string }>;
  } | null>(null);
  const [routingModels, setRoutingModels] = useState<Record<string, { fast?: string; deep?: string }>>({});
  const [routingProviders, setRoutingProviders] = useState<string[]>([]);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [routingNotice, setRoutingNotice] = useState('');
  const terminalBase = 'http://127.0.0.1:8710';
  const switchTimer = useRef<number | null>(null);
  const t = useCallback((zh: string, ja: string, en = zh) => language === 'zh' ? zh : language === 'ja' ? ja : en, [language]);
  const effectiveModel = pendingModel ?? model;
  const selected = modelDefinition(effectiveModel);
  const signals = useMemo(() => RESEARCH_MODELS.map((candidate) => ({ candidate, signal: buildResearchSignal(bars, symbol, timeframe, candidate.id) })), [bars, symbol, timeframe]);
  const signal = signals.find((item) => item.candidate.id === effectiveModel)?.signal ?? signals[0]?.signal;

  useEffect(() => { window.localStorage.setItem('enkei-model-activations', JSON.stringify(activations)); }, [activations]);
  useEffect(() => { window.localStorage.setItem('enkei-observation-strategy-enabled', strategyEnabled ? '1' : '0'); }, [strategyEnabled]);
  useEffect(() => () => { if (switchTimer.current !== null) window.clearTimeout(switchTimer.current); }, []);

  const loadRouting = useCallback(async () => {
    try {
      const response = await fetch(`${terminalBase}/v1/routing`, { cache: 'no-store' });
      if (!response.ok) { setRoutingNotice(t('终端未就绪', 'ターミナル未準備', 'terminal not ready')); return; }
      const data = await response.json() as { routing?: Record<string, { provider: string; model_role: string }>; models?: Record<string, { fast?: string; deep?: string }>; providers?: string[] };
      setRoutingDraft({
        M5: data.routing?.M5 ?? { provider: 'ollama', model_role: 'fast' },
        M15: data.routing?.M15 ?? { provider: 'ollama', model_role: 'deep' },
        models: data.models ?? {},
      });
      setRoutingModels(data.models ?? {});
      setRoutingProviders(data.providers ?? []);
      setRoutingNotice(t('已加载当前路由', '現在のルートを読込済み', 'current routing loaded'));
    } catch { setRoutingNotice(t('无法连接 AI 终端', 'AIターミナルに接続できません', 'cannot reach AI terminal')); }
  }, [t]);
  const saveRouting = async () => {
    const draft = routingDraft;
    if (!draft) return;
    setRoutingBusy(true);
    try {
      const response = await fetch(`${terminalBase}/v1/routing`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routing: { M5: draft.M5, M15: draft.M15 }, models: draft.models }),
      });
      const data = await response.json().catch(() => ({})) as { routing?: Record<string, { provider: string }>; detail?: unknown };
      if (!response.ok) {
        setRoutingNotice(`${t('保存被拒', '保存拒否', 'rejected')}: ${String(data.detail ?? response.status).slice(0, 80)}`);
      } else {
        setRoutingModels(draft.models);
        setRoutingNotice(t('已保存 · 调度器热生效', '保存・ホット反映済み', 'saved · hot-applied'));
      }
    } catch { setRoutingNotice(t('无法连接 AI 终端', 'AIターミナルに接続できません', 'cannot reach AI terminal')); }
    setRoutingBusy(false);
  };
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRouting(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRouting]);

  const selectModel = (next: ResearchModel) => {
    setStrategyEnabled(true);
    setPendingModel(next);
    if (switchTimer.current !== null) window.clearTimeout(switchTimer.current);
    switchTimer.current = window.setTimeout(() => {
      onModelChange(next);
      setActivations((current) => [{ id: `model-${Date.now()}`, model: next, time: new Date().toISOString(), symbol, timeframe }, ...current].slice(0, 24));
      setPendingModel(null);
      switchTimer.current = null;
    }, 180);
  };
  const direction = (value: 'long' | 'short' | 'wait') => value === 'long' ? t('偏多观察', '買い観測', 'Long-leaning observation') : value === 'short' ? t('偏空观察', '売り観測', 'Short-leaning observation') : t('观望', '待機', 'Standby');
  const directionClass = signal?.direction === 'long' ? 'positive' : signal?.direction === 'short' ? 'negative' : '';

  return <section className="phase-panel model-lab">
    <div className="phase-heading">
      <div><p className="eyebrow">MODEL WINDOW · LOCAL STRATEGY FABRIC</p><h3>{t('模型窗口', 'モデル・ウィンドウ', 'Model window')} <span>{t('可解释策略库', '説明可能な戦略ライブラリ', 'Explainable strategy library')}</span></h3></div>
      <span className="model-local-chip">{t('本机计算 · 不调用外部 AI', '端末内計算・外部AI不使用', 'Local computation · no external AI calls')}</span>
    </div>
    <div className="model-safety"><span>◈</span><p><b>{t('这是一组可解释、可回测的策略模型，不是假装会预测市场的黑箱。', 'これは説明可能で検証可能な戦略モデル群であり、市場予測を装うブラックボックスではありません。', 'These are explainable, backtestable strategy models, not black boxes pretending to predict the market.')}</b><small>{t('像选择显卡中的计算配置一样选择模型：一次只激活一个观察模型；它只改变研究信号，不会下单。', 'GPUの計算構成を選ぶようにモデルを選択します。一度に有効化する観測モデルは1つだけで、研究シグナルだけを変更し、注文は出しません。', 'Choose models like picking a compute profile on a GPU: only one observation model is active at a time; it changes the research signal only and places no orders.')}</small></p></div>
    {autonomous && <div className="autonomous-lead"><span className={`autonomous-dot ${autonomous.enabled ? 'on' : ''}`} /><p><b>{autonomous.enabled ? t('自主选择引擎运行中', '自律選択エンジン実行中', 'Autonomous selection engine running') : t('自主选择引擎已暂停', '自律選択エンジンは一時停止中', 'Autonomous selection engine paused')}</b><span>{t('量化 AI 按市场状态在各周期自动切换模型：', '量化AIが市場状態に応じて各時間足のモデルを自動切替：', 'The quant AI switches models per timeframe as markets change:')} {autonomous.rows.length ? autonomous.rows.map((row) => `${row.tf} → ${row.modelName}`).join(' · ') : t('等待首次评估', '初回評価待ち', 'awaiting first evaluation')}</span><small>{t('当前窗口选择仅供观察对照，不会改写自主执行。详见 研究 → 自适应研究。', 'この画面の選択は観察専用で自律実行を変更しません。詳細は 研究→適応研究。', 'The selection here is for observation only and never overrides autonomous execution. See Research → Adaptive research.')}</small></p></div>}

    <details className="advisor-pool">
      <summary><span>{t('AI 模型路由（真实生效 · 直连/降级路线）', 'AIモデルルーティング（実効・直結/フォールバック経路）', 'AI model routing (live · direct/fallback route)')}</span><b>{routingNotice || t('已连接 · 保存即热生效', '接続済・保存でホット反映', 'connected · save hot-applies')}</b><small>{t('写入本机私有配置并热生效；密钥不在此管理、不入日志', '端末内の非公開設定に書き込み即時反映。キーは管理しません', 'Writes local private config and hot-reloads; keys are not managed here')}</small></summary>
      <div className="advisor-pool-body">
        <p>{t('统一分析体（LibreChat Agent）启用时为主链路；此处控制的是其不可用时的直连/降级路线（写 providers.json，调度器每任务热重载）。API Key 在终端私有配置中管理，不在此处。', '統合分析体（LibreChat Agent）が主経路。ここは利用不可時の直結/フォールバック経路を制御します（providers.jsonに書き込み、タスク毎にホットリロード）。', 'The LibreChat Agent is the primary route; this controls the direct/fallback route used when it is unavailable (writes providers.json, hot-reloaded per task). API keys are managed in the terminal private config.')}</p>
        <div className="routing-grid">
          {(!routingDraft ? <p className="cc-empty">{t('读取路由中…', 'ルート読込中…', 'loading routing…')}</p> : ([['M5', t('快速研究（M5）', '高速リサーチ（M5）', 'Fast research (M5)')], ['M15', t('深度复盘（M15）', '深い振り返り（M15）', 'Deep review (M15)')]] as const).map(([tf, label]) => {
            const entry = routingDraft[tf];
            const roleModels = routingModels[entry.provider] ?? {};
            const roleModel = entry.model_role === 'deep' ? (roleModels.deep ?? '') : (roleModels.fast ?? '');
            return (
              <div key={tf} className="routing-card">
                <b>{label}</b>
                <label><span>{t('提供方', 'プロバイダー', 'Provider')}</span>
                  <select value={entry.provider} onChange={(event) => setRoutingDraft((current) => current && ({ ...current, [tf]: { provider: event.target.value, model_role: entry.model_role } }))}>
                    {routingProviders.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label><span>{entry.model_role === 'deep' ? t('深度模型名', '深度モデル名', 'Deep model') : t('快速模型名', '高速モデル名', 'Fast model')}</span>
                  <input value={roleModel} placeholder={t('留空则用该提供方默认', '空欄で既定値', 'blank = provider default')} onChange={(event) => setRoutingDraft((current) => current && ({
                    ...current,
                    models: { ...current.models, [entry.provider]: { ...current.models[entry.provider], [entry.model_role]: event.target.value } },
                  }))} />
                </label>
              </div>
            );
          }))}
        </div>
        <div className="routing-actions">
          <button className="primary-btn" disabled={routingBusy || !routingDraft} onClick={() => void saveRouting()}>{routingBusy ? t('保存中…', '保存中…', 'saving…') : t('保存并热生效', '保存してホット反映', 'Save & hot-apply')}</button>
          <span>{routingNotice}</span>
        </div>
      </div>
    </details>

    <div className="model-console">
      <div className={`model-selected color-${selected.color}`}>
        <span>{strategyEnabled ? t('当前活动模型', '現在の有効モデル', 'Current active model') : t('策略尚未启用', 'ストラテジー未有効', 'Strategy not enabled')}</span><strong>{modelName(selected, language)}</strong><small>v{selected.version} · {symbol} · {timeframe}</small>
        <div><b className={directionClass}>{signal ? direction(signal.direction) : '—'}</b><span>{t('信号强度', 'シグナル強度', 'Signal strength')} {signal?.score ?? 0}</span></div>
      </div>
      <div className="model-pipeline"><p><span>①</span>{t('完成K线', '確定足', 'Completed candles')}</p><i /> <p><span>②</span>{t('模型计算', 'モデル計算', 'Model computation')}</p><i /> <p><span>③</span>{t('研究信号', '研究シグナル', 'Research signal')}</p><i /> <p><span>④</span>{t('人工判断', '人の判断', 'Human judgement')}</p></div>
      <div className="model-runtime"><span>{t('数据源', 'データソース', 'Data source')}</span><b>{sourceReady ? t('MT4 本机历史', 'MT4端末内履歴', 'MT4 local history') : t('演示 / 等待校准', 'デモ / 補正待ち', 'Demo / awaiting calibration')}</b><small>{t('不会上传K线或调用云端模型', 'ローソク足の送信やクラウドモデル呼出しは行いません', 'Never uploads candles or calls cloud models')}</small></div>
    </div>

    <div className="model-grid">
      {signals.map(({ candidate, signal: candidateSignal }) => <article className={`model-card color-${candidate.color} ${candidate.id === effectiveModel ? 'active' : ''}`} key={candidate.id}>
        <div><span>v{candidate.version}</span><b>{candidate.id === effectiveModel ? t('运行中', '稼働中', 'Running') : t('可调用', '選択可能', 'Selectable')}</b></div>
        <h4>{modelName(candidate, language)}</h4>
        <p>{modelLogic(candidate, language)}</p>
        <small>{t('适用行情', '適した相場', 'Suitable markets')}: {modelRegime(candidate, language)}</small>
        <footer><span className={candidateSignal.direction === 'long' ? 'positive' : candidateSignal.direction === 'short' ? 'negative' : ''}>{direction(candidateSignal.direction)}</span><b>{candidateSignal.score}</b></footer>
        <button onClick={() => selectModel(candidate.id)} disabled={strategyEnabled && candidate.id === effectiveModel}>{strategyEnabled && candidate.id === effectiveModel ? t('当前模型', '現在のモデル', 'Current model') : t('启用此策略', 'このストラテジーを有効化', 'Enable this strategy')}</button>
      </article>)}
    </div>

    {strategyEnabled && <button className="secondary-btn" onClick={() => setStrategyEnabled(false)}>{t('停用当前观察策略', '現在の観察ストラテジーを無効化', 'Disable current observation strategy')}</button>}

    <div className="model-lab-bottom">
      <article><p className="eyebrow">MODEL PARAMETERS</p><b>{t('参数控制在哪里？', 'パラメーターの操作', 'Where are the parameter controls?')}</b><span>{t('每个模型的风险谱与细节参数在“回测”页统一调节；这里不暗中改变参数。', '各モデルのリスクスペクトラムと詳細パラメーターは「検証」ページで統一して調整します。ここでパラメーターを裏で変更しません。', 'Each model\'s risk spectrum and detail parameters are adjusted on the Backtest page; nothing is changed behind your back here.')}</span></article>
      <article><p className="eyebrow">ACTIVATION AUDIT</p><b>{t('最近模型切换', '直近のモデル切替', 'Latest model switch')}</b><span>{activations[0] ? `${modelShort(modelDefinition(activations[0].model), language)} · ${new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(activations[0].time))}` : t('尚未切换模型', 'モデル切替はまだありません', 'No model switch yet')}</span></article>
      <article><p className="eyebrow">SAFETY STATUS</p><b>{t('研究模式锁定', '研究モード固定', 'Research mode locked')}</b><span>{t('模型输出只能进入看板、回测、内部模拟与日志。', 'モデル出力はダッシュボード、検証、内部ペーパー、ログにのみ使用されます。', 'Model output can only enter the dashboard, backtests, internal simulation and the journal.')}</span></article>
    </div>
  </section>;
}
