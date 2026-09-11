import type { PairSymbol } from './market-data';

/**
 * Contract for the optional local/online AI terminal.
 * Enkei never talks to Ollama or an online provider directly from the browser.
 * The terminal owns inference; this client only exchanges validated policies.
 */
export type AiProviderId = 'ollama' | 'deepseek' | 'openai' | 'qwen' | 'zhipu' | 'gemini' | 'minimax' | 'groq' | 'openrouter' | 'custom' | 'other';
export type AiTimeframe = 'M1' | 'M5' | 'M15';
export type AiMarketRegime = 'trend' | 'range' | 'volatile' | 'uncertain';
export type AiActionBias = 'long' | 'short' | 'wait' | 'close';

export interface AiPolicy {
  /** v1 is only retained so an in-flight local terminal can fail gracefully
   * during the v2 rollout. New policies are always expected to be v2. */
  version: 'enkei-ai-feedback/v1' | 'enkei-ai-feedback/v2';
  policy_id: string;
  request_id?: string;
  generated_at: string;
  expires_at: string;
  symbol: string;
  timeframe: AiTimeframe;
  provider: AiProviderId;
  model_id: string;
  model_version: string;
  market_regime: AiMarketRegime;
  action_bias: AiActionBias;
  confidence: number;
  recommended_model: string;
  entry_conditions: string[];
  scale_in_conditions: string[];
  exit_conditions: string[];
  invalidation: string;
  rationale_zh: string;
  rationale_ja?: string;
  rationale_en?: string;
  /**
   * Contract v2 carries short, already-selected news references.  The main
   * program deliberately treats them as display context, not as executable
   * instructions or a replacement for the fast market-data path.
   */
  news_context: string[];
  feature_summary?: { last_price?: number; spread_pips?: number };
}

export interface AiQuoteSummary {
  bid: number;
  ask: number;
  spread_pips: number;
  received_at: string;
}

export interface AiBarSummary {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AiMarketSummary {
  version: 'enkei-market-summary/v1';
  generated_at: string;
  symbol: string;
  timeframe: AiTimeframe;
  quote: AiQuoteSummary;
  features: {
    ema_fast: number;
    ema_slow: number;
    momentum: number;
    recent_high: number;
    recent_low: number;
    range_pips: number;
  };
  bars: AiBarSummary[];
  execution_context: {
    selected_rule_model: string;
    positions: Array<{ side: 'long' | 'short'; lots: number; open_price: number; profit: number }>;
    previous_policy: Pick<AiPolicy, 'action_bias' | 'expires_at'> | null;
  };
}

export interface AiTerminalStatus {
  state: 'idle' | 'updating' | 'ready' | 'unavailable' | 'invalid';
  detail: string;
  lastUpdatedAt: string | null;
  etag: string | null;
}

/**
 * The normalized gateway result.  This intentionally does not mirror a
 * LibreChat conversation or any individual provider response: the terminal
 * owns those details and the main program reads only this stable state.
 */
export interface AiState {
  state_id: string;
  version: string;
  symbol: string;
  timeframe: AiTimeframe;
  generated_at: string;
  valid_until: string;
  source: 'librechat' | 'ollama' | 'deepseek' | 'openai' | 'qwen' | 'zhipu' | 'gemini' | 'minimax' | 'groq' | 'openrouter' | 'custom' | 'none';
  provider: string;
  model_or_agent: string;
  regime: AiMarketRegime;
  direction: AiActionBias;
  confidence: number;
  key_levels: Record<string, number | string>;
  conditions: { entry: string[]; scale_in: string[]; exit: string[] };
  action_plan: { recommended_model: string; invalidation: string; rationale_zh: string };
  reassess_triggers: { timeframe: string; ttl_seconds: number };
  degraded: 'none' | 'fallback' | 'stale' | 'invalid';
  request_id: string;
  policy_reference: { policy_id: string; endpoint: string } | null;
}

export type AiDecisionEvent = {
  event_id: string;
  type: 'decision';
  policy_id: string;
  request_id?: string;
  symbol: string;
  timeframe: Exclude<AiTimeframe, 'M1'>;
  decision_generated_at: string;
  adopted: boolean;
  reject_reason: 'rule_conflict' | 'expired' | 'invalid' | 'missing' | null;
  final_action: AiActionBias | null;
  gate_summary: { rules_checked: number; rules_passed: number; blocked_by: string[] };
  ai_provider?: string;
  ai_model?: string;
  ai_model_version?: string;
  ai_direction?: AiActionBias;
  ai_confidence?: number;
  market_regime?: AiMarketRegime;
  strategy_model?: string;
  strategy_version?: string;
  strategy_score?: number;
  rationale?: string;
  invalidation?: string;
  evidence?: { news: string[]; feature_summary?: { last_price?: number; spread_pips?: number } };
  environment?: 'demo' | 'live';
};

export type AiOutcomeEvent = {
  event_id: string;
  type: 'outcome';
  policy_id: string;
  symbol: string;
  timeframe: Exclude<AiTimeframe, 'M1'>;
  direction: Extract<AiActionBias, 'long' | 'short'>;
  entry_price: number;
  exit_price: number;
  floating_pnl: number;
  closed_pnl: number;
  duration_seconds: number;
  opened_at: string;
  closed_at: string;
  spread_pips?: number;
  slippage_pips?: number;
  execution_reason?: string;
  environment?: 'demo' | 'live';
};

export type AiTerminalEvent = AiDecisionEvent | AiOutcomeEvent;

/** Event IDs are created at the edge of the browser outbox and are never reused. */
export function createAiEventId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
}

