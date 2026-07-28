import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    UnauthorizedError,
    ForbiddenError,
    requireRole: vi.fn(),
  };
});

vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: auth.UnauthorizedError,
  ForbiddenError: auth.ForbiddenError,
  requireRole: auth.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      {
        status:
          error instanceof auth.UnauthorizedError
            ? 401
            : error instanceof auth.ForbiddenError
              ? 403
              : 500,
      }
    ),
}));

import { encodeChatMediaPath } from '@/lib/whatsapp/chat-media';
import { GET, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS } from './route';

const ownerPath = 'account-account-a/inbound/message-1.jpg';

function requestFor(path: string) {
  return GET(new Request('https://crm.test/api/whatsapp/media/value'), {
    params: Promise.resolve({ mediaId: encodeChatMediaPath(path) }),
  });
}

describe('GET /api/whatsapp/media/[mediaId]', () => {
  beforeEach(() => {
    auth.requireRole.mockReset();
  });

  it('denies unauthenticated media requests before opening storage', async () => {
    auth.requireRole.mockRejectedValue(new auth.UnauthorizedError('Unauthorized'));

    const response = await requestFor(ownerPath);

    expect(response.status).toBe(401);
  });

  it('denies cross-account storage paths without creating a signed URL', async () => {
    const createSignedUrl = vi.fn();
    auth.requireRole.mockResolvedValue({
      accountId: 'account-b',
      supabase: {
        storage: { from: vi.fn(() => ({ createSignedUrl })) },
      },
    });

    const response = await requestFor(ownerPath);

    expect(response.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('redirects the owning account to a short-lived signed URL', async () => {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://storage.example/signed-owner-media' },
      error: null,
    }));
    auth.requireRole.mockResolvedValue({
      accountId: 'account-a',
      supabase: {
        storage: { from: vi.fn(() => ({ createSignedUrl })) },
      },
    });

    const response = await requestFor(ownerPath);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://storage.example/signed-owner-media'
    );
    expect(CHAT_MEDIA_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(60);
    expect(createSignedUrl).toHaveBeenCalledWith(
      ownerPath,
      CHAT_MEDIA_SIGNED_URL_TTL_SECONDS
    );
  });
});
