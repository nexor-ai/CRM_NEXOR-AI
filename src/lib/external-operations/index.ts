export type ExternalOperationStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'cancelled';

export type ExternalOperationRetryPolicy = 'retry_safe' | 'at_most_once';

export interface ExternalOperationRecord {
  id: string;
  account_id: string;
  whatsapp_config_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  operation_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: ExternalOperationStatus;
  attempts: number;
  max_attempts: number;
  retry_policy: ExternalOperationRetryPolicy;
  fencing_token: string | null;
  transport_id: string | null;
  result: Record<string, unknown> | null;
  last_error: string | null;
}

export interface EnqueueExternalOperationInput {
  accountId: string;
  whatsappConfigId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  operationType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  retryPolicy?: ExternalOperationRetryPolicy;
  maxAttempts?: number;
  requestedBy?: string | null;
}

export interface ExternalOperationStore {
  enqueue(input: EnqueueExternalOperationInput): Promise<ExternalOperationRecord>;
  claim(id: string): Promise<ExternalOperationRecord | null>;
  finalize(
    id: string,
    fencingToken: string,
    status: Extract<ExternalOperationStatus, 'succeeded' | 'failed' | 'uncertain' | 'cancelled'>,
    result: Record<string, unknown> | null,
    error: string | null,
    transportId: string | null,
  ): Promise<ExternalOperationRecord>;
}

export class ExternalOperationExecutionError extends Error {
  constructor(
    message: string,
    readonly effectState: 'pre_effect' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'ExternalOperationExecutionError';
  }
}

export type ExternalOperationExecutorResult = {
  transportId?: string | null;
  result?: Record<string, unknown> | null;
};

const SECRET_KEYS = /(?:api[_-]?key|authorization|cookie|password|secret|token|credential)/i;

export function sanitizeExternalValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeExternalValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEYS.test(key))
        .slice(0, 100)
        .map(([key, item]) => [key, sanitizeExternalValue(item, depth + 1)]),
    );
  }
  if (typeof value === 'string') return value.slice(0, 8_000);
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown external operation error';
  return message.replace(/(apikey|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 1_000);
}

function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof ExternalOperationExecutionError) return error.effectState === 'unknown';
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && /abort|timeout|timed out|fetch failed|socket|econnreset/i.test(error.message)) return true;
  return true;
}

export async function completeClaimedExternalOperation(
  store: ExternalOperationStore,
  claimed: ExternalOperationRecord,
  execute: (operation: ExternalOperationRecord) => Promise<ExternalOperationExecutorResult>,
): Promise<ExternalOperationRecord> {
  if (!claimed.fencing_token) throw new Error('Claimed external operation has no fencing token');
  try {
    const execution = await execute(claimed);
    return await store.finalize(
      claimed.id,
      claimed.fencing_token,
      'succeeded',
      sanitizeExternalValue(execution.result ?? {}) as Record<string, unknown>,
      null,
      execution.transportId?.slice(0, 512) ?? null,
    );
  } catch (error) {
    const status = isUnknownOutcome(error) ? 'uncertain' : 'failed';
    return store.finalize(claimed.id, claimed.fencing_token, status, null, safeError(error), null);
  }
}

export async function submitExternalOperation(
  store: ExternalOperationStore,
  input: EnqueueExternalOperationInput,
  execute: (operation: ExternalOperationRecord) => Promise<ExternalOperationExecutorResult>,
): Promise<ExternalOperationRecord> {
  const operation = await store.enqueue({
    ...input,
    payload: sanitizeExternalValue(input.payload) as Record<string, unknown>,
  });

  if (operation.status !== 'pending') return operation;

  const claimed = await store.claim(operation.id);
  if (!claimed) return operation;
  return completeClaimedExternalOperation(store, claimed, execute);
}