/** Marvis local AI terminal contract, loopback only. */
/**
 * The terminal is local, but its port is not a product constant.  Users may
 * run it beside another local AI application, so the UI keeps the selected
 * loopback endpoint in the browser and the fast execution path reads it on
 * every request.  This avoids a page reload or a hard-coded 8710 assumption.
 */
export const DEFAULT_AI_TERMINAL_URL = 'http://127.0.0.1:8710';
export const AI_TERMINAL_URL_STORAGE = 'enkei-ai-terminal-url';

export function normalizeAiTerminalUrl(value: string | null | undefined) {
  try {
    const url = new URL(String(value ?? DEFAULT_AI_TERMINAL_URL).trim());
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (!local || !url.port || !/^\d+$/.test(url.port)) return DEFAULT_AI_TERMINAL_URL;
    const port = Number(url.port);
    if (port < 1 || port > 65535) return DEFAULT_AI_TERMINAL_URL;
    return `${url.protocol}//${url.hostname}:${port}`;
  } catch {
    return DEFAULT_AI_TERMINAL_URL;
  }
}

export function resolveAiTerminalUrl() {
  if (typeof window === 'undefined') return DEFAULT_AI_TERMINAL_URL;
  return normalizeAiTerminalUrl(window.localStorage.getItem(AI_TERMINAL_URL_STORAGE));
}

export function saveAiTerminalUrl(value: string) {
  const url = normalizeAiTerminalUrl(value);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AI_TERMINAL_URL_STORAGE, url);
    window.dispatchEvent(new CustomEvent('enkei-ai-terminal-url-changed', { detail: url }));
  }
  return url;
}

