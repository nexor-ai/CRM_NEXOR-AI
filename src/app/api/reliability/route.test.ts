import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rpc = vi.fn();
  const single = vi.fn();
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { rpc, single, select, insert, from, requireRole: vi.fn() };
});

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: unknown) => Response.json({ error: String(error) }, { status: 500 }),
}));

import { POST } from './route';

describe('reliability recovery executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      userId: 'admin-1',
      supabase: { from: mocks.from, rpc: mocks.rpc },
    });
    mocks.single.mockResolvedValue({ data: { id: 'request-1', status: 'requested' }, error: null });
    mocks.rpc.mockResolvedValue({ data: { id: 'request-1', status: 'completed', outcome: { changed: 1 } }, error: null });
  });

  it('persists justification then executes the account-scoped allowlisted request', async () => {
    const response = await POST(new Request('https://crm.test/api/reliability', {
      method: 'POST',
      body: JSON.stringify({ kind: 'transcription', target_id: 'job-1', action: 'requeue', reason: 'falha revisada' }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'account-1', requested_by: 'admin-1', reason: 'falha revisada',
    }));
    expect(mocks.rpc).toHaveBeenCalledWith('execute_reliability_recovery_request', { p_request_id: 'request-1' });
  });

  it('rejects forbidden kind/action combinations before persistence', async () => {
    const response = await POST(new Request('https://crm.test/api/reliability', {
      method: 'POST',
      body: JSON.stringify({ kind: 'agent_run', target_id: 'run-1', action: 'retry_safe', reason: 'não repetir efeito' }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
