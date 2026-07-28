import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  const requireRole = vi.fn();
  const sendReactionMessage = vi.fn();
  const resolveConfig = vi.fn();

  let conversation: Record<string, unknown> | null = null;
  const supabase = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'legacy-user' } }, error: null })),
    },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return chain({ account_id: 'account-1' });
      }
      if (table === 'messages') {
        return chain({
          id: 'message-1',
          message_id: 'wa-message-1',
          conversation_id: 'conversation-1',
          sender_type: 'customer',
        });
      }
      if (table === 'conversations') return chain(conversation);
      if (table === 'message_reactions') return mutationChain();
      throw new Error(`Unexpected table ${table}`);
    }),
  };

  function chain(data: unknown) {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const method of ['select', 'eq']) builder[method] = vi.fn(self);
    builder.maybeSingle = vi.fn(async () => ({ data, error: null }));
    return builder;
  }

  function mutationChain() {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const method of ['delete', 'eq']) builder[method] = vi.fn(self);
    builder.upsert = vi.fn(async () => ({ error: null }));
    builder.then = (resolve: (value: unknown) => unknown) => resolve({ error: null });
    return builder;
  }

  return {
    UnauthorizedError,
    ForbiddenError,
    requireRole,
    sendReactionMessage,
    resolveConfig,
    supabase,
    setConversation(value: Record<string, unknown> | null) {
      conversation = value;
    },
  };
});

vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: mocks.UnauthorizedError,
  ForbiddenError: mocks.ForbiddenError,
  requireRole: mocks.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      {
        status:
          error instanceof mocks.UnauthorizedError
            ? 401
            : error instanceof mocks.ForbiddenError
              ? 403
              : 500,
      }
    ),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => mocks.supabase) }));
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  sendReactionMessage: mocks.sendReactionMessage,
}));
vi.mock('@/lib/whatsapp/resolve-config', () => ({
  resolveActiveWhatsAppConfig: mocks.resolveConfig,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'api-key') }));
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: vi.fn((phone: string) => phone.replace(/\D/g, '')),
}));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { react: {} },
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/external-operations/supabase-store', () => ({
  createExternalOperationStore: vi.fn(() => ({})),
  operationHttpStatus: vi.fn(() => 202),
}));
vi.mock('@/lib/external-operations', () => ({
  submitExternalOperation: vi.fn(async (_store, input, execute) => {
    const execution = await execute({ id: 'operation-1', payload: input.payload });
    return { id: 'operation-1', status: 'succeeded', attempts: 1, result: execution.result };
  }),
}));

import { POST } from './route';

function request() {
  return new Request('https://crm.test/api/whatsapp/react', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_id: 'message-1', emoji: '👍' }),
  });
}

describe('POST /api/whatsapp/react authorization and scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setConversation({
      id: 'conversation-1',
      account_id: 'account-1',
      whatsapp_config_id: 'config-1',
      contact: { phone: '+55 11 99999-9999' },
    });
    mocks.requireRole.mockResolvedValue({
      supabase: mocks.supabase,
      accountId: 'account-1',
      userId: 'agent-1',
      role: 'agent',
    });
    mocks.resolveConfig.mockResolvedValue({
      id: 'config-1',
      account_id: 'account-1',
      evolution_base_url: 'https://evolution.test',
      evolution_instance: 'instance-1',
      evolution_api_key: 'encrypted-key',
    });
    mocks.sendReactionMessage.mockResolvedValue({ messageId: 'reaction-1' });
  });

  it('returns 401 before opening data/provider paths when unauthenticated', async () => {
    mocks.requireRole.mockRejectedValueOnce(new mocks.UnauthorizedError('Unauthorized'));

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.supabase.from).not.toHaveBeenCalled();
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.sendReactionMessage).not.toHaveBeenCalled();
  });

  it('returns 403 and never calls the provider for a viewer', async () => {
    mocks.requireRole.mockRejectedValueOnce(new mocks.ForbiddenError('Insufficient role'));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.supabase.from).not.toHaveBeenCalled();
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.sendReactionMessage).not.toHaveBeenCalled();
  });

  it('returns 404 and never resolves config/provider for a cross-account conversation', async () => {
    mocks.setConversation(null);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.sendReactionMessage).not.toHaveBeenCalled();
  });

  it('returns 404 and never calls the provider for a cross-account config', async () => {
    mocks.resolveConfig.mockResolvedValueOnce({
      id: 'foreign-config',
      account_id: 'account-2',
      evolution_base_url: 'https://foreign-evolution.test',
      evolution_instance: 'foreign-instance',
      evolution_api_key: 'foreign-encrypted-key',
    });

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.sendReactionMessage).not.toHaveBeenCalled();
  });

  it('uses the account context and sends a reaction after full ownership preflight', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.resolveConfig).toHaveBeenCalledWith(
      mocks.supabase,
      'account-1',
      { preferConfigId: 'config-1' }
    );
    expect(mocks.sendReactionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: 'instance-1',
        to: '5511999999999',
        targetMessageId: 'wa-message-1',
        emoji: '👍',
      })
    );
  });
});
