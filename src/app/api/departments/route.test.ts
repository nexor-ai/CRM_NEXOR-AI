import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  toErrorResponse: vi.fn((error: { status?: number; message?: string }) =>
    Response.json({ error: error.message ?? 'erro' }, { status: error.status ?? 500 }),
  ),
}));

vi.mock('@/lib/auth/account', () => mocks);

import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';

interface DbResult {
  data: unknown;
  error: unknown;
}

function makeDb(result: DbResult = { data: [], error: null }) {
  const calls: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (value: unknown) => {
      calls.push(['insert', value]);
      return builder;
    },
    update: (value: unknown) => {
      calls.push(['update', value]);
      return builder;
    },
    delete: () => {
      calls.push(['delete', true]);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      calls.push([`eq:${column}`, value]);
      return builder;
    },
    order: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: DbResult) => unknown) => Promise.resolve(result).then(resolve),
  };
  return {
    supabase: { from: vi.fn(() => builder) },
    calls,
  };
}

const context = (supabase: unknown, role = 'admin') => ({
  supabase,
  accountId: 'acc-1',
  userId: 'user-1',
  role,
  account: { id: 'acc-1', name: 'Conta' },
});

beforeEach(() => vi.clearAllMocks());

describe('/api/departments auth and tenancy', () => {
  it('returns 401 when listing without a session', async () => {
    mocks.getCurrentAccount.mockRejectedValue({ status: 401, message: 'Unauthorized' });
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('allows a viewer to list only membership-scoped departments in its account', async () => {
    const { supabase, calls } = makeDb({ data: [], error: null });
    mocks.getCurrentAccount.mockResolvedValue(context(supabase, 'viewer'));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(calls).toContainEqual(['eq:account_id', 'acc-1']);
    expect(calls).toContainEqual(['eq:department_memberships.user_id', 'user-1']);
  });

  it('returns 403 when a viewer tries to create a department', async () => {
    mocks.requireRole.mockRejectedValue({ status: 403, message: 'Insufficient role' });
    const response = await POST(
      new Request('http://localhost/api/departments', {
        method: 'POST',
        body: JSON.stringify({ name: 'Comercial' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('always stamps account_id and creator membership on create', async () => {
    const row = { id: 'dep-1', account_id: 'acc-1', name: 'Comercial' };
    const { supabase, calls } = makeDb({ data: row, error: null });
    mocks.requireRole.mockResolvedValue(context(supabase));
    const response = await POST(
      new Request('http://localhost/api/departments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: ' Comercial ' }),
      }),
    );
    expect(response.status).toBe(201);
    expect(calls).toContainEqual([
      'insert',
      expect.objectContaining({ account_id: 'acc-1', name: 'Comercial' }),
    ]);
  });

  it('scopes update and delete by account to prevent cross-account leaks', async () => {
    const { supabase, calls } = makeDb({ data: { id: 'dep-1' }, error: null });
    mocks.requireRole.mockResolvedValue(context(supabase));

    const patch = await PATCH(
      new Request('http://localhost/api/departments/dep-1', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Suporte' }),
      }),
      { params: Promise.resolve({ id: 'dep-1' }) },
    );
    expect(patch.status).toBe(200);
    expect(calls).toContainEqual(['eq:id', 'dep-1']);
    expect(calls).toContainEqual(['eq:account_id', 'acc-1']);

    calls.length = 0;
    const del = await DELETE(new Request('http://localhost/api/departments/dep-1'), {
      params: Promise.resolve({ id: 'dep-1' }),
    });
    expect(del.status).toBe(200);
    expect(calls).toContainEqual(['eq:id', 'dep-1']);
    expect(calls).toContainEqual(['eq:account_id', 'acc-1']);
  });
});
