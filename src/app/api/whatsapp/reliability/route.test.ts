import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    UnauthorizedError,
    ForbiddenError,
    requireRole: vi.fn(),
    supabaseAdmin: vi.fn(),
    update: vi.fn(),
  };
});

vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: mocks.UnauthorizedError,
  ForbiddenError: mocks.ForbiddenError,
  requireRole: mocks.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: error instanceof mocks.UnauthorizedError ? 401 : 403 }
    ),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { GET, POST } from './route';

function recoveryBuilder() {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['eq', 'in', 'select']) builder[method] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({
    data: { id: 'effect-1', status: 'failed', manual_retry_at: 'now' },
    error: null,
  }));
  return builder;
}

describe('WhatsApp reliability administration', () => {
  let builder: ReturnType<typeof recoveryBuilder>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: 'admin-1', accountId: 'account-1' });
    builder = recoveryBuilder();
    mocks.update.mockReturnValue(builder);
    mocks.supabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({ update: mocks.update })),
    });
  });

  it('rejects a non-admin before opening the service-role client', async () => {
    mocks.requireRole.mockRejectedValueOnce(new mocks.ForbiddenError('Admin required'));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
  });

  it('records an explicit manual retry request for an uncertain effect', async () => {
    const response = await POST(
      new Request('https://crm.test/api/whatsapp/reliability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'effect', id: 'effect-1', action: 'retry' }),
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        last_error: 'Nova tentativa manual aprovada por admin-1',
        manual_retry_at: expect.any(String),
      })
    );
    expect(builder.eq).toHaveBeenCalledWith('account_id', 'account-1');
    expect(builder.eq).toHaveBeenCalledWith('retry_policy', 'retry_safe');
  });
});
