import type { AiPolicy } from './ai-terminal';
import { isActiveAiPolicy } from './ai-terminal';
import type { StrategySignal } from './market-data';
import type { ResearchModel } from './model-catalog';

export type ComposedDecision = {
  action: 'long' | 'short' | 'wait' | 'close';
  authority: 'ai-and-rule' | 'ai-veto' | 'rule-fallback' | 'conflict-wait';
  effectiveModel: ResearchModel;
  rationale: string;
  /** Stable UI key.  The browser translates this instead of exposing engine English. */
  reasonCode: 'ai-policy-unavailable' | 'ai-veto-wait' | 'ai-veto-close' | 'rule-trigger-not-ready' | 'ai-rule-direction-conflict' | 'ai-rule-aligned';
  auditReason: string;
};

function validModel(value: string): value is ResearchModel {
  return ['trend-breakout', 'ema-cross', 'trend-pullback', 'range-reversion', 'momentum-pulse'].includes(value);
}

/**
 * AI has policy authority; the fast rule signal remains the live trigger.
 * This pure function deliberately has no network or order side effects.
 */
export function composeDecision(input: { signal: StrategySignal; selectedRuleModel: ResearchModel; policy: AiPolicy | null; now?: number }): ComposedDecision {
  const { signal, selectedRuleModel } = input;
  const policy = input.policy;
  const effectiveModel = policy && validModel(policy.recommended_model) ? policy.recommended_model : selectedRuleModel;
  if (!policy || !isActiveAiPolicy(policy, input.now)) {
    return {
      action: signal.direction,
      authority: 'rule-fallback',
      effectiveModel,
      rationale: 'AI policy unavailable or expired; fall back to the selected fast rule model.',
      reasonCode: 'ai-policy-unavailable',
      auditReason: 'ai-policy-missing-or-expired',
    };
  }
  if (policy.action_bias === 'wait' || policy.action_bias === 'close') {
    return { action: policy.action_bias, authority: 'ai-veto', effectiveModel, rationale: `AI policy ${policy.action_bias}: ${policy.rationale_zh}`, reasonCode: policy.action_bias === 'close' ? 'ai-veto-close' : 'ai-veto-wait', auditReason: `ai-veto-${policy.action_bias}` };
  }
  if (signal.direction === 'wait') {
    return { action: 'wait', authority: 'ai-and-rule', effectiveModel, rationale: `AI permits ${policy.action_bias}, but the fast rule trigger is not ready. ${policy.rationale_zh}`, reasonCode: 'rule-trigger-not-ready', auditReason: 'rule-trigger-not-ready' };
  }
  if (signal.direction !== policy.action_bias) {
    return { action: 'wait', authority: 'conflict-wait', effectiveModel, rationale: `AI policy is ${policy.action_bias} while the rule trigger is ${signal.direction}; wait for alignment. ${policy.rationale_zh}`, reasonCode: 'ai-rule-direction-conflict', auditReason: 'ai-rule-direction-conflict' };
  }
  return { action: signal.direction, authority: 'ai-and-rule', effectiveModel, rationale: `AI policy and fast rule both support ${signal.direction}. ${policy.rationale_zh}`, reasonCode: 'ai-rule-aligned', auditReason: 'ai-rule-aligned' };
}
