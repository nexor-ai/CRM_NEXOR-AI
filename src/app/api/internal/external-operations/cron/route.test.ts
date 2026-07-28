import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rpc = vi.fn();
  const complete = vi.fn();
  const execute = vi.fn();
  const store = {};
  return {
    rpc,
    complete,
    execute,
    store,
    admin: { rpc },
  };
});

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));
vi.mock('@/lib/external-operations/supabase-store', () => ({
  createExternalOperationStore: vi.fn(() => mocks.store),
}));
vi.mock('@/lib/external-operations/worker', () => ({
  executeSupportedExternalOperation: mocks.execute,
}));
vi.mock('@/lib/external-operations', () => ({
  completeClaimedExternalOperation: mocks.complete,
}));

import { POST } from './route';

const claim = {
  id: 'op-1',
  account_id: 'account-1',
  operation_type: 'send_message',
  payload: {},
  status: 'processing',
  fencing_token: 'fence-1',
};

function request(secret = 'test-secret') {
  return new Request('https://crm.test/api/internal/external-operations/cron', {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });
}

describe('external operations cron worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTOMATION_CRON_SECRET = 'test-secret';
    mocks.rpc.mockResolvedValue({ data: [claim], error: null });
    mocks.complete.mockImplementation(async (_store, operation, executor) => {
      await executor(operation);
      return { ...operation, status: 'succeeded' };
    });
    mocks.execute.mockResolvedValue({ result: { messageId: 'message-1' } });
  });

  it('rejects an invalid secret before claiming or dispatching work', async () => {
    const response = await POST(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('claims once and executes through the worker executor without route recursion', async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('claim_external_operations', {
      worker_limit: 5,
      operation_id_arg: null,
    });
    expect(mocks.complete).toHaveBeenCalledWith(mocks.store, claim, expect.any(Function));
    expect(mocks.execute).toHaveBeenCalledWith(mocks.admin, claim);
    expect(body).toMatchObject({ claimed: 1, succeeded: 1, state_write_failures: 0 });
  });

  it('reports a finalization/state-write failure instead of claiming success', async () => {
    mocks.complete.mockRejectedValueOnce(new Error('stale fencing token'));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ claimed: 1, succeeded: 0, state_write_failures: 1 });
  });
});
