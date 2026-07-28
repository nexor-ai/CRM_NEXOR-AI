import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  class UnauthorizedError extends Error {}
  return {
    ForbiddenError,
    UnauthorizedError,
    requireRole: vi.fn(),
    archiveChat: vi.fn(),
    markChatUnread: vi.fn(),
    fetchProfile: vi.fn(),
    fetchProfilePicture: vi.fn(),
    validateWhatsAppNumbers: vi.fn(),
    resolveConfig: vi.fn(),
    from: vi.fn(),
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
  archiveChat: mocks.archiveChat,
  markChatUnread: mocks.markChatUnread,
  fetchProfile: mocks.fetchProfile,
  fetchProfilePicture: mocks.fetchProfilePicture,
  validateWhatsAppNumbers: mocks.validateWhatsAppNumbers,
}));
vi.mock('@/lib/whatsapp/resolve-config', () => ({ resolveActiveWhatsAppConfig: mocks.resolveConfig }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'api-key') }));

import { POST } from './route';

function post(action = 'archive') {
  return POST(new Request('https://crm.test/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  }), { params: Promise.resolve({ conversationId: 'conversation-1' }) });
}

describe('conversation actions negative authorization paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks viewers before DB/config/provider effects', async () => {
    mocks.requireRole.mockRejectedValueOnce(new mocks.ForbiddenError('Insufficient role'));

    const response = await post();

    expect(response.status).toBe(403);
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.archiveChat).not.toHaveBeenCalled();
    expect(mocks.markChatUnread).not.toHaveBeenCalled();
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.validateWhatsAppNumbers).not.toHaveBeenCalled();
  });

  it('returns 404 for another account before config/provider effects', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })),
          })),
        })),
      })),
    };
    mocks.requireRole.mockResolvedValueOnce({ supabase, accountId: 'account-1', userId: 'agent-1' });

    const response = await post();

    expect(response.status).toBe(404);
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.archiveChat).not.toHaveBeenCalled();
    expect(mocks.markChatUnread).not.toHaveBeenCalled();
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.validateWhatsAppNumbers).not.toHaveBeenCalled();
  });
});
