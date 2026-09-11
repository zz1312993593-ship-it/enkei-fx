'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeAiTerminalUrl, resolveAiTerminalUrl, saveAiTerminalUrl } from '../lib/ai-terminal';
import TokenUsagePanel from './token-usage-panel';

type Language = 'zh' | 'ja' | 'en';

type ControllerStatus = {
  services?: { ai_terminal?: boolean };
  ai_terminal?: { endpoint?: string; port?: number; running?: boolean; auto_start?: boolean; last_start_error?: string | null };
  librechat?: { ready?: boolean; status?: string; endpoint?: string; detail?: string };
  safety?: Record<string, unknown>;
};

type TerminalHealth = {
  service?: string;
  version?: string;
  ollama?: { ok?: boolean; available?: boolean; version?: string; models?: string[] };
  gateway?: { configured?: boolean; available?: boolean; label?: string; agents?: number; last_error?: string | null; librechat_ready?: boolean; local_fallback_enabled?: boolean; m5_agent?: string; m15_agent?: string; degraded?: string; last_probe_detail?: string; primary_execution?: string };
  routing?: Record<string, { provider?: string; model_role?: string }>;
  news?: { enabled?: boolean; last_refresh?: string | null; last_error?: string | null; total?: number };
  jobs?: { active?: number; total?: number };
  policies?: number;
};

type NewsItem = { source?: string; title?: string; display_title?: string; reason?: string; importance?: string; body?: string; link?: string; published?: string; created_at?: string; translation_status?: 'original' | 'pending' | 'translated'; translation_error?: string | null; failure_reason?: string | null };
type NewsSourceStatus = { name?: string; url?: string; ok?: boolean; last_refresh?: string | null; last_error?: string | null; last_count?: number };
type NewsBrief = { summary?: string; importance?: string; items?: NewsItem[]; source?: string; mode?: string; language?: Language; error?: string };
type NewsList = { enabled?: boolean; auto_sources?: string[]; sources?: NewsSourceStatus[]; last_refresh?: string | null; last_error?: string | null; total?: number; cache_age_seconds?: number; cache_expired?: boolean; items?: NewsItem[]; brief?: NewsBrief };

type Policy = {
  symbol?: string;
  timeframe?: string;
  action_bias?: 'long' | 'short' | 'wait' | 'close' | string;
  direction?: string;
  confidence?: number;
  rationale_zh?: string;
  rationale_ja?: string;
  rationale_en?: string;
  model_id?: string;
  provider?: string;
  created_at?: string;
  expires_at?: string;
  reason?: string;
};
type AnalysisTrace = {
  request_id?: string;
  created_at?: string;
  finished_at?: string;
  status?: 'submitted' | 'succeeded' | 'failed' | 'invalid' | 'rejected' | string;
  transport?: string;
  agent_id?: string | null;
  market_packet?: { symbol?: string; timeframe?: string; language?: Language; generated_at?: string; digest?: string; quote?: { mid?: number; bid?: number; ask?: number; timestamp?: string }; bars?: { count?: number; last_time?: string; last_close?: number } };
  context?: { news_count?: number; news_titles?: string[]; research_context?: boolean; deep_research_context?: boolean; prior_policy_context?: boolean; context_characters?: number };
  result?: { source?: string; model_id?: string; degraded?: string; action_bias?: string; confidence?: number; expires_at?: string; rationale_zh?: string; rationale_ja?: string; rationale_en?: string } | null;
  token_usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
  error?: string | null;
};

type CatalogEntry = {
  id?: string;
  provider?: string;
  model?: string;
  agent_id?: string;
  model_or_agent?: string;
  display_name?: string;
  deployment?: 'cloud' | 'local';
  local?: boolean;
  available?: boolean;
  health_status?: string;
  price_tier?: string;
  compute_tier?: string;
  context_tier?: string;
  json_capable?: boolean;
  recommended_timeframes?: string[];
  last_latency_ms?: number;
};
type KnownProvider = { provider?: string; display_name?: string; cloud?: boolean; available?: boolean; health_status?: string };
type ModelsData = { models?: CatalogEntry[]; available_agents?: CatalogEntry[]; known_providers?: KnownProvider[] };
type GatewayConfig = {
  librechat_base_url: string;
  api_key_set: boolean;
  unified_analysis_enabled: boolean;
  unified_agent_id: string;
  m5_agent_id: string;
  m15_agent_id: string;
  local_fallback_enabled: boolean;
  ollama_base_url: string;
  ollama_fallback_model: string;
  configured: boolean;
};
type GatewayDraft = Omit<GatewayConfig, 'api_key_set' | 'configured'> & { librechat_api_key: string };
type CloudProviderId = 'zhipu' | 'deepseek' | 'qwen' | 'openai' | 'gemini' | 'minimax' | 'groq' | 'openrouter' | 'custom';

const CLOUD_PROVIDERS: Array<{ id: CloudProviderId; label: string; baseUrl: string; models: string[] }> = [
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5-air', 'glm-4.5', 'glm-4.5-flash'] },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', label: '通义千问 / DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'] },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'] },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'] },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash'] },
  { id: 'custom', label: '其他 OpenAI 兼容接口', baseUrl: '', models: [] },
];

