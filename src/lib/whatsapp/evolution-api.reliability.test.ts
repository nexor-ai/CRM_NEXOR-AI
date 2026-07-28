import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkEvolutionHealth,
  findMessages,
  getConnectionState,
  markMessagesAsRead,
  sendChatPresence,
  sendTextMessage,
} from './evolution-api';

const fetchMock = vi.fn();
const credentials = {
  baseUrl: 'https://8.8.8.8',
  instance: 'nexor',
  apiKey: 'fixture-value',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('EVOLUTION_ALLOWED_BASE_URLS', 'https://8.8.8.8');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Evolution reliability contracts', () => {
  it('applies a timeout signal and retries transient GET failures', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ instance: { state: 'open' } }), {
          status: 200,
        })
      );

    await expect(getConnectionState(credentials)).resolves.toEqual({ state: 'open' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('never retries a message POST after a transient response', async () => {
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));

    await expect(
      sendTextMessage({ ...credentials, to: '5511999999999', text: 'oi' })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an open instance from an operational webhook', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ instance: { state: 'open' } }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            url: 'https://crm.example/api/whatsapp/webhook',
            byEvents: false,
            base64: true,
            events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
          }),
          { status: 200 }
        )
      );

    const health = await checkEvolutionHealth({
      ...credentials,
      expectedWebhookUrl: 'https://crm.example/api/whatsapp/webhook',
      expectedEvents: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
      requireBase64: true,
    });

    expect(health).toMatchObject({
      healthy: true,
      instanceOpen: true,
      webhookOperational: true,
      checks: {
        webhookEnabled: true,
        webhookUrl: true,
        webhookEvents: true,
        webhookBase64: true,
      },
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://8.8.8.8/webhook/find/nexor'
    );
    expect(fetchMock.mock.calls[1][1].redirect).toBe('error');
  });

  it('accepts the Evolution 2.3.7 webhookBase64 response field', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ instance: { state: 'open' } }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            url: 'https://crm.example/api/whatsapp/webhook',
            webhookByEvents: false,
            webhookBase64: true,
            events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
          }),
          { status: 200 }
        )
      );

    const health = await checkEvolutionHealth({
      ...credentials,
      expectedWebhookUrl: 'https://crm.example/api/whatsapp/webhook',
      expectedEvents: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
      requireBase64: true,
    });

    expect(health.healthy).toBe(true);
    expect(health.checks.webhookBase64).toBe(true);
  });

  it('sends Evolution read-receipt keys', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));

    await markMessagesAsRead({
      ...credentials,
      messages: [
        {
          id: 'message-1',
          remoteJid: '5511999999999@s.whatsapp.net',
          fromMe: false,
        },
      ],
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://8.8.8.8/chat/markMessageAsRead/nexor'
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      readMessages: [
        {
          id: 'message-1',
          remoteJid: '5511999999999@s.whatsapp.net',
          fromMe: false,
        },
      ],
    });
  });

  it('sends scoped chat presence', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));

    await sendChatPresence({
      ...credentials,
      to: '+55 (11) 99999-9999',
      presence: 'composing',
      delay: 1200,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://8.8.8.8/chat/sendPresence/nexor'
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      number: '5511999999999',
      presence: 'composing',
      delay: 1200,
    });
  });

  it('queries messages for idempotent reconciliation', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: { records: [{ key: { id: '1' } }] } }), {
          status: 200,
        })
      );

    await findMessages({
      ...credentials,
      remoteJid: '5511999999999@s.whatsapp.net',
      limit: 50,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://8.8.8.8/chat/findMessages/nexor'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      where: { key: { remoteJid: '5511999999999@s.whatsapp.net' } },
      offset: 50,
      page: 1,
    });
  });
});
