import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const markConversationReadThrough = vi.fn();
  const resolveConfig = vi.fn();
  const markMessagesAsRead = vi.fn();
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'conversation-1',
                    whatsapp_config_id: 'config-1',
                    contact: { phone: '+55 11 99999-9999' },
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                not: () => ({
                  order: () => ({
                    limit: async () => ({ data: null, error: { message: 'read failed' } }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }),
    rpc: markConversationReadThrough,
  };
  return { markConversationReadThrough, resolveConfig, markMessagesAsRead, supabase };
});

vi.mock('@/lib/auth/account', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthorizedError: class UnauthorizedError extends Error {},
  requireRole: vi.fn(async () => ({ supabase: mocks.supabase, accountId: 'account-1' })),
  toErrorResponse: vi.fn(),
}));
vi.mock('@/lib/whatsapp/resolve-config', () => ({
  resolveActiveWhatsAppConfig: mocks.resolveConfig,
}));
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  markMessagesAsRead: mocks.markMessagesAsRead,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'api-key') }));

import { POST } from './route';

describe('POST conversation read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markConversationReadThrough.mockResolvedValue({ data: 0, error: null });
    mocks.resolveConfig.mockResolvedValue(null);
  });

  it('clears local unread state even when loading remote receipt messages fails', async () => {
    const response = await POST(new Request('https://crm.test/read', { method: 'POST' }), {
      params: Promise.resolve({ conversationId: 'conversation-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      transport_synced: false,
    });
    expect(mocks.markConversationReadThrough).toHaveBeenCalledWith(
      'mark_conversation_read_through',
      {
        conversation_id_arg: 'conversation-1',
        account_id_arg: 'account-1',
        read_count_arg: 0,
      }
    );
    expect(mocks.markMessagesAsRead).not.toHaveBeenCalled();
  });
});
