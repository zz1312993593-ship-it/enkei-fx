import { AiTerminalClient, type AiTerminalEvent } from './ai-terminal';

const KEY = 'enkei-ai-evaluation-outbox/v1';
const MAX_ITEMS = 300;
let activeFlush: Promise<{ delivered: number; pending: number; waiting: number; newestError: string | null }> | null = null;

export type EvaluationOutboxItem = AiTerminalEvent & {
  attempts: number;
  last_attempt_at?: string;
  last_error?: string;
};

function read(): EvaluationOutboxItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown[];
    return value.filter((item): item is EvaluationOutboxItem => Boolean(item && typeof item === 'object' &&
      typeof (item as EvaluationOutboxItem).event_id === 'string' &&
      ((item as EvaluationOutboxItem).type === 'decision' || (item as EvaluationOutboxItem).type === 'outcome')));
  } catch { return []; }
}

function write(items: EvaluationOutboxItem[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
}

export function pendingEvaluationEvents() { return read(); }

/** Events survive a page switch, but are never presented as an official ledger. */
export function enqueueEvaluationEvent(event: AiTerminalEvent) {
  const items = read();
  if (!items.some((item) => item.event_id === event.event_id)) {
    items.push({ ...event, attempts: 0 });
    write(items);
  }
}

async function runFlush(client: AiTerminalClient) {
  const current = read();
  const kept: EvaluationOutboxItem[] = [];
  let delivered = 0;
  let waiting = 0;
  for (const item of current) {
    const result = await client.submitEvaluationEvent(item);
    if (result.accepted) { delivered += 1; continue; }
    const next = { ...item, attempts: item.attempts + 1, last_attempt_at: new Date().toISOString(), last_error: result.detail };
    // Non-retryable errors are retained for visible diagnosis. They must be
    // corrected by the terminal contract, not silently discarded by the UI.
    kept.push(next);
    if (result.retryable) waiting += 1;
  }
  write(kept);
  return { delivered, pending: kept.length, waiting, newestError: kept.at(-1)?.last_error ?? null };
}

/** All mounted views share one delivery pass, preventing duplicate concurrent replays. */
export function flushEvaluationOutbox(client: AiTerminalClient) {
  if (activeFlush) return activeFlush;
  activeFlush = runFlush(client).finally(() => { activeFlush = null; });
  return activeFlush;
}
