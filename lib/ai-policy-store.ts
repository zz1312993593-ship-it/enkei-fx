import type { AiPolicy, AiTimeframe } from './ai-terminal';
import { isActiveAiPolicy, parseAiPolicy, toTerminalSymbol } from './ai-terminal';
import type { PairSymbol } from './market-data';

const STORAGE_KEY = 'enkei-ai-policy-cache/v1';
const MAX_POLICIES = 30;

function key(symbol: PairSymbol | string, timeframe: AiTimeframe) {
  return `${toTerminalSymbol(symbol)}:${timeframe}`;
}

function loadAll(): Record<string, AiPolicy> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      const policy = parseAiPolicy(value);
      return policy ? [[id, policy]] : [];
    }));
  } catch { return {}; }
}

function saveAll(policies: Record<string, AiPolicy>) {
  if (typeof window === 'undefined') return;
  const newest = Object.entries(policies)
    .sort(([, left], [, right]) => Date.parse(right.generated_at) - Date.parse(left.generated_at))
    .slice(0, MAX_POLICIES);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
}

export function loadAiPolicy(symbol: PairSymbol | string, timeframe: AiTimeframe) {
  const policy = loadAll()[key(symbol, timeframe)] ?? null;
  return isActiveAiPolicy(policy) ? policy : null;
}

export function saveAiPolicy(policy: AiPolicy) {
  const all = loadAll();
  all[key(policy.symbol, policy.timeframe)] = policy;
  saveAll(all);
}

export function removeExpiredAiPolicies(now = Date.now()) {
  const all = loadAll();
  const valid = Object.fromEntries(Object.entries(all).filter(([, policy]) => isActiveAiPolicy(policy, now)));
  saveAll(valid);
  return Object.keys(all).length - Object.keys(valid).length;
}
