import { describe, expect, it, vi } from 'vitest';

import {
  ExternalOperationExecutionError,
  submitExternalOperation,
  type ExternalOperationRecord,
  type ExternalOperationStore,
} from './index';

const base: ExternalOperationRecord = {
  id: 'op-1',
  account_id: 'account-1',
  whatsapp_config_id: 'config-1',
  conversation_id: 'conversation-1',
  message_id: null,
  operation_type: 'send_message',
  idempotency_key: 'request-1',
  payload: { conversationId: 'conversation-1', messageType: 'text', contentText: 'hello' },
  status: 'pending',
  attempts: 0,
  max_attempts: 1,
  retry_policy: 'at_most_once',
  fencing_token: null,
  transport_id: null,
  result: null,
  last_error: null,
};

function store(overrides: Partial<ExternalOperationStore> = {}): ExternalOperationStore {
  return {
    enqueue: vi.fn(async () => base),
    claim: vi.fn(async () => ({ ...base, status: 'processing' as const, attempts: 1, fencing_token: 'token-1' })),
    finalize: vi.fn(async (_id, _token, status, result) => ({ ...base, status, result })),
    ...overrides,
  };
}

describe('durable external operations', () => {
  it('persists and claims the intention before invoking the provider', async () => {
    const order: string[] = [];
    const operationStore = store({
      enqueue: vi.fn(async () => { order.push('enqueue'); return base; }),
      claim: vi.fn(async () => { order.push('claim'); return { ...base, status: 'processing' as const, fencing_token: 'token-1' }; }),
      finalize: vi.fn(async (_id, _token, status, result) => { order.push(`finalize:${status}`); return { ...base, status, result }; }),
    });

    const outcome = await submitExternalOperation(operationStore, {
      accountId: 'account-1', operationType: 'send_message', idempotencyKey: 'request-1',
      whatsappConfigId: 'config-1', conversationId: 'conversation-1', payload: base.payload,
    }, async () => { order.push('provider'); return { transportId: 'wa-1', result: { messageId: 'msg-1' } }; });

    expect(order).toEqual(['enqueue', 'claim', 'provider', 'finalize:succeeded']);
    expect(outcome.status).toBe('succeeded');
  });

  it('never invokes the provider when intention persistence fails', async () => {
    const provider = vi.fn();
    const operationStore = store({ enqueue: vi.fn(async () => { throw new Error('db unavailable'); }) });
    await expect(submitExternalOperation(operationStore, {
      accountId: 'account-1', operationType: 'send_message', idempotencyKey: 'request-1', payload: {},
    }, provider)).rejects.toThrow('db unavailable');
    expect(provider).not.toHaveBeenCalled();
  });

  it('marks a timeout after dispatch as uncertain and does not retry automatically', async () => {
    const operationStore = store();
    const provider = vi.fn(async () => { throw new DOMException('timed out', 'AbortError'); });
    const outcome = await submitExternalOperation(operationStore, {
      accountId: 'account-1', operationType: 'send_message', idempotencyKey: 'request-1', payload: {},
    }, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(operationStore.finalize).toHaveBeenCalledWith('op-1', 'token-1', 'uncertain', null, expect.any(String), null);
    expect(outcome.status).toBe('uncertain');
  });

  it('replays a succeeded idempotency key without invoking the provider', async () => {
    const provider = vi.fn();
    const succeeded = { ...base, status: 'succeeded' as const, result: { messageId: 'msg-1' }, transport_id: 'wa-1' };
    const operationStore = store({ enqueue: vi.fn(async () => succeeded) });
    const outcome = await submitExternalOperation(operationStore, {
      accountId: 'account-1', operationType: 'send_message', idempotencyKey: 'request-1', payload: {},
    }, provider);
    expect(provider).not.toHaveBeenCalled();
    expect(outcome).toEqual(succeeded);
  });

  it('returns the durable pending state when claim changes zero rows', async () => {
    const provider = vi.fn();
    const operationStore = store({ claim: vi.fn(async () => null) });
    const outcome = await submitExternalOperation(operationStore, {
      accountId: 'account-1', operationType: 'send_message', idempotencyKey: 'request-1', payload: {},
    }, provider);
    expect(provider).not.toHaveBeenCalled();
    expect(outcome.status).toBe('pending');
  });

  it('classifies only proven pre-effect failures as failed', async () => {
    const operationStore = store();
    const outcome = await submitExternalOperation(operationStore, {
      accountId: 'account-1', operationType: 'reaction', idempotencyKey: 'request-1', payload: {},
    }, async () => { throw new ExternalOperationExecutionError('invalid local target', 'pre_effect'); });
    expect(operationStore.finalize).toHaveBeenCalledWith('op-1', 'token-1', 'failed', null, 'invalid local target', null);
    expect(outcome.status).toBe('failed');
  });
});
