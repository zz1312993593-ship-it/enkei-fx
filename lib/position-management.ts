import type { AiPolicy } from './ai-terminal';
export type PositionManagementDecision = { action: 'hold' | 'close-all'; classification: 'continuation' | 'pullback' | 'confirmed-reversal' | 'explicit-exit'; reason: string };
export function decidePositionManagement(current: AiPolicy, confirmation: AiPolicy | null, sides: string[]): PositionManagementDecision {
  if (!sides.length) return { action: 'hold', classification: 'continuation', reason: 'No open position.' };
  if (current.action_bias === 'close' && current.confidence >= 65) return { action: 'close-all', classification: 'explicit-exit', reason: `AI explicitly requested exit at ${current.confidence}% confidence.` };
  const opposite = (current.action_bias === 'long' || current.action_bias === 'short') && sides.some((side) => side !== current.action_bias);
  if (!opposite) return { action: 'hold', classification: 'continuation', reason: 'AI direction remains aligned with the open position.' };
  const confirmed = confirmation && confirmation.action_bias === current.action_bias && confirmation.confidence >= 60;
  const structural = current.market_regime === 'trend' || current.market_regime === 'volatile';
  if (current.confidence >= 70 && structural && confirmed) return { action: 'close-all', classification: 'confirmed-reversal', reason: `Opposite ${current.market_regime} direction confirmed across M5/M15 (${current.confidence}%/${confirmation.confidence}%).` };
  return { action: 'hold', classification: 'pullback', reason: 'Opposite move lacks cross-timeframe structural confirmation; treated as a pullback.' };
}
