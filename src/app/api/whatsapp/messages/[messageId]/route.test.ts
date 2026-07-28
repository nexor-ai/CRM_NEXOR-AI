import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  class UnauthorizedError extends Error {}
  return {
    ForbiddenError,
    UnauthorizedError,
    requireRole: vi.fn(),
    editMessage: vi.fn(),
    deleteMessageForEveryone: vi.fn(),
    resolveConfig: vi.fn(),
  };
});

vi.mock('@/lib/auth/account', () => ({
  ForbiddenError: mocks.ForbiddenError,
  UnauthorizedError: mocks.UnauthorizedError,
  requireRole: mocks.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json({ error: error instanceof Error ? error.message : 'error' }, {
      status: error instanceof mocks.UnauthorizedError ? 401 : 403,
    }),
}));
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  editMessage: mocks.editMessage,
  deleteMessageForEveryone: mocks.deleteMessageForEveryone,
}));
vi.mock('@/lib/whatsapp/resolve-config', () => ({ resolveActiveWhatsAppConfig: mocks.resolveConfig }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'api-key') }));

import { DELETE, PATCH } from './route';

const context = { params: Promise.resolve({ messageId: 'message-1' }) };
function patchRequest() {
  return new Request('https://crm.test/messages/message-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'updated' }),
  });
}

describe('message mutation negative authorization paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['PATCH', () => PATCH(patchRequest(), context)],
    ['DELETE', () => DELETE(new Request('https://crm.test/messages/message-1', { method: 'DELETE' }), context)],
  ])('blocks viewers before provider effects for %s', async (_method, invoke) => {
    mocks.requireRole.mockRejectedValueOnce(new mocks.ForbiddenError('Insufficient role'));

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.editMessage).not.toHaveBeenCalled();
    expect(mocks.deleteMessageForEveryone).not.toHaveBeenCalled();
  });

  it.each([
    ['PATCH', () => PATCH(patchRequest(), context)],
    ['DELETE', () => DELETE(new Request('https://crm.test/messages/message-1', { method: 'DELETE' }), context)],
  ])('returns 404 cross-account before provider effects for %s', async (_method, invoke) => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })),
          })),
        })),
      })),
    };
    mocks.requireRole.mockResolvedValueOnce({
      supabase,
      accountId: 'account-1',
      userId: 'agent-1',
    });

    const response = await invoke();

    expect(response.status).toBe(404);
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.editMessage).not.toHaveBeenCalled();
    expect(mocks.deleteMessageForEveryone).not.toHaveBeenCalled();
  });
});
