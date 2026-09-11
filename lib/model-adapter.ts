export type LocalAdvisorInput = {
  symbol: string;
  timeframe: 'M1' | 'M5' | 'M15';
  selectedModel: string;
  signalScore: number;
  direction: 'long' | 'short' | 'wait';
};

export type AdvisorProviderId = 'deepseek' | 'openai' | 'qwen' | 'ollama';

export interface AdvisorProviderDefinition {
  id: AdvisorProviderId;
  zh: string;
  ja: string;
  en: string;
  roleZh: string;
  roleJa: string;
  roleEn: string;
  location: 'cloud' | 'local';
}

export interface AdvisorPoolConfig {
  quickProvider: AdvisorProviderId;
  deepProvider: AdvisorProviderId;
  fallbackProvider: AdvisorProviderId;
}

// Configuration only: this module never stores an API key and never sends a
// market request. A later, explicit connection must preserve this boundary.
export const ADVISOR_PROVIDERS: AdvisorProviderDefinition[] = [
  { id: 'deepseek', zh: 'DeepSeek（在线）', ja: 'DeepSeek（オンライン）', en: 'DeepSeek (online)', roleZh: '默认快速研究与市场摘要', roleJa: '標準の高速リサーチと相場要約', roleEn: 'Default fast research and market summaries', location: 'cloud' },
  { id: 'openai', zh: 'GPT / OpenAI（在线）', ja: 'GPT / OpenAI（オンライン）', en: 'GPT / OpenAI (online)', roleZh: '复杂复盘与深度推理', roleJa: '複雑な振り返りと深い推論', roleEn: 'Complex review and deep reasoning', location: 'cloud' },
  { id: 'qwen', zh: '通义千问 Qwen（在线）', ja: '通義千問 Qwen（オンライン）', en: 'Qwen (online)', roleZh: '中文市场资料与备用研究', roleJa: '中国語の市場資料と予備リサーチ', roleEn: 'Chinese-language market material and backup research', location: 'cloud' },
  { id: 'ollama', zh: '本地 Qwen / Ollama', ja: 'ローカル Qwen / Ollama', en: 'Local Qwen / Ollama', roleZh: '离线说明与低成本备用', roleJa: 'オフライン説明と低コストの予備', roleEn: 'Offline explanations and low-cost fallback', location: 'local' },
];

export function advisorName(provider: AdvisorProviderDefinition, language: 'zh' | 'ja' | 'en'): string {
  return language === 'zh' ? provider.zh : language === 'ja' ? provider.ja : provider.en;
}

export function advisorRole(provider: AdvisorProviderDefinition, language: 'zh' | 'ja' | 'en'): string {
  return language === 'zh' ? provider.roleZh : language === 'ja' ? provider.roleJa : provider.roleEn;
}

export const DEFAULT_ADVISOR_POOL: AdvisorPoolConfig = {
  quickProvider: 'deepseek',
  deepProvider: 'openai',
  fallbackProvider: 'ollama',
};

export function advisorProvider(id: AdvisorProviderId) {
  return ADVISOR_PROVIDERS.find((provider) => provider.id === id) ?? ADVISOR_PROVIDERS[0];
}

export function normaliseAdvisorPool(value: unknown): AdvisorPoolConfig {
  const saved = value && typeof value === 'object' ? value as Partial<AdvisorPoolConfig> : {};
  const valid = (id: unknown, fallback: AdvisorProviderId): AdvisorProviderId => ADVISOR_PROVIDERS.some((provider) => provider.id === id) ? id as AdvisorProviderId : fallback;
  return {
    quickProvider: valid(saved.quickProvider, DEFAULT_ADVISOR_POOL.quickProvider),
    deepProvider: valid(saved.deepProvider, DEFAULT_ADVISOR_POOL.deepProvider),
    fallbackProvider: valid(saved.fallbackProvider, DEFAULT_ADVISOR_POOL.fallbackProvider),
  };
}

export function loadAdvisorPool(): AdvisorPoolConfig {
  if (typeof window === 'undefined') return DEFAULT_ADVISOR_POOL;
  try { return normaliseAdvisorPool(JSON.parse(window.localStorage.getItem('enkei-advisor-pool') ?? 'null')); } catch { return DEFAULT_ADVISOR_POOL; }
}

export type LocalAdvisorRecommendation = {
  action: 'long' | 'short' | 'wait' | 'close';
  confidence: number;
  rationale: string;
  marketRegime?: 'trend' | 'range' | 'volatile' | 'uncertain';
  invalidation?: string;
  expiresAt?: string;
  riskNotes?: string[];
};

// Deliberately adapter-only: the current release makes no network request and
// never gives a future local model an account credential or a pairing code.
// A local model can later implement this shape behind an explicit user toggle.
export const localAdvisorIntegration = {
  id: 'local-advisor-adapter/v1',
  state: 'reserved' as const,
  dataBoundary: 'market-and-research-only' as const,
  executionAuthority: 'none' as const,
  assess: async (input: LocalAdvisorInput): Promise<LocalAdvisorRecommendation | null> => { void input; return null; },
};
