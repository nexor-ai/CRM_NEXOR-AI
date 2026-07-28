import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const transportMocks = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock('@/lib/whatsapp/evolution-api', () => ({
  INTERACTIVE_LIMITS: {
    maxButtons: 3,
    buttonTitleMaxLength: 20,
    maxListSections: 10,
    maxListRowsTotal: 10,
    listRowTitleMaxLength: 24,
    listRowDescriptionMaxLength: 72,
  },
  sendTemplateMessage: transportMocks.sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendContactMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  sendLocationMessage: vi.fn(),
  sendPollMessage: vi.fn(),
  sendStickerMessage: vi.fn(),
}));
vi.mock('@/lib/whatsapp/resolve-config', () => ({
  resolveActiveWhatsAppConfig: transportMocks.resolveConfig,
  whatsappTrace: vi.fn(() => ({})),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'api-key'),
  encrypt: vi.fn(() => 'encrypted-key'),
  isLegacyFormat: vi.fn(() => false),
}));

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('sendMessageToConversation — template presets fail closed', () => {
  const conversation = {
    id: 'cv-1',
    account_id: 'acct-1',
    whatsapp_config_id: 'config-1',
    contact: { id: 'contact-1', phone: '+15551234567' },
  };

  function templateDb(template: Record<string, unknown> | null): SupabaseClient {
    return {
      from: vi.fn((table: string) => {
        const data = table === 'conversations' ? conversation : template;
        const builder: Record<string, unknown> = {};
        const self = () => builder;
        for (const method of ['select', 'eq']) builder[method] = vi.fn(self);
        builder.single = vi.fn(async () => ({ data, error: null }));
        builder.maybeSingle = vi.fn(async () => ({ data, error: null }));
        return builder;
      }),
    } as unknown as SupabaseClient;
  }

  async function captureTemplateError(template: Record<string, unknown> | null) {
    transportMocks.resolveConfig.mockResolvedValueOnce({
      id: 'config-1',
      account_id: 'acct-1',
      evolution_base_url: 'https://evolution.test',
      evolution_instance: 'instance-1',
      evolution_api_key: 'encrypted-key',
    });

    const error = await sendMessageToConversation(templateDb(template), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'approved_preset',
      templateLanguage: 'pt_BR',
      templateParams: ['Anderson'],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SendMessageError);
    expect(transportMocks.sendTemplateMessage).not.toHaveBeenCalled();
    return error as SendMessageError;
  }

  it('rejects a missing preset before transport instead of sending its technical name as text', async () => {
    vi.clearAllMocks();
    const error = await captureTemplateError(null);
    expect(error.code).toBe('template_not_found');
  });

  it('rejects an inactive preset before transport', async () => {
    vi.clearAllMocks();
    const error = await captureTemplateError({
      id: 'template-1',
      user_id: 'user-1',
      name: 'approved_preset',
      language: 'pt_BR',
      body_text: 'Olá {{1}}',
      status: 'DISABLED',
    });
    expect(error.code).toBe('template_inactive');
  });

  it('rejects a preset whose identity/language is incompatible with the request', async () => {
    vi.clearAllMocks();
    const error = await captureTemplateError({
      id: 'template-1',
      user_id: 'user-1',
      name: 'different_preset',
      language: 'en_US',
      body_text: 'Hello {{1}}',
      status: 'APPROVED',
    });
    expect(error.code).toBe('template_incompatible');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});