export function toTerminalSymbol(symbol: PairSymbol | string) {
  return symbol.replace(/[^A-Za-z]/g, '').toUpperCase();
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Runtime validation keeps malformed small-model JSON outside the execution chain. */
export function parseAiPolicy(value: unknown): AiPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const policy = value as Record<string, unknown>;
  const allowedProviders: AiProviderId[] = ['ollama', 'deepseek', 'openai', 'qwen', 'zhipu', 'gemini', 'minimax', 'groq', 'openrouter', 'custom', 'other'];
  const regimes: AiMarketRegime[] = ['trend', 'range', 'volatile', 'uncertain'];
  const actions: AiActionBias[] = ['long', 'short', 'wait', 'close'];
  const timeframes: AiTimeframe[] = ['M1', 'M5', 'M15'];
  if (
    (policy.version !== 'enkei-ai-feedback/v1' && policy.version !== 'enkei-ai-feedback/v2') ||
    !isIso(policy.generated_at) || !isIso(policy.expires_at) ||
    typeof policy.symbol !== 'string' || !timeframes.includes(policy.timeframe as AiTimeframe) ||
    !allowedProviders.includes(policy.provider as AiProviderId) || typeof policy.model_id !== 'string' ||
    typeof policy.model_version !== 'string' || !regimes.includes(policy.market_regime as AiMarketRegime) ||
    !actions.includes(policy.action_bias as AiActionBias) || !Number.isFinite(policy.confidence) ||
    Number(policy.confidence) < 0 || Number(policy.confidence) > 100 ||
    toTerminalSymbol(policy.symbol) !== policy.symbol || policy.symbol.length !== 6 ||
    typeof policy.recommended_model !== 'string' || typeof policy.invalidation !== 'string' || typeof policy.rationale_zh !== 'string' ||
    !Array.isArray(policy.entry_conditions) || !policy.entry_conditions.every((item) => typeof item === 'string') ||
    !Array.isArray(policy.scale_in_conditions) || !policy.scale_in_conditions.every((item) => typeof item === 'string') ||
    !Array.isArray(policy.exit_conditions) || !policy.exit_conditions.every((item) => typeof item === 'string') ||
    (policy.version === 'enkei-ai-feedback/v2' && (typeof policy.policy_id !== 'string' || !policy.policy_id.trim() ||
      !Array.isArray(policy.news_context) || policy.news_context.length > 10 || !policy.news_context.every((item) => typeof item === 'string')))
  ) return null;
  return {
    ...policy,
    policy_id: typeof policy.policy_id === 'string' ? policy.policy_id : `${policy.provider}:${policy.model_id}:${policy.generated_at}:${policy.symbol}:${policy.timeframe}`,
    news_context: Array.isArray(policy.news_context) ? policy.news_context.filter((item): item is string => typeof item === 'string').slice(0, 10) : [],
  } as unknown as AiPolicy;
}

export function isActiveAiPolicy(policy: AiPolicy | null, now = Date.now()) {
  return Boolean(policy && Date.parse(policy.expires_at) > now);
}

export function parseAiState(value: unknown): AiState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  const sources = ['librechat', 'ollama', 'deepseek', 'openai', 'qwen', 'zhipu', 'gemini', 'minimax', 'groq', 'openrouter', 'custom', 'none'];
  const degraded = ['none', 'fallback', 'stale', 'invalid'];
  const regimes: AiMarketRegime[] = ['trend', 'range', 'volatile', 'uncertain'];
  const actions: AiActionBias[] = ['long', 'short', 'wait', 'close'];
  const timeframes: AiTimeframe[] = ['M1', 'M5', 'M15'];
  const list = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  const levels = state.key_levels;
  const conditions = state.conditions;
  const actionPlan = state.action_plan;
  const triggers = state.reassess_triggers;
  const policyReference = state.policy_reference;
  if (
    typeof state.state_id !== 'string' || !state.state_id.trim() ||
    typeof state.version !== 'string' || !state.version.trim() ||
    typeof state.symbol !== 'string' || toTerminalSymbol(state.symbol) !== state.symbol || state.symbol.length !== 6 ||
    !timeframes.includes(state.timeframe as AiTimeframe) || !isIso(state.generated_at) || !isIso(state.valid_until) ||
    !sources.includes(state.source as string) || typeof state.provider !== 'string' || typeof state.model_or_agent !== 'string' ||
    !regimes.includes(state.regime as AiMarketRegime) || !actions.includes(state.direction as AiActionBias) ||
    !Number.isFinite(state.confidence) || Number(state.confidence) < 0 || Number(state.confidence) > 100 ||
    !levels || typeof levels !== 'object' || Array.isArray(levels) ||
    !Object.values(levels as Record<string, unknown>).every((item) => typeof item === 'number' || typeof item === 'string') ||
    !conditions || typeof conditions !== 'object' || Array.isArray(conditions) ||
    !list((conditions as Record<string, unknown>).entry) || !list((conditions as Record<string, unknown>).scale_in) || !list((conditions as Record<string, unknown>).exit) ||
    !actionPlan || typeof actionPlan !== 'object' || Array.isArray(actionPlan) ||
    typeof (actionPlan as Record<string, unknown>).recommended_model !== 'string' ||
    typeof (actionPlan as Record<string, unknown>).invalidation !== 'string' ||
    typeof (actionPlan as Record<string, unknown>).rationale_zh !== 'string' ||
    !triggers || typeof triggers !== 'object' || Array.isArray(triggers) ||
    typeof (triggers as Record<string, unknown>).timeframe !== 'string' || !Number.isFinite((triggers as Record<string, unknown>).ttl_seconds) ||
    !degraded.includes(state.degraded as string) || typeof state.request_id !== 'string' ||
    !(policyReference === null || (typeof policyReference === 'object' && !Array.isArray(policyReference) &&
      typeof (policyReference as Record<string, unknown>).policy_id === 'string' && typeof (policyReference as Record<string, unknown>).endpoint === 'string'))
  ) return null;
  return state as unknown as AiState;
}

