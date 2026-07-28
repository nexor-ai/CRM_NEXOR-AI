import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const requireRole = vi.fn();
  const rpc = vi.fn();
  const selections: Array<{ table: string; columns: string }> = [];
  const rows: Record<string, unknown[]> = {
    evolution_webhook_events: [],
    evolution_message_effects: [],
    external_operations: [
      {
        id: 'op-1',
        operation_type: 'send_message',
        status: 'uncertain',
        retry_policy: 'at_most_once',
        attempts: 1,
        max_attempts: 1,
        last_error: 'timed out',
      },
    ],
  };

  function from(table: string) {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = vi.fn((value: string) => {
      selections.push({ table, columns: value });
      return builder;
    });
    for (const method of ['eq', 'in', 'order', 'limit']) builder[method] = vi.fn(chain);
    builder.then = (resolve: (value: unknown) => unknown) =>
      resolve({ data: rows[table] ?? [], error: null });
    return builder;
  }

  return {
    requireRole,
    rpc,
    selections,
    admin: { from: vi.fn(from), rpc },
  };
});

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  UnauthorizedError: class UnauthorizedError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  toErrorResponse: vi.fn(),
}));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));

import { GET, POST } from './route';

describe('WhatsApp reliability external operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selections.length = 0;
    mocks.requireRole.mockResolvedValue({ accountId: 'account-1', userId: 'admin-1' });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'external_operations_reliability_counts') {
        return { data: [{ pending: 1, processing: 0, failed: 0, uncertain: 1, dead_letter: 0 }], error: null };
      }
      if (name === 'retry_external_operation') {
        return { data: [{ id: 'op-1', account_id: 'account-1', status: 'pending', retry_policy: 'retry_safe' }], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
  });

  it('returns tenant counts and sanitized external operation items without raw payloads', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.external_operations.counts).toMatchObject({ pending: 1, uncertain: 1 });
    expect(body.external_operations.items).toHaveLength(1);
    const externalSelect = mocks.selections.find((entry) => entry.table === 'external_operations');
    expect(externalSelect?.columns).not.toMatch(/payload|result|idempotency_key|transport_id/);
  });

  it('confirms the persisted safe-retry row returned by the tenant-scoped RPC', async () => {
    const response = await POST(
      new Request('https://crm.test/api/whatsapp/reliability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'external_operation', id: 'op-1', action: 'retry' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('retry_external_operation', {
      operation_id_arg: 'op-1',
      account_id_arg: 'account-1',
      requested_by_arg: 'admin-1',
    });
    expect(body.item).toMatchObject({ id: 'op-1', account_id: 'account-1', status: 'pending' });
  });

  it('fails closed when the safe-retry RPC confirms zero persisted rows', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'retry_external_operation'
        ? { data: [], error: null }
        : { data: [], error: null },
    );
    const response = await POST(
      new Request('https://crm.test/api/whatsapp/reliability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'external_operation', id: 'op-1', action: 'retry' }),
      }),
    );

    expect(response.status).toBe(404);
  });
});