const CTRL = 'http://127.0.0.1:8787';
export default function AiTerminalConsole({ language, symbol = 'USD/JPY', displayTimeZone = 'Asia/Tokyo' }: { language: Language; symbol?: string; displayTimeZone?: string }) {
  const t = useCallback((zh: string, ja: string, en = zh) => (language === 'zh' ? zh : language === 'ja' ? ja : en), [language]);
  const startError = useCallback((message: string) => {
    if (/AI 终端尚未完成首次安装|Setup-Enkei\.cmd/.test(message)) return t('AI 终端尚未完成首次安装。请重新运行程序根目录的“Start-Enkei.cmd”。', 'AI端末の初回インストールが完了していません。ルートフォルダーの「Start-Enkei.cmd」をもう一度実行してください。', 'The AI Terminal first-time installation is incomplete. Run “Start-Enkei.cmd” again from the application root.');
    if (/AI 终端运行组件不完整/.test(message)) return t('AI 终端运行组件不完整。请重新运行程序根目录的“Start-Enkei.cmd”。', 'AI端末の実行コンポーネントが不足しています。ルートフォルダーの「Start-Enkei.cmd」をもう一度実行してください。', 'AI Terminal runtime components are incomplete. Run “Start-Enkei.cmd” again from the application root.');
    return message;
  }, [t]);
  const [ctrl, setCtrl] = useState<ControllerStatus | null>(null);
  const [terminalUrl, setTerminalUrl] = useState(resolveAiTerminalUrl);
  const [terminalDetected, setTerminalDetected] = useState(false);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<TerminalHealth | null>(null);
  const [news, setNews] = useState<NewsList | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [analysisTraces, setAnalysisTraces] = useState<AnalysisTrace[]>([]);
  const [models, setModels] = useState<CatalogEntry[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelSort, setModelSort] = useState<'provider' | 'availability' | 'price' | 'compute'>('availability');
  const [modelScope, setModelScope] = useState<'available' | 'all'>('available');
  const [gateway, setGateway] = useState<GatewayConfig | null>(null);
  const [gatewayDraft, setGatewayDraft] = useState<GatewayDraft | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState<'save' | 'test' | null>(null);
  const [gatewayTest, setGatewayTest] = useState('');
  const [cloudProvider, setCloudProvider] = useState<CloudProviderId>('zhipu');
  const [cloudModel, setCloudModel] = useState('glm-4.5-air');
  const [cloudBaseUrl, setCloudBaseUrl] = useState(CLOUD_PROVIDERS[0].baseUrl);
  const [cloudKey, setCloudKey] = useState('');
  const [testProgress, setTestProgress] = useState(0);
  const testProgressTimer = useRef<number | null>(null);
  const gatewayDraftInitialized = useRef(false);
  const [newsTitle, setNewsTitle] = useState('');
  const [newsBody, setNewsBody] = useState('');
  const [injecting, setInjecting] = useState(false);
  const [newsRefreshing, setNewsRefreshing] = useState(false);
  const newsRefreshAt = useRef(0);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const lastRefresh = useRef(0);
  const refreshInFlight = useRef(false);

  const toGatewayDraft = useCallback((config: GatewayConfig): GatewayDraft => ({
    librechat_base_url: config.librechat_base_url ?? '',
    librechat_api_key: '',
    unified_analysis_enabled: config.unified_analysis_enabled !== false,
    unified_agent_id: config.unified_agent_id ?? '',
    m5_agent_id: config.m5_agent_id ?? '',
    m15_agent_id: config.m15_agent_id ?? '',
    local_fallback_enabled: Boolean(config.local_fallback_enabled),
    ollama_base_url: config.ollama_base_url || 'http://127.0.0.1:11434',
    ollama_fallback_model: config.ollama_fallback_model ?? '',
  }), []);

  const running = Boolean(ctrl?.services?.ai_terminal || terminalDetected);
  const terminalBase = normalizeAiTerminalUrl(ctrl?.ai_terminal?.endpoint ?? terminalUrl);
  const terminalPort = new URL(terminalBase).port;

  const refreshController = useCallback(async () => {
    try {
      const response = await fetch(`${CTRL}/api/status`, { cache: 'no-store' });
      if (!response.ok) throw new Error('controller-unavailable');
      setCtrl(await response.json() as ControllerStatus);
    } catch {
      setCtrl(null);
    }
  }, []);

  const discoverTerminal = useCallback(async () => {
    // 控制中心已有受管端点时绝不以扫描结果覆盖它；这样旧端口不会“抢回”界面。
    if (ctrl?.ai_terminal?.endpoint) return;
    try {
      const response = await fetch(`${CTRL}/api/ai/discover`, { cache: 'no-store' });
      const data = await response.json() as { terminals?: Array<{ endpoint?: string }> };
      const endpoint = data.terminals?.find((item) => typeof item.endpoint === 'string')?.endpoint;
      if (endpoint) {
        setTerminalUrl(saveAiTerminalUrl(endpoint));
        setTerminalDetected(true);
      }
    } catch {
      // Discovery is a convenience only.  The saved loopback endpoint remains usable.
    }
  }, [ctrl?.ai_terminal?.endpoint]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshController();
      void discoverTerminal();
    }, 0);
    const timer = window.setInterval(() => void refreshController(), 10_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshController, discoverTerminal]);

  useEffect(() => {
    const sync = () => setTerminalUrl(resolveAiTerminalUrl());
    window.addEventListener('enkei-ai-terminal-url-changed', sync);
    return () => window.removeEventListener('enkei-ai-terminal-url-changed', sync);
  }, []);

  const refreshTerminal = useCallback(async () => {
    if (!running || refreshInFlight.current || Date.now() - lastRefresh.current < 8_000) return;
    refreshInFlight.current = true;
    lastRefresh.current = Date.now();
    try {
      const healthResponse = await fetch(`${terminalBase}/health`, { cache: 'no-store' });
      if (healthResponse.ok) {
        setHealth(await healthResponse.json() as TerminalHealth);
        setTerminalDetected(true);
      }
      const terminalSymbol = symbol.replace(/[^A-Za-z]/g, '').toUpperCase();
      const auditResponse = await fetch(`${terminalBase}/v1/audit/analysis?symbol=${encodeURIComponent(terminalSymbol)}&limit=12`, { cache: 'no-store' });
      if (auditResponse.ok) {
        const data = await auditResponse.json() as { traces?: AnalysisTrace[] };
        setAnalysisTraces(Array.isArray(data.traces) ? data.traces : []);
      }
      const newsResponse = await fetch(`${terminalBase}/v1/news?symbol=${encodeURIComponent(terminalSymbol)}&limit=30&language=${language}`, { cache: 'no-store' });
      if (newsResponse.ok) setNews(await newsResponse.json() as NewsList);
      // The terminal is the sole gateway boundary.  Older terminals do not
      // have this endpoint yet, so a 404 merely leaves the catalogue pending
      // instead of producing the old "save failed" provider form.
      const modelsResponse = await fetch(`${terminalBase}/v1/models?sort=${modelSort}`, { cache: 'no-store' });
      if (modelsResponse.ok) {
        const data = await modelsResponse.json() as ModelsData;
        const agents = Array.isArray(data.models) ? data.models : Array.isArray(data.available_agents) ? data.available_agents : [];
        const known = Array.isArray(data.known_providers) ? data.known_providers : [];
        const normalizedAgents = agents.map((entry) => ({ ...entry, deployment: entry.deployment ?? (entry.local ? 'local' : 'cloud') }));
        const knownEntries = known
          .filter((entry) => entry.provider && !normalizedAgents.some((agent) => agent.provider === entry.provider))
          .map((entry) => ({ provider: entry.provider, display_name: entry.display_name ?? entry.provider, deployment: entry.cloud ? 'cloud' as const : 'local' as const, available: Boolean(entry.available), health_status: entry.health_status }));
        setModels([...normalizedAgents, ...knownEntries]);
        setModelsLoaded(true);
      } else if (modelsResponse.status === 404) {
        setModelsLoaded(false);
      }
      const configResponse = await fetch(`${terminalBase}/v1/gateway/config`, { cache: 'no-store' });
      if (configResponse.ok) {
        const config = await configResponse.json() as GatewayConfig;
        setGateway(config);
        if (!gatewayDraftInitialized.current) {
          setGatewayDraft(toGatewayDraft(config));
          gatewayDraftInitialized.current = true;
        }
      }
      // 展示 AI 最近产出的判断（多空决策 + 理由 + 所用模型），让用户能复核“结论从何而来”。
      const latest: Policy[] = [];
      for (const tf of ['M5', 'M15']) {
        try {
          const policyResponse = await fetch(`${terminalBase}/v1/policies/current?symbol=${encodeURIComponent(terminalSymbol)}&timeframe=${tf}`, { cache: 'no-store' });
          if (policyResponse.ok) {
            const policy = await policyResponse.json() as Policy;
            if (policy && typeof policy === 'object') latest.push({ timeframe: tf, ...policy });
          }
        } catch { /* 单项失败不阻塞整体刷新 */ }
      }
      if (latest.length) setPolicies(latest);
      else setPolicies([]);
    } catch {
      setHealth(null);
      setNews(null);
      setAnalysisTraces([]);
      setTerminalDetected(false);
    } finally {
      refreshInFlight.current = false;
    }
  }, [running, terminalBase, language, symbol, modelSort, toGatewayDraft]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshTerminal(), 0);
    const timer = window.setInterval(() => void refreshTerminal(), 15_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshTerminal]);

  const startTerminal = async () => {
    setBusy('start');
    setNotice('');
    try {
      const port = Number(new URL(normalizeAiTerminalUrl(terminalUrl)).port);
      const response = await fetch(`${CTRL}/api/ai/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) });
      const data = await response.json() as { status?: string; error?: string; note?: string; pid?: number };
      if (data.status === 'started' || data.status === 'already-running') {
        const endpoint = typeof (data as { endpoint?: unknown }).endpoint === 'string' ? String((data as { endpoint?: unknown }).endpoint) : terminalUrl;
        setTerminalUrl(saveAiTerminalUrl(endpoint));
        setNotice(t('AI 终端已启动，正在等待模型就绪…', 'AI端末を起動しました。モデルの準備を待っています…', 'AI terminal started; waiting for models…'));
      } else {
        setNotice(startError(data.error ?? data.note ?? t('启动失败', '起動失敗', 'start failed')));
      }
    } catch {
      setNotice(t('无法连接本机控制中心，请确认程序已在运行。', '制御センターに接続できません。', 'Cannot reach the local controller.'));
    } finally {
      setBusy(null);
      await refreshController();
      lastRefresh.current = 0;
    }
  };

  const stopTerminal = async () => {
    setBusy('stop');
    setNotice('');
    // 等待关闭最多 15 秒：一键关闭是异步过程，避免把“仍在关闭中”误报成失败。
    const waitForShutdown = async (): Promise<boolean> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        try {
          const probe = await fetch(`${terminalBase}/health`, { cache: 'no-store', signal: AbortSignal.timeout(2_000) });
          if (!probe.ok) return true;
        } catch {
          return true;
        }
      }
      return false;
    };
    try {
      const response = await fetch(`${CTRL}/api/ai/stop`, { method: 'POST' });
      const data = await response.json() as { status?: string; error?: string };
      if (data.status === 'stopped' || data.status === 'already-stopped' || data.error) {
        if (data.status === 'stopped' || data.status === 'already-stopped') {
          setNotice(t('AI 终端已关闭。', 'AI端末を停止しました。', 'AI terminal stopped.'));
          setHealth(null);
          setNews(null);
          setTerminalDetected(false);
        } else {
          setNotice(data.error ?? t('停止失败', '停止失敗', 'stop failed'));
        }
      } else {
        // status === 'stopping'：关闭已受理，轮询等待端口/进程真正退出。
        const closed = await waitForShutdown();
        if (closed) {
          setNotice(t('AI 终端已关闭（等待进程退出完成）。', 'AI端末を停止しました（プロセス終了を確認済み）。', 'AI terminal stopped (process exit confirmed).'));
          setHealth(null);
          setNews(null);
          setTerminalDetected(false);
        } else {
          setNotice(t('关闭指令已发出，但进程仍在响应；可稍后重试或手动查看本机控制中心。', '停止指令は送信済みですが、プロセスがまだ応答しています。後で再試行するか、制御センターで確認してください。', 'Stop command sent, but the process is still responding; retry shortly or check the controller.'));
        }
      }
    } catch {
      setNotice(t('无法连接本机控制中心。', '制御センターに接続できません。', 'Cannot reach the local controller.'));
    } finally {
      setBusy(null);
      await refreshController();
      lastRefresh.current = 0;
    }
  };

  const injectNews = async () => {
    if (!newsTitle.trim()) return;
    setInjecting(true);
    try {
      const response = await fetch(`${terminalBase}/v1/news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newsTitle.trim(), body: newsBody.trim(), source: 'manual' }),
      });
      if (!response.ok) throw new Error('inject-failed');
      setNewsTitle('');
      setNewsBody('');
      setNotice(t('新闻已注入，下一轮模型判断会自动参考。', 'ニュースを注入しました。', 'News injected; the next assessment will include it.'));
      lastRefresh.current = 0;
      void refreshTerminal();
    } catch {
      setNotice(t('注入失败，请确认 AI 终端已启动。', '注入に失敗しました。', 'Inject failed.'));
    } finally {
      setInjecting(false);
    }
  };

  const refreshNews = async () => {
    if (!running) return;
    setNewsRefreshing(true);
    try {
      const response = await fetch(`${terminalBase}/v1/news/refresh`, { method: 'POST', cache: 'no-store' });
      const data = await response.json() as { status?: string; ok?: boolean; error?: string; last_error?: string | null; last_refresh?: string | null; total?: number };
      if (!response.ok || data.error) throw new Error(data.error ?? `http-${response.status}`);
      // 兼容旧版终端：后端已返回 ok 字段；旧实现无 ok 时按 status=ok 判定。
      const completed = data.ok === true || data.status === 'ok';
      if (!completed) throw new Error(`http-unexpected`);
      if (data.last_error) {
        setNotice(t(`新闻已刷新，但部分来源不可达：${data.last_error}`, `ニュースを更新しましたが、一部のソースに接続できません：${data.last_error}`, `News refreshed, but some sources are unavailable: ${data.last_error}`));
      } else {
        setNotice(t(`新闻已刷新，共 ${data.total ?? 0} 条。`, `ニュースを更新しました（${data.total ?? 0}件）。`, `News refreshed (${data.total ?? 0} items).`));
      }
    } catch {
      setNotice(t('刷新失败：无法触发新闻刷新，请确认 AI 终端仍在运行。', '更新失敗：ニュース更新を実行できません。AI端末の稼働を確認してください。', 'Refresh failed: could not trigger a news refresh. Confirm the AI terminal is running.'));
    } finally {
      setNewsRefreshing(false);
      lastRefresh.current = 0;
      void refreshTerminal();
    }
  };

  const saveGateway = async () => {
    if (!gatewayDraft) return;
    setGatewayBusy('save');
    setGatewayTest('');
    try {
      const payload: Record<string, string | boolean> = {
        librechat_base_url: gatewayDraft.librechat_base_url.trim(),
        unified_analysis_enabled: gatewayDraft.unified_analysis_enabled,
        unified_agent_id: gatewayDraft.unified_agent_id.trim(),
        m5_agent_id: gatewayDraft.m5_agent_id.trim(),
        m15_agent_id: gatewayDraft.m15_agent_id.trim(),
        local_fallback_enabled: gatewayDraft.local_fallback_enabled,
        ollama_base_url: gatewayDraft.ollama_base_url.trim(),
        ollama_fallback_model: gatewayDraft.ollama_fallback_model.trim(),
      };
      // An empty field means “keep the current key” by contract.  This lets
      // users change routing without ever re-reading or exposing a saved key.
      if (gatewayDraft.librechat_api_key.trim()) payload.librechat_api_key = gatewayDraft.librechat_api_key.trim();
      const response = await fetch(`${terminalBase}/v1/gateway/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      const config = await response.json() as GatewayConfig;
      setGateway(config);
      setGatewayDraft(toGatewayDraft(config));
      gatewayDraftInitialized.current = true;
      setNotice(t('AI 路由配置已热生效。', 'AIルーティング設定を即時反映しました。', 'AI routing configuration is active immediately.'));
    } catch {
      setNotice(t('保存失败：请确认 AI 终端仍在运行。', '保存失敗：AI端末の稼働を確認してください。', 'Save failed. Confirm that the AI terminal is running.'));
    } finally {
      setGatewayBusy(null);
      lastRefresh.current = 0;
    }
  };

  const enableCloudProvider = async () => {
    if (!cloudKey.trim() || !cloudModel.trim()) {
      setNotice(t('请选择提供商、模型并输入 API Key。', 'プロバイダーとモデルを選択し、API Keyを入力してください。', 'Choose a provider and model, then enter its API key.'));
      return;
    }
    setGatewayBusy('save');
    try {
      const response = await fetch(`${terminalBase}/v1/providers/credential`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: cloudProvider, api_key: cloudKey.trim(), model: cloudModel.trim(), base_url: cloudBaseUrl.trim() }),
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      setCloudKey('');
      setNotice(t(`${cloudProvider} / ${cloudModel} 已设为在线主路由；历史分析记录保持不变。`, `${cloudProvider} / ${cloudModel} をオンライン主経路に設定しました。履歴は保持されます。`, `${cloudProvider} / ${cloudModel} is now the primary online route; existing analysis history is retained.`));
      lastRefresh.current = 0;
      void refreshTerminal();
    } catch {
      setNotice(t('在线模型配置失败，请检查提供商、模型、密钥和网络。', 'オンラインモデル設定に失敗しました。プロバイダー、モデル、キー、ネットワークを確認してください。', 'Cloud model setup failed. Check the provider, model, key, and network.'));
    } finally { setGatewayBusy(null); }
  };

  const testGateway = async () => {
    if (!gatewayDraft) return;
    const agent = (gatewayDraft.unified_analysis_enabled ? gatewayDraft.unified_agent_id.trim() : '') || gatewayDraft.m5_agent_id.trim() || gatewayDraft.m15_agent_id.trim();
    const model = gatewayDraft.ollama_fallback_model.trim();
    if (!agent && !model) {
      setGatewayTest(t('请先选择一个本地模型或填写 LibreChat Agent。', 'ローカルモデルまたはLibreChat Agentを指定してください。', 'Select a local model or enter a LibreChat agent first.'));
      return;
    }
    setGatewayBusy('test');
    setGatewayTest('');
    setTestProgress(3);
    // 测试采用异步探活；用百分比让“本地模型首次加载较慢”的过程可视化。
    if (testProgressTimer.current !== null) window.clearInterval(testProgressTimer.current);
    testProgressTimer.current = window.setInterval(() => {
      setTestProgress((previous) => {
        // 慢速爬升并封顶 85%，最终结果到达后由下方补到 100%。
        const step = previous < 30 ? 6 : previous < 60 ? 4 : 2;
        return Math.min(85, previous + step);
      });
    }, 600);
    try {
      const response = await fetch(`${terminalBase}/v1/gateway/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agent ? { agent } : { model }),
      });
      const data = await response.json() as { ok?: boolean; latency_ms?: number; model_or_agent?: string; failure_category?: string };
      if (testProgressTimer.current !== null) { window.clearInterval(testProgressTimer.current); testProgressTimer.current = null; }
      setTestProgress(100);
      if (!response.ok || !data.ok) throw new Error(data.failure_category ?? `http-${response.status}`);
      setGatewayTest(t(`连通正常：${data.model_or_agent ?? (agent || model)}，${data.latency_ms ?? '—'} ms`, `接続正常：${data.model_or_agent ?? (agent || model)}，${data.latency_ms ?? '—'} ms`, `Connected: ${data.model_or_agent ?? (agent || model)}, ${data.latency_ms ?? '—'} ms`));
    } catch {
      if (testProgressTimer.current !== null) { window.clearInterval(testProgressTimer.current); testProgressTimer.current = null; }
      setTestProgress(100);
      setGatewayTest(t('连通测试暂未通过；本地模型首次加载可能需要更久。', '接続テストは未完了です。ローカルモデルの初回読み込みには時間がかかることがあります。', 'Connection test did not complete. The first local-model load can take longer.'));
    } finally {
      setGatewayBusy(null);
    }
  };

  const applyModel = async (entry: CatalogEntry) => {
    if (!running || !gatewayDraft) return;
    const target = (entry.model_or_agent ?? entry.agent_id ?? entry.model ?? '').trim();
    if (!target) { setNotice(t('该条目缺少可应用的模型或 Agent ID。', 'この項目には適用可能なモデル/Agent IDがありません。', 'This entry has no model or agent ID to apply.')); return; }
    const isLocal = entry.deployment === 'local' || entry.local === true;
    setGatewayBusy('save');
    setNotice(isLocal ? t(`正在将本地模型「${entry.display_name ?? target}」设为本地备用…`, `ローカルモデル「${entry.display_name ?? target}」をローカル予備に設定中…`, `Setting local model "${entry.display_name ?? target}" as fallback…`) : t(`正在把统一分析体切换为「${entry.display_name ?? target}」…`, `統合分析体を「${entry.display_name ?? target}」に切替中…`, `Switching unified analysis to "${entry.display_name ?? target}"…`));
    try {
      const draft: GatewayDraft = { ...gatewayDraft,
        ...(isLocal
          ? { ollama_fallback_model: target, local_fallback_enabled: true }
          : { unified_agent_id: target, m5_agent_id: target, m15_agent_id: target, unified_analysis_enabled: true }) };
      const payload: Record<string, string | boolean> = {
        librechat_base_url: draft.librechat_base_url.trim(),
        unified_analysis_enabled: draft.unified_analysis_enabled,
        unified_agent_id: (draft.unified_agent_id || '').trim(),
        m5_agent_id: (draft.m5_agent_id || '').trim(),
        m15_agent_id: (draft.m15_agent_id || '').trim(),
        local_fallback_enabled: draft.local_fallback_enabled,
        ollama_base_url: draft.ollama_base_url.trim(),
        ollama_fallback_model: isLocal ? target : (draft.ollama_fallback_model || '').trim(),
      };
      if (draft.librechat_api_key.trim()) payload.librechat_api_key = draft.librechat_api_key.trim();
      const response = await fetch(`${terminalBase}/v1/gateway/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      const config = await response.json() as GatewayConfig;
      setGateway(config);
      setGatewayDraft(toGatewayDraft(config));
      setNotice(isLocal ? t(`已应用本地备用模型：${target}（云端不可用时自动启用）`, `ローカル予備モデルを適用しました：${target}`, `Local fallback applied: ${target} (used when the cloud route is unavailable)`) : t(`统一分析体已切换为：${entry.display_name ?? target}，保存并热生效`, `統合分析体を切替えました：${entry.display_name ?? target}`, `Unified analysis switched to ${entry.display_name ?? target} and applied immediately.`));
    } catch {
      setNotice(t('应用失败：请确认 AI 终端仍在运行。', '適用に失敗しました：AI端末の稼働を確認してください。', 'Apply failed. Confirm the AI terminal is running.'));
    } finally {
      setGatewayBusy(null);
      lastRefresh.current = 0;
    }
  };

  const fmtTime = (iso?: string | null) => {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : 'en-US', { timeZone: displayTimeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
  };

  const ollamaOnline = Boolean(health?.ollama?.ok ?? health?.ollama?.available);
  const gatewayReady = Boolean(health?.gateway?.librechat_ready ?? health?.gateway?.available);
  const primaryProvider = health?.routing?.M5?.provider ?? '';
  const primaryProviderLabel = primaryProvider === 'zhipu' ? '智谱 GLM' : primaryProvider || '—';
  const hasDirectCloudRoute = Boolean(primaryProvider && primaryProvider !== 'ollama' && primaryProvider !== 'librechat');
  const visibleModels = models.filter((entry) => modelScope === 'all' || entry.available);

  const providerLabel = (provider?: string) => (provider === 'zhipu' ? '智谱 GLM' : provider === 'ollama' ? 'Ollama 本地' : provider === 'librechat' ? 'LibreChat' : provider || '—');
  const routeLabel = (tf: 'M5' | 'M15') => {
    const route = health?.routing?.[tf];
    if (!route?.provider) return null;
    const model = typeof route.model_role === 'string' ? route.model_role : '';
    const configuredModel = model ? `${providerLabel(route.provider)} · ${model}` : providerLabel(route.provider);
    return health?.gateway?.primary_execution === 'librechat_agent'
      ? `LibreChat 统一分析体 · ${configuredModel}`
      : configuredModel;
  };
  // 当前实际使用的模型：优先以运行期路由为准，路由未明确时回退到配置的统一分析体 ID。
  const activeModelLabel = (() => {
    if (!running) return '—';
    const m5 = routeLabel('M5');
    const m15 = routeLabel('M15');
    if (m5 || m15) return [m5, m15].filter(Boolean).join(' / ') as string;
    if (gateway?.unified_analysis_enabled) {
      return gateway?.unified_agent_id ? `统一分析体 ${gateway.unified_agent_id}` : t('统一分析体（待配置）', '統合分析体（未設定）', 'Unified analysis (not configured)');
    }
    const legacy = [gateway?.m5_agent_id, gateway?.m15_agent_id].filter(Boolean).join(' / ');
    return legacy || (gateway?.ollama_fallback_model ? `本地备用 ${gateway.ollama_fallback_model}` : '—');
  })();

  return (
    <details className="ai-terminal-console phase-panel" id="ai-terminal-console" open>
      <summary className="phase-heading">
        <div>
          <p className="eyebrow">{t('AI 辅助判断终端', 'AI補助判断端末', 'AI decision terminal')} · {terminalPort}</p>
          <h3>{t('AI 终端控制台', 'AI端末コンソール', 'AI terminal console')}</h3>
        </div>
        <span className={running ? 'demo-auto-chip armed' : 'demo-auto-chip'}>{running ? t('运行中', '稼働中', 'running') : (ctrl?.ai_terminal?.auto_start !== false ? t('自动启动中', '自動起動中', 'auto-starting') : t('已关闭', '停止中', 'stopped'))}</span>
      </summary>

      <TokenUsagePanel language={language} />

      <div className="ai-console-grid">
        {/* 左侧：启停 + 健康 */}
        <div className="ai-console-column">
          <div className="ai-terminal-actions">
            <button
              disabled={busy !== null || running}
              onClick={() => void startTerminal()}
              className="primary-btn ai-terminal-start"
            >{busy === 'start' ? t('启动中…', '起動中…', 'starting…') : t('一键启动 AI 终端', 'AI端末を起動', 'Start AI terminal')}</button>
            <button
              disabled={busy !== null || !running}
              onClick={() => void stopTerminal()}
              className="stop ai-terminal-stop"
            >{busy === 'stop' ? t('关闭中…', '停止中…', 'stopping…') : t('一键关闭 AI 终端', 'AI端末を停止', 'Stop AI terminal')}</button>
          </div>
          <div className="ai-terminal-endpoint">
            <label>
              <span>{t('本机 AI 地址', 'ローカル AI アドレス', 'Local AI address')}</span>
              <input
                value={terminalUrl}
                inputMode="url"
                onChange={(event) => setTerminalUrl(event.target.value)}
                onBlur={() => setTerminalUrl(saveAiTerminalUrl(terminalUrl))}
                placeholder="http://127.0.0.1:8710"
                aria-label={t('本机 AI 终端地址', 'ローカル AI 端末アドレス', 'Local AI terminal endpoint')}
              />
            </label>
            <button type="button" onClick={() => setTerminalUrl(saveAiTerminalUrl(terminalUrl))}>{t('保存地址', 'アドレスを保存', 'Save address')}</button>
            <small>{t('可填写任意本机端口；程序会优先使用已识别到的终端。', '任意のローカルポートを入力できます。検出済み端末を優先します。', 'Any loopback port is allowed; a detected terminal takes priority.')}</small>
          </div>
          <div className="demo-auto-status ai-terminal-status-grid">
            <article>
              <span>{t('终端进程', '端末プロセス', 'process')}</span>
              <b className={running ? 'positive' : ''}>{running ? `${t('已启动', '起動中', 'running')} · ${terminalPort}` : t('未启动', '停止中', 'stopped')}</b>
              <small>{ctrl ? t('本机控制中心已连接', '制御センター接続済み', 'controller online') : t('控制中心不可达', '制御センター未接続', 'controller offline')}</small>
            </article>
            <article>
              <span>{t('LibreChat 网关', 'LibreChat ゲートウェイ', 'LibreChat gateway')}</span>
              <b className={ctrl?.librechat?.ready ? 'positive' : ''}>{ctrl?.librechat?.ready ? t('服务已启动', 'サービス起動済み', 'service running') : t('正在自动启动', '自動起動中', 'auto-starting')}</b>
              <small>{gatewayReady ? `${health?.gateway?.agents ?? 0} ${t('个可用决策 Agent', '個の決定エージェント', 'decision agents available')}` : (ctrl?.librechat?.detail ?? t('正在准备本机 LibreChat；本地备用模型可继续工作。', 'ローカルLibreChatを準備中です。ローカル予備モデルは利用できます。', 'Preparing local LibreChat; the local fallback remains available.'))}</small>
              <a href={ctrl?.librechat?.endpoint ?? 'http://127.0.0.1:3080'} target="_blank" rel="noreferrer">{t('打开 LibreChat 对话', 'LibreChatチャットを開く', 'Open LibreChat chat')}</a>
            </article>
            <article>
              <span>{t('本地备用', 'ローカル予備', 'local fallback')}</span>
              <b className={running && ollamaOnline ? 'positive' : ''}>{running ? (ollamaOnline ? (health?.ollama?.version ?? t('可用', '利用可', 'available')) : t('未配置', '未設定', 'not configured')) : '—'}</b>
              <small>{running && health?.ollama?.models?.length ? `${health.ollama.models.length} ${t('个本地模型', '個のローカルモデル', 'local models')}` : t('Ollama 是可选备用，不影响线上网关的首次使用。', 'Ollamaは任意の予備で、オンライン利用の前提ではありません。', 'Ollama is optional and is not required for cloud gateway use.')}</small>
            </article>
            <article>
              <span>{t('政策缓存', '方針キャッシュ', 'policies')}</span>
              <b>{running ? (health?.policies ?? 0) : '—'}</b>
              <small>{t('M5/M15 收盘评估产出', 'M5/M15足確定で評価', 'produced on M5/M15 close')}</small>
            </article>
            <article className="ai-current-model">
              <span>{t('当前使用的模型', '現在使用中のモデル', 'active model')}</span>
              <b className={running && activeModelLabel !== '—' ? 'positive' : ''}>{activeModelLabel}</b>
              <small>{running ? `${t('M5', 'M5', 'M5')}: ${routeLabel('M5') ?? '—'} · ${t('M15', 'M15', 'M15')}: ${routeLabel('M15') ?? '—'}` : t('终端运行后显示实际路由模型。', '端末起動後に実際の経路モデルを表示します。', 'Actual route model appears while the terminal runs.')}</small>
            </article>
          </div>
          {!running && ctrl?.ai_terminal?.last_start_error && <div className="demo-execution-warning ai-terminal-warning"><span>!</span><p>{startError(ctrl.ai_terminal.last_start_error)}</p></div>}
          {news?.last_error && <div className="demo-execution-warning ai-terminal-warning"><span>!</span><p>{t('外网新闻源暂时不可达；不会把错误内容当成新闻。可稍后自动重试，或在右侧手动注入。', '外部ニュース源に一時接続できません。エラー内容をニュースとして扱いません。後で自動再試行するか、右側から手動注入してください。', 'Public news sources are temporarily unavailable. The error is not treated as news; retry later or inject a source item.')}</p></div>}
          {notice && <p className="demo-execution-notice ai-terminal-notice">{notice}</p>}
        </div>

        {/* 右侧：新闻速览 */}
        <div className="ai-console-column ai-news-column">
          <div className="ai-news-title">
            <b>{t('AI 筛选市场新闻', 'AI選別マーケットニュース', 'AI-curated market news')}</b>
            <span>{symbol} · {t('每 5 分钟最多整理一次，不阻塞报价', '最大5分ごとに整理。価格配信を止めません', 'cached every 5 min; never blocks quotes')}</span>
            <button type="button" className="ai-news-refresh" disabled={!running || newsRefreshing} onClick={() => { if (Date.now() - newsRefreshAt.current < 2000) return; newsRefreshAt.current = Date.now(); void refreshNews(); }}>{newsRefreshing ? t('刷新中…', '更新中…', 'Refreshing…') : t('刷新', '更新', 'Refresh')}</button>
          </div>
          <details className="ai-news-sources">
            <summary>{t('新闻来源与状态', 'ニュースソースと状態', 'News sources & status')}</summary>
            <div className="ai-news-source-grid">
              {(news?.sources?.length ? news.sources : []).map((source, index) => (
                <article key={`${source.name ?? source.url}-${index}`} className={source.ok ? 'ok' : 'fail'}>
                  <b>{source.name ?? source.url ?? t('未命名来源', '名称未設定ソース', 'Unnamed source')}</b>
                  <span>{source.ok ? t('可用', '利用可', 'ok') : t('失败', '失敗', 'failed')}</span>
                  <small>{source.last_refresh ? `${t('抓取', '取得', 'fetched')} ${fmtTime(source.last_refresh)} · ${source.last_count ?? 0} ${t('条', '件', 'items')}` : t('尚未抓取', '未取得', 'not fetched yet')}</small>
                  {source.last_error && <small className="error">{source.last_error}</small>}
                </article>
              ))}
              {!running && <p className="empty-state">{t('AI 终端未启动，暂无来源状态。', 'AI端末未起動のためソース状態がありません。', 'Terminal offline; no source status.')}</p>}
              {running && (news?.sources?.length ?? 0) === 0 && <p className="empty-state">{t('正在读取来源配置…', 'ソース設定を読み込み中…', 'Loading source configuration…')}</p>}
            </div>
          </details>
          {(news?.cache_expired && news?.last_error) && <div className="demo-execution-warning ai-terminal-warning"><span>!</span><p>{t('新闻缓存已过期且刷新失败；已保留上次缓存供查看。', 'ニュースキャッシュが期限切れで更新に失敗しました。直前のキャッシュを表示中です。', 'News cache is stale and refresh failed; showing the last cached copy.')}</p></div>}
          {news?.brief && <div className="ai-news-brief">
            <b>{news.brief.importance === 'high' ? t('重要背景', '重要な背景', 'High-impact context') : t('市场简报', '市場要約', 'Market brief')}</b>
            <p>{news.brief.summary || t('正在由 AI 整理来源新闻…', 'AIがニュースを整理中です…', 'AI is curating source news…')}</p>
            <small>{news.brief.mode === 'ai-curated' ? `${t('AI 已筛选', 'AI選別済み', 'AI curated')} · ${news.brief.source}` : t('来源新闻回退：AI 未就绪时不伪造翻译或判断。', 'ソースニュース表示：AI未準備時は翻訳・判断を作りません。', 'Source fallback: no invented translation or judgement while AI is unavailable.')}</small>
          </div>}
          <details className="ai-news-manual">
            <summary>{t('手动补充新闻（可选）', 'ニュースを手動追加（任意）', 'Add a news item manually (optional)')}</summary>
            <div className="ai-news-inject">
              <input
                value={newsTitle}
                onChange={(e) => setNewsTitle(e.target.value)}
                placeholder={t('标题（必填），如：非农数据超预期', 'タイトル（必須）', 'Title (required)')}
                disabled={!running || injecting}
              />
              <input
                value={newsBody}
                onChange={(e) => setNewsBody(e.target.value)}
                placeholder={t('正文（可选）', '本文（任意）', 'Body (optional)')}
                disabled={!running || injecting}
              />
              <button onClick={() => void injectNews()} disabled={!running || injecting || !newsTitle.trim()}>{injecting ? t('注入中…', '注入中…', 'Injecting…') : t('手动注入', '手動注入', 'Inject')}</button>
            </div>
          </details>
          <div className="ai-news-list">
            {running && (news?.items?.length ?? 0) === 0 && <p className="empty-state">{t('暂无新闻，正在后台抓取公开 RSS。', 'ニュースなし、RSSを取得中。', 'No news yet; fetching public RSS.')}</p>}
            {(news?.brief?.language === language && news.brief.items?.length ? news.brief.items : news?.items ?? []).slice(0, 12).map((item, index) => (
              <article key={`${item.created_at}-${index}`}>
                <div>
                  <b>{item.display_title || (language === 'en' ? item.title : t('等待 AI 翻译该条新闻', 'このニュースのAI翻訳を待機中', 'Waiting for AI translation'))}</b>
                  <span>{fmtTime(item.created_at ?? item.published)}</span>
                </div>
                {item.body && language === 'en' && <small>{item.body}</small>}
                <small className="ai-news-meta">
                  {item.source && <span className="chip">{item.source}</span>}
                  {item.translation_status === 'translated' && <span className="chip ok">{t('已翻译', '翻訳済み', 'translated')}</span>}
                  {item.translation_status === 'pending' && <span className="chip pending">{t('待翻译', '翻訳待ち', 'pending')}</span>}
                  {item.translation_error && <span className="chip error">{t('翻译失败', '翻訳失敗', 'translate failed')}</span>}
                  {item.failure_reason && <span className="chip error">{item.failure_reason}</span>}
                  {language === 'en' && item.reason ? ` · ${item.reason}` : null}
                </small>
              </article>
            ))}
          </div>
        </div>
      </div>

      {/* 最新 AI 判断：直接呈现 AI 得出了什么结论、依据与所用模型，避免“只给结果不给原因”。 */}
      <details className="ai-policy-view">
        <summary>{t('最新 AI 判断', '最新のAI判断', 'Latest AI judgement')}</summary>
        {!running && <p className="empty-state">{t('AI 终端未启动，暂无可显示的判断。', 'AI端末未起動のため、判断を表示できません。', 'Terminal offline; no judgement available.')}</p>}
        {running && policies.length === 0 && <p className="empty-state">{t('尚未产生有效判断，或当前判断已过期。M5/M15 收盘后由路由模型自动评估生成。', '有効な判断はまだありません（または期限切れ）。M5/M15足確定時に経路モデルが自動評価します。', 'No valid judgement yet, or it has expired. The routed model evaluates on each M5/M15 close.')}</p>}
        {running && policies.length > 0 && <div className="ai-policy-grid">
          {policies.map((policy, index) => {
            const bias = policy.action_bias ?? policy.direction ?? '';
            const biasLabel = bias === 'long' ? t('做多', 'ロング', 'Long') : bias === 'short' ? t('做空', 'ショート', 'Short') : bias === 'close' ? t('平仓', '決済', 'Close') : bias === 'wait' ? t('观望', '様子見', 'Wait') : bias || t('无', 'なし', 'none');
            const confidence = typeof policy.confidence === 'number' ? policy.confidence : null;
            const rationale = language === 'en' ? policy.rationale_en || policy.rationale_zh : language === 'ja' ? policy.rationale_ja || policy.rationale_zh : policy.rationale_zh || policy.rationale_en;
            return <article key={`${policy.timeframe ?? 'tf'}-${policy.created_at ?? index}`} className={`ai-policy-bias-${bias}`}>
              <div className="ai-policy-head"><b>{policy.symbol ?? symbol} · {policy.timeframe ?? '—'}</b><span className={`ai-policy-chip ${bias}`}>{biasLabel}{confidence !== null ? ` · ${Math.round(confidence)}%` : ''}</span></div>
              {rationale ? <p className="ai-policy-rationale">{rationale}</p> : <p className="ai-policy-rationale">{t('（本次判断未附理由）', '（今回は理由が付されていません）', '(no rationale attached)')}</p>}
              <small>{t('模型', 'モデル', 'model')}: {policy.model_id ?? policy.provider ?? '—'} · {policy.provider === 'librechat' ? t('经 LibreChat 统一分析体调用', 'LibreChat統合分析体経由', 'via LibreChat unified agent') : policy.provider ?? '—'} · {fmtTime(policy.created_at)}{policy.expires_at ? ` · ${t('有效至', '有効期限', 'valid until')} ${fmtTime(policy.expires_at)}` : ''}</small>
            </article>;
          })}
          <p className="ai-policy-note">{t('同一符号的 M5/M15 判断由统一分析体在各自 K 线收盘时产出；做多做空均已支持。这里的“经 LibreChat”是后台 Agents API 的可审计调用凭证：它会写入圆衡政策与终端日志，但不会自动出现在 LibreChat 网页版的普通对话历史。', '同一シンボルのM5/M15判断は統合分析体が足確定時に生成。ロング・ショート両対応です。「LibreChat経由」はバックグラウンド Agents API の監査証跡です。円衡の方針と端末ログには記録されますが、LibreChat画面の通常チャット履歴には自動表示されません。', 'M5/M15 judgements share the unified analysis entity and are produced at each candle close. “Via LibreChat” is an auditable background Agents API receipt: it is recorded in Enkei policies and terminal logs, but does not automatically appear in LibreChat’s normal chat history.')}</p>
        </div>}
      </details>

      <details className="ai-policy-view">
        <summary>{t('统一分析体会话记录', '統合分析体の実行記録', 'Unified analysis trace')}</summary>
        <p className="ai-policy-note">{t('这里显示每一笔真正提交给统一 Agent 的脱敏证据链：行情包摘要与哈希、新闻/研究上下文、Agent 和返回结果。LibreChat 的 Agents API 是无状态接口，因此这些记录不会伪装成 LibreChat 网页里的普通聊天历史。', 'ここには統合Agentへ実際に送信した匿名化済みの証跡（市場パケット要約とハッシュ、ニュース/研究文脈、Agent、結果）を表示します。LibreChat Agents API はステートレスのため、通常のチャット履歴として偽装しません。', 'This is the redacted evidence chain for each request actually sent to the unified agent: market-packet summary and hash, news/research context, agent, and outcome. LibreChat Agents API is stateless, so these are not presented as normal LibreChat chat history.')}</p>
        {!running && <p className="empty-state">{t('AI 终端未启动。', 'AI端末は未起動です。', 'AI terminal is offline.')}</p>}
        {running && analysisTraces.length === 0 && <p className="empty-state">{t('尚无可显示的提交记录。等待下一次有效 M5/M15 行情评估。', '表示できる送信記録はまだありません。次の有効なM5/M15評価を待機しています。', 'No submission trace yet. Waiting for the next valid M5/M15 evaluation.')}</p>}
        {analysisTraces.map((trace) => {
          const traceStatus = trace.status === 'succeeded' ? t('已完成', '完了', 'Completed') : trace.status === 'submitted' ? t('分析中', '分析中', 'Analyzing') : trace.status === 'rejected' ? t('已拒绝', '拒否', 'Rejected') : trace.status === 'invalid' ? t('无效', '無効', 'Invalid') : trace.status === 'failed' ? t('失败', '失敗', 'Failed') : trace.status ?? '—';
          const rationale = language === 'ja' ? trace.result?.rationale_ja || trace.result?.rationale_zh : language === 'en' ? trace.result?.rationale_en || trace.result?.rationale_zh : trace.result?.rationale_zh;
          return <article key={trace.request_id} className="ai-trace-card">
          <div className="ai-policy-head"><b>{trace.market_packet?.symbol ?? symbol} · {trace.market_packet?.timeframe ?? '—'}</b><span className={`ai-policy-chip ${trace.status === 'succeeded' ? 'long' : trace.status === 'submitted' ? 'wait' : 'short'}`}>{traceStatus}</span></div>
          <small>{fmtTime(trace.created_at)} · Agent: {trace.agent_id ?? '—'} · {trace.transport ?? '—'}</small>
          <p className="ai-policy-rationale">{t('行情', '市場', 'Market')}: {trace.market_packet?.bars?.count ?? 0} {t('根K线', '本の足', 'bars')} · mid {trace.market_packet?.quote?.mid ?? '—'} · {t('最新收盘', '直近終値', 'last close')} {trace.market_packet?.bars?.last_close ?? '—'}<br />{t('上下文', '文脈', 'Context')}: {trace.context?.news_count ?? 0} {t('条新闻', '件のニュース', 'news')} · {trace.context?.research_context ? t('专项研究', '個別研究', 'research') : t('无专项研究', '研究なし', 'no research')} · {trace.context?.deep_research_context ? t('深度研究', '深度研究', 'deep research') : ''}</p>
          {rationale && <p className="ai-policy-rationale"><b>{t('分析回复', '分析回答', 'Analyst reply')}：</b>{rationale}</p>}
          <small>{t('数据指纹', 'データ指紋', 'Data fingerprint')}: {trace.market_packet?.digest ? `${trace.market_packet.digest.slice(0, 16)}…` : '—'}{trace.result ? ` · ${trace.result.source ?? '—'} / ${trace.result.model_id ?? '—'} / ${trace.result.action_bias ?? '—'} ${trace.result.confidence ?? '—'}%` : ''}{trace.token_usage ? ` · Token ${trace.token_usage.total_tokens ?? '—'} (${trace.token_usage.input_tokens ?? '—'} + ${trace.token_usage.output_tokens ?? '—'})` : ` · ${t('供应商未返回 Token 用量', 'プロバイダーのToken使用量なし', 'Token usage not reported')}`}{trace.error ? ` · ${t('错误', 'エラー', 'error')}: ${trace.error}` : ''}</small>
        </article>;})}
      </details>

      <details className="ai-gateway-settings" open>
        <summary>{t('AI 路由设置', 'AIルーティング設定', 'AI routing settings')}</summary>
        {!running && <p className="empty-state">{t('请先启动 AI 终端后再配置。', '先にAI端末を起動してから設定してください。', 'Start the AI terminal before configuring it.')}</p>}
        {running && !gatewayDraft && <p className="empty-state">{t('正在读取 AI 终端配置…', 'AI端末設定を読み込み中…', 'Loading AI terminal configuration…')}</p>}
        {running && gatewayDraft && <div className="ai-gateway-settings-body">
          <section className="ai-route-section primary-route"><h4>{t('主模型配置', 'メインモデル設定', 'Primary model')}</h4><p>{t('选择常用厂商和模型，也可直接输入厂商最新模型 ID。保存后立即用于 M5/M15，历史对话与判断不会被清除。', '主要プロバイダーとモデルを選択するか、最新のモデルIDを直接入力できます。保存後すぐM5/M15に反映され、履歴は保持されます。', 'Choose a common provider/model or enter any current model ID. Saving applies it to M5/M15 without clearing history.')}</p><div className="ai-gateway-grid">
            <label><span>{t('在线 AI 提供商', 'オンラインAIプロバイダー', 'Cloud AI provider')}</span><select value={cloudProvider} onChange={(event) => { const provider = event.target.value as CloudProviderId; const preset = CLOUD_PROVIDERS.find((item) => item.id === provider) ?? CLOUD_PROVIDERS[0]; setCloudProvider(provider); setCloudBaseUrl(preset.baseUrl); setCloudModel(preset.models[0] ?? ''); }} >{CLOUD_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
            <label><span>{t('模型 ID（可选择，也可手动输入）', 'モデルID（選択・手入力）', 'Model ID (select or type)')}</span><input list={`enkei-models-${cloudProvider}`} value={cloudModel} placeholder={t('输入厂商提供的模型 ID', 'プロバイダーのモデルID', 'Enter the provider model ID')} onChange={(event) => setCloudModel(event.target.value)} /><datalist id={`enkei-models-${cloudProvider}`}>{(CLOUD_PROVIDERS.find((item) => item.id === cloudProvider)?.models ?? []).map((model) => <option key={model} value={model} />)}</datalist></label>
            {(cloudProvider === 'custom') && <label><span>{t('兼容接口地址（Base URL）', '互換APIアドレス（Base URL）', 'Compatible Base URL')}</span><input value={cloudBaseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setCloudBaseUrl(event.target.value)} /></label>}
            <label><span>{t('API Key（仅写入本机私有配置）', 'API Key（ローカル非公開設定のみ）', 'API key (local private config only)')}</span><input type="password" autoComplete="new-password" value={cloudKey} placeholder={t('输入该提供商的新密钥', 'プロバイダーの新しいキー', 'Enter a new provider key')} onChange={(event) => setCloudKey(event.target.value)} /></label>
          </div><div className="ai-gateway-actions"><button type="button" className="primary-btn" disabled={gatewayBusy !== null} onClick={() => void enableCloudProvider()}>{t('保存并设为主模型', '保存してメインに設定', 'Save as primary model')}</button></div></section>
          <p>{hasDirectCloudRoute
            ? t(`M5/M15 主路由：${primaryProviderLabel}；密钥仅保存在本机私有配置，不会回显到圆衡。`, `M5/M15の主経路：${primaryProviderLabel}。キーはローカルの非公開設定にのみ保存され、円衡には再表示されません。`, `M5/M15 primary route: ${primaryProviderLabel}. Keys stay only in local private configuration and are never shown in Enkei.`)
            : gateway?.configured
            ? t('LibreChat 已配置；密钥不会回显到圆衡。', 'LibreChatは設定済みです。キーは円衡に再表示されません。', 'LibreChat is configured. Saved keys are never returned to Enkei.')
            : t('当前使用本机备用模型；LibreChat 与线上模型可在之后随时接入。', '現在はローカル予備モデルを使用中です。LibreChatとオンラインモデルは後でいつでも追加できます。', 'The local fallback is active. LibreChat and cloud models can be added later.')}</p>
          <details className="ai-route-advanced"><summary>{t('高级连接与本地备用', '高度な接続とローカル予備', 'Advanced connections and local fallback')}</summary><p>{t('仅供已有 LibreChat Agent 或需要断网备用的高级用户。普通用户无需填写。', 'LibreChat Agentまたはオフライン予備が必要な上級ユーザー向けです。通常は設定不要です。', 'Only for users with a LibreChat Agent or an offline fallback. Most users can leave this untouched.')}</p><label className="ai-gateway-fallback"><input type="checkbox" checked={gatewayDraft.unified_analysis_enabled} onChange={(event) => setGatewayDraft((current) => current ? { ...current, unified_analysis_enabled: event.target.checked } : current)} />{t('启用 LibreChat 统一分析体连接', 'LibreChat統一分析体を有効化', 'Enable LibreChat unified analyst')}</label>
          <div className="ai-gateway-grid">
            <label><span>{t('LibreChat 地址', 'LibreChat アドレス', 'LibreChat address')}</span><input value={gatewayDraft.librechat_base_url} placeholder="http://127.0.0.1:3080" onChange={(event) => setGatewayDraft((current) => current ? { ...current, librechat_base_url: event.target.value } : current)} /></label>
            <label><span>{t('访问 Token（仅保存，不回显）', 'アクセストークン（保存のみ）', 'Access token (saved, never shown)')}</span><input type="password" autoComplete="new-password" name="enkei-librechat-token" value={gatewayDraft.librechat_api_key} placeholder={gateway?.api_key_set ? t('已保存；留空则保留', '保存済み。空欄で保持', 'Saved; leave blank to keep') : t('稍后填写', '後で入力', 'Add later')} onChange={(event) => setGatewayDraft((current) => current ? { ...current, librechat_api_key: event.target.value } : current)} /></label>
            {gatewayDraft.unified_analysis_enabled && <label><span>{t('统一分析体 Agent ID', '統合分析体 Agent ID', 'Unified analysis Agent ID')}</span><input value={gatewayDraft.unified_agent_id} placeholder={t('稍后由 LibreChat 提供；M5/M15 共用', '後でLibreChatから取得。M5/M15で共用', 'Provided by LibreChat later; shared by M5/M15')} onChange={(event) => setGatewayDraft((current) => current ? { ...current, unified_agent_id: event.target.value } : current)} /></label>}
            <label><span>{t('本地备用地址', 'ローカル予備アドレス', 'Local fallback address')}</span><input value={gatewayDraft.ollama_base_url} onChange={(event) => setGatewayDraft((current) => current ? { ...current, ollama_base_url: event.target.value } : current)} /></label>
            <label><span>{t('本地备用模型', 'ローカル予備モデル', 'Local fallback model')}</span><select value={gatewayDraft.ollama_fallback_model} onChange={(event) => setGatewayDraft((current) => current ? { ...current, ollama_fallback_model: event.target.value } : current)}><option value="">{t('不使用本地备用', 'ローカル予備を使わない', 'No local fallback')}</option>{models.filter((entry) => entry.deployment === 'local' && entry.available).map((entry) => { const value = entry.model_or_agent ?? entry.model ?? ''; return value ? <option key={value} value={value}>{entry.display_name ?? value}</option> : null; })}</select></label>
          </div>
          {!gatewayDraft.unified_analysis_enabled && <details className="ai-gateway-legacy"><summary>{t('兼容旧版：分别指定 M5 / M15 Agent', '旧版互換：M5 / M15 Agentを個別指定', 'Legacy compatibility: separate M5 / M15 agents')}</summary><div className="ai-gateway-grid"><label><span>M5 Agent ID</span><input value={gatewayDraft.m5_agent_id} placeholder={t('稍后由 LibreChat 提供', 'LibreChatから後で取得', 'Provided by LibreChat later')} onChange={(event) => setGatewayDraft((current) => current ? { ...current, m5_agent_id: event.target.value } : current)} /></label><label><span>M15 Agent ID</span><input value={gatewayDraft.m15_agent_id} placeholder={t('稍后由 LibreChat 提供', 'LibreChatから後で取得', 'Provided by LibreChat later')} onChange={(event) => setGatewayDraft((current) => current ? { ...current, m15_agent_id: event.target.value } : current)} /></label></div></details>}
          <label className="ai-gateway-fallback"><input type="checkbox" checked={gatewayDraft.local_fallback_enabled} onChange={(event) => setGatewayDraft((current) => current ? { ...current, local_fallback_enabled: event.target.checked } : current)} />{t('允许云端或 LibreChat 不可用时自动使用本地模型', 'クラウドまたはLibreChatが使えない時にローカルモデルへ自動切替', 'Use the local model automatically when the cloud route or LibreChat is unavailable')}</label>
          <div className="ai-gateway-actions"><button type="button" className="primary-btn" disabled={gatewayBusy !== null} onClick={() => void saveGateway()}>{gatewayBusy === 'save' ? t('保存中…', '保存中…', 'Saving…') : t('保存高级设置', '詳細設定を保存', 'Save advanced settings')}</button><button type="button" disabled={gatewayBusy !== null} onClick={() => void testGateway()}>{gatewayBusy === 'test' ? t('检测中…', '確認中…', 'Checking…') : t('检测高级连接', '詳細接続を確認', 'Check advanced connection')}</button></div>
          {gatewayBusy === 'test' && <div className="ai-gateway-test-progress" role="progressbar" aria-valuenow={testProgress} aria-valuemin={0} aria-valuemax={100}><div className="ai-gateway-test-track"><span style={{ width: `${testProgress}%` }} /></div><b>{Math.round(testProgress)}%</b><small>{t('正在探测所选模型/Agent 连通性；本地模型首次加载可能较慢。', '選択したモデル/Agentの接続を確認中。ローカルモデルの初回読み込みは時間がかかることがあります。', 'Probing the selected model/agent; the first local-model load can take longer.')}</small></div>}
          {gatewayTest && <p className="ai-gateway-test">{gatewayTest}</p>}</details>
        </div>}
      </details>

      {/* 统一模型目录：只展示终端确认过的模型/Agent，不直接管理供应商密钥。 */}
      <details className="ai-model-switch" open={modelPanelOpen} onToggle={(event) => setModelPanelOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>{t('模型目录与 AI 路由', 'モデル一覧とAIルーティング', 'Model catalogue and AI routing')}</summary>
        <div className="ai-model-switch-body">
          {!running && <p className="empty-state">{t('AI 终端会随圆衡自动启动；如已手动关闭，请先重新启动终端。', 'AI端末は円衡とともに自動起動します。手動停止した場合は先に再起動してください。', 'The AI terminal starts with Enkei. If you stopped it manually, start it again first.')}</p>}
          {running && !modelsLoaded && <p className="empty-state">{t('正在等待 AI 终端提供模型目录。网关未配置时不会显示虚假的可用模型。', 'AI端末のモデル一覧を待機中です。ゲートウェイ未設定時に利用可能なモデルを偽装しません。', 'Waiting for the terminal model catalogue. No model is presented as available until the gateway confirms it.')}</p>}
          {running && modelsLoaded && <>
            <div className="ai-model-catalog-toolbar">
              <label>{t('显示范围', '表示範囲', 'Show')}<select value={modelScope} onChange={(event) => setModelScope(event.target.value as 'available' | 'all')}><option value="available">{t('仅可用', '利用可能のみ', 'available')}</option><option value="all">{t('全部目录', 'すべて', 'all')}</option></select></label>
              <label>{t('排序方式', '並び順', 'Sort')}<select value={modelSort} onChange={(event) => { setModelSort(event.target.value as typeof modelSort); lastRefresh.current = 0; }}><option value="availability">{t('可用状态', '利用可能状態', 'availability')}</option><option value="provider">{t('提供商', 'プロバイダー', 'provider')}</option><option value="price">{t('价格档', '価格帯', 'price')}</option><option value="compute">{t('速度/算力', '速度/計算量', 'speed/compute')}</option></select></label>
            </div>
            <div className="ai-model-catalog-list">
              {visibleModels.length === 0 && <p className="empty-state">{t('当前筛选条件下没有可显示的模型。请先在 LibreChat 配置决策 Agent 或安装本地备用模型。', '現在の条件で表示できるモデルはありません。LibreChatで決定エージェントを設定するか、ローカル予備モデルを導入してください。', 'No model matches this filter. Configure a decision agent in LibreChat or install a local fallback model.')}</p>}
              {visibleModels.map((entry, index) => {
                const target = entry.model_or_agent ?? entry.agent_id ?? entry.model ?? '';
                const isLocal = entry.deployment === 'local' || entry.local === true;
                const isLibreChatAgent = entry.provider === 'librechat';
                const isCurrent = running && Boolean(target) && (isLocal
                  ? gateway?.local_fallback_enabled && gateway?.ollama_fallback_model === target
                  : isLibreChatAgent && (Boolean(gateway?.unified_analysis_enabled && gateway?.unified_agent_id === target) || (gateway?.m5_agent_id === target || gateway?.m15_agent_id === target)));
                return <article key={entry.id ?? entry.agent_id ?? entry.model_or_agent ?? entry.model ?? `${entry.provider}-${index}`} className={`${entry.available ? 'available' : ''}${isCurrent ? ' current' : ''}`}>
                  <div><b>{entry.display_name ?? entry.agent_id ?? entry.model_or_agent ?? entry.model ?? t('未命名模型', '名称未設定モデル', 'Unnamed model')}</b><span>{entry.provider ?? '—'} · {isLocal ? t('本地', 'ローカル', 'local') : t('在线', 'オンライン', 'cloud')}{isCurrent && <em className="ai-model-current-chip">{t('当前路由', '現在の経路', 'in use')}</em>}</span></div>
                  <span>{entry.available ? t('可用', '利用可', 'available') : t('未配置', '未設定', 'not configured')}</span>
                  <span>{entry.price_tier ?? '—'} · {entry.compute_tier ?? '—'}</span>
                  <span>{entry.recommended_timeframes?.join(' / ') ?? '—'}</span>
                  {entry.available && !isCurrent && (isLocal || isLibreChatAgent) && <button type="button" className="ai-model-apply" disabled={gatewayBusy !== null || !running} onClick={() => void applyModel(entry)}>{t(isLocal ? '设为本地备用' : '设为当前路由', isLocal ? 'ローカル予備に設定' : '現在の経路に設定', isLocal ? 'Set as fallback' : 'Set as active route')}</button>}
                  {entry.available && !isLocal && !isLibreChatAgent && <small>{t('请在 LibreChat 统一分析体中选择此模型。', 'このモデルはLibreChat統合分析体で選択します。', 'Select this model inside the LibreChat unified agent.')}</small>}
                  {isCurrent && <span className="ai-model-applied">{t('已生效', '適用済み', 'applied')}</span>}
                </article>;
              })}
            </div>
            <p className="ai-model-catalog-note">{t('这里显示的是已经被终端识别的模型，并不限制供应商数量。可在 LibreChat 中新增任意兼容 OpenAI 接口的模型供应商并加入统一分析体；刷新后会在本目录出现。直连配置只用于统一入口不可用时的受控降级，API 密钥仅保存在本机私有配置。', 'ここに表示されるのは端末が認識済みのモデルで、プロバイダー数を制限するものではありません。LibreChatでOpenAI互換の任意プロバイダーを追加して統合分析体に参加させると、更新後にこの一覧へ表示されます。直接設定は統合入口障害時の制御された予備経路に限り、APIキーはローカル非公開設定にのみ保存されます。', 'This catalogue shows models already discovered by the terminal; it does not limit provider count. Add any OpenAI-compatible provider in LibreChat and attach it to the unified agent, then refresh to see it here. Direct connections are controlled fallbacks only, and API keys remain in private local configuration.')} <a href="http://127.0.0.1:3080/agents" target="_blank" rel="noreferrer">{t('打开 LibreChat 配置供应商与统一分析体', 'LibreChatでプロバイダーと統合分析体を設定', 'Configure providers and the unified agent in LibreChat')}</a></p>
          </>}
        </div>
      </details>
    </details>
  );
}