export function isActiveAiState(state: AiState | null, now = Date.now()) {
  // A valid cloud/local fallback result is still a real model judgment. Only
  // stale/invalid states are excluded from Demo composition.
  return Boolean(state && (state.degraded === 'none' || state.degraded === 'fallback') && Date.parse(state.valid_until) > now);
}

/**
 * The execution composer predates enkei-ai-state/v1 and consumes the stable
 * policy shape.  Keep that compatibility conversion at the terminal boundary
 * instead of making the fast execution path aware of any LibreChat details.
 */
export function stateToAiPolicy(state: AiState): AiPolicy {
  const directProvider = ['ollama', 'deepseek', 'openai', 'qwen', 'zhipu', 'gemini', 'minimax', 'groq', 'openrouter', 'custom'] as const;
  const provider: AiProviderId = directProvider.includes(state.source as typeof directProvider[number])
    ? state.source as AiProviderId : 'other';
  const rationale = state.action_plan.rationale_zh || state.conditions.entry.join('；') || 'AI 状态已更新。';
  return {
    version: 'enkei-ai-feedback/v2',
    policy_id: state.policy_reference?.policy_id || state.state_id,
    request_id: state.request_id,
    generated_at: state.generated_at,
    expires_at: state.valid_until,
    symbol: state.symbol,
    timeframe: state.timeframe,
    provider,
    model_id: state.model_or_agent,
    model_version: state.version,
    market_regime: state.regime,
    action_bias: state.direction,
    confidence: state.confidence,
    recommended_model: state.action_plan.recommended_model,
    entry_conditions: state.conditions.entry,
    scale_in_conditions: state.conditions.scale_in,
    exit_conditions: state.conditions.exit,
    invalidation: state.action_plan.invalidation,
    rationale_zh: rationale,
    news_context: [],
  };
}

export class AiTerminalClient {
  /** ETags are scoped to symbol + timeframe; never send an M5 validator to M15. */
  private readonly etags = new Map<string, string>();

  constructor(private readonly configuredUrl?: string) {}

  private get baseUrl() { return this.configuredUrl ? normalizeAiTerminalUrl(this.configuredUrl) : resolveAiTerminalUrl(); }

  async submitAssessment(summary: AiMarketSummary): Promise<AiTerminalStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/assessments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary),
      });
      if (response.status === 422) return { state: 'invalid', detail: 'assessment-schema-rejected', lastUpdatedAt: null, etag: null };
      if (!response.ok) return { state: 'unavailable', detail: `terminal-http-${response.status}`, lastUpdatedAt: null, etag: null };
      return { state: 'updating', detail: 'assessment-accepted', lastUpdatedAt: new Date().toISOString(), etag: null };
    } catch {
      return { state: 'unavailable', detail: 'terminal-unreachable', lastUpdatedAt: null, etag: null };
    }
  }

  async getCurrentPolicy(symbol: PairSymbol | string, timeframe: AiTimeframe): Promise<{ status: AiTerminalStatus; policy: AiPolicy | null }> {
    try {
      const terminalSymbol = toTerminalSymbol(symbol);
      const key = `${terminalSymbol}:${timeframe}`;
      const etag = this.etags.get(key) ?? null;
      const headers = etag ? { 'If-None-Match': etag } : undefined;
      const response = await fetch(`${this.baseUrl}/v1/policies/current?symbol=${encodeURIComponent(terminalSymbol)}&timeframe=${timeframe}`, { headers, cache: 'no-store' });
      if (response.status === 304) return { status: { state: 'ready', detail: 'policy-unchanged', lastUpdatedAt: null, etag }, policy: null };
      if (response.status === 404) return { status: { state: 'idle', detail: 'no-valid-policy', lastUpdatedAt: null, etag }, policy: null };
      if (!response.ok) return { status: { state: 'unavailable', detail: `terminal-http-${response.status}`, lastUpdatedAt: null, etag }, policy: null };
      const nextEtag = response.headers.get('ETag') ?? etag;
      if (nextEtag) this.etags.set(key, nextEtag);
      const policy = parseAiPolicy(await response.json());
      if (!policy) return { status: { state: 'invalid', detail: 'policy-schema-invalid', lastUpdatedAt: null, etag: nextEtag }, policy: null };
      if (policy.version !== 'enkei-ai-feedback/v2') {
        return { status: { state: 'invalid', detail: 'policy-v1-awaiting-v2', lastUpdatedAt: policy.generated_at, etag: nextEtag }, policy: null };
      }
      return { status: { state: isActiveAiPolicy(policy) ? 'ready' : 'invalid', detail: isActiveAiPolicy(policy) ? 'policy-ready' : 'policy-expired', lastUpdatedAt: policy.generated_at, etag: nextEtag }, policy };
    } catch {
      return { status: { state: 'unavailable', detail: 'terminal-unreachable', lastUpdatedAt: null, etag: null }, policy: null };
    }
  }

  /**
   * Prepared for the gateway rollout.  Existing execution still uses the
   * compatible policy endpoint until terminal-side contract tests pass.
   */
  async getCurrentState(symbol: PairSymbol | string, timeframe: AiTimeframe): Promise<{ status: AiTerminalStatus; state: AiState | null }> {
    try {
      const terminalSymbol = toTerminalSymbol(symbol);
      const key = `state:${terminalSymbol}:${timeframe}`;
      const etag = this.etags.get(key) ?? null;
      const headers = etag ? { 'If-None-Match': etag } : undefined;
      const response = await fetch(`${this.baseUrl}/v1/states/current?symbol=${encodeURIComponent(terminalSymbol)}&timeframe=${timeframe}`, { headers, cache: 'no-store' });
      if (response.status === 304) return { status: { state: 'ready', detail: 'state-unchanged', lastUpdatedAt: null, etag }, state: null };
      if (response.status === 404) return { status: { state: 'idle', detail: 'no-current-state', lastUpdatedAt: null, etag }, state: null };
      if (!response.ok) return { status: { state: 'unavailable', detail: `terminal-http-${response.status}`, lastUpdatedAt: null, etag }, state: null };
      const nextEtag = response.headers.get('ETag') ?? etag;
      if (nextEtag) this.etags.set(key, nextEtag);
      const state = parseAiState(await response.json());
      if (!state) return { status: { state: 'invalid', detail: 'state-schema-invalid', lastUpdatedAt: null, etag: nextEtag }, state: null };
      const active = isActiveAiState(state);
      return { status: { state: active ? 'ready' : 'invalid', detail: active ? 'state-ready' : `state-${state.degraded}`, lastUpdatedAt: state.generated_at, etag: nextEtag }, state };
    } catch {
      return { status: { state: 'unavailable', detail: 'terminal-unreachable', lastUpdatedAt: null, etag: null }, state: null };
    }
  }

  /**
   * Canonical evaluation storage belongs to the AI terminal. The main app only
   * delivers an idempotent event and never treats its browser cache as a ledger.
   */
  async submitEvaluationEvent(event: AiTerminalEvent): Promise<{ accepted: boolean; retryable: boolean; detail: string }> {
    try {
      const path = event.type === 'decision' ? 'decision' : 'outcome';
      const response = await fetch(`${this.baseUrl}/v1/events/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event.event_id },
        body: JSON.stringify(event),
      });
      if (response.ok || response.status === 409) return { accepted: true, retryable: false, detail: 'accepted' };
      // Only transient service failures remain in the retry queue.  A 422 is
      // a contract violation and must be visible rather than re-sent forever.
      if (response.status === 422) return { accepted: false, retryable: false, detail: 'terminal-event-schema-rejected' };
      if (response.status === 404) return { accepted: false, retryable: true, detail: 'terminal-event-endpoint-unavailable' };
      return { accepted: false, retryable: response.status >= 500, detail: `terminal-http-${response.status}` };
    } catch {
      return { accepted: false, retryable: true, detail: 'terminal-unreachable' };
    }
  }
}
