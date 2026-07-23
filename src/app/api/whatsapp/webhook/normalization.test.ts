import { describe, expect, it } from 'vitest';

import {
  collectEvolutionMessageRecords,
  evolutionWebhookEventKey,
  extractEvolutionMessageRecords,
  normalizeEvolutionMessage,
  normalizeEvolutionStatusEvent,
  processReconciliationRecords,
} from './route';

describe('Evolution 2.3 webhook normalization', () => {
  it('reads MESSAGES_UPDATE top-level keyId and remoteJid', () => {
    expect(
      normalizeEvolutionStatusEvent({
        keyId: 'wa-message-id',
        remoteJid: '5511999999999@s.whatsapp.net',
        status: 'READ',
        messageTimestamp: 123,
      })
    ).toEqual({
      id: 'wa-message-id',
      recipient_id: '5511999999999@s.whatsapp.net',
      status: 'read',
      timestamp: '123',
    });
  });

  it('reads media from message.base64/mediaUrl and accepts remoteJidAlt', () => {
    const message = normalizeEvolutionMessage({
      key: {
        id: 'media-id',
        remoteJid: '123456789@lid',
        remoteJidAlt: '5511999999999@s.whatsapp.net',
      },
      messageTimestamp: 123,
      message: {
        imageMessage: { mimetype: 'image/jpeg', caption: 'foto' },
        base64: 'encoded-media',
        mediaUrl: 'https://storage.example/media.jpg',
      },
    });

    expect(message).toMatchObject({
      from: '5511999999999',
      type: 'image',
      image: {
        base64: 'encoded-media',
        url: 'https://storage.example/media.jpg',
        mime_type: 'image/jpeg',
        caption: 'foto',
      },
    });
  });

  it('deduplicates reconciliation records from the Evolution response', () => {
    const duplicate = {
      key: { id: 'same-id', remoteJid: '5511999999999@s.whatsapp.net' },
      message: { conversation: 'olá' },
    };

    expect(
      extractEvolutionMessageRecords({
        messages: { records: [duplicate, duplicate] },
      })
    ).toEqual([duplicate]);
  });

  it('paginates reconciliation and deduplicates records across pages', async () => {
    const calls: number[] = [];
    const record = (id: string) => ({ key: { id } });
    const records = await collectEvolutionMessageRecords({
      limit: 3,
      pageSize: 2,
      fetchPage: async (page, pageSize) => {
        calls.push(page);
        expect(pageSize).toBe(2);
        return page === 1
          ? { messages: { records: [record('1'), record('2')] } }
          : { messages: { records: [record('2'), record('3')] } };
      },
    });

    expect(calls).toEqual([1, 2]);
    expect(records.map((item) => item.key)).toEqual([
      { id: '1' },
      { id: '2' },
      { id: '3' },
    ]);
  });

  it('isolates reconciliation failures and reports each outcome', async () => {
    const records = ['processed', 'duplicate', 'ignored', 'failed'].map((id) => ({
      key: { id },
    }));

    const summary = await processReconciliationRecords(records, async (record) => {
      const id = String((record.key as { id?: string } | undefined)?.id);
      if (id === 'failed') throw new Error('fixture failure');
      return id as 'processed' | 'duplicate' | 'ignored';
    });

    expect(summary).toEqual({
      fetched: 4,
      processed: 1,
      duplicates: 1,
      ignored: 1,
      failed: 1,
      errors: [{ message_id: 'failed', error: 'fixture failure' }],
    });
  });

  it('builds a stable inbox key scoped by instance, event and transport id', () => {
    const first = evolutionWebhookEventKey({
      instance: 'NEXOR_AI',
      event: 'MESSAGES_UPSERT',
      data: { key: { id: 'message-1' } },
    });
    const duplicate = evolutionWebhookEventKey({
      instance: 'NEXOR_AI',
      event: 'MESSAGES_UPSERT',
      data: { key: { id: 'message-1' }, ignored: 'different payload' },
    });
    const otherInstance = evolutionWebhookEventKey({
      instance: 'Anderson Tech',
      event: 'MESSAGES_UPSERT',
      data: { key: { id: 'message-1' } },
    });

    expect(first).toBe(duplicate);
    expect(first).not.toBe(otherInstance);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('deduplicates the same status but preserves monotonic status progressions', () => {
    const keyFor = (status: string) => evolutionWebhookEventKey({
      instance: 'NEXOR_AI',
      event: 'MESSAGES_UPDATE',
      data: { key: { id: 'message-1' }, status },
    });
    expect(keyFor('DELIVERED')).toBe(keyFor('delivered'));
    expect(keyFor('sent')).not.toBe(keyFor('delivered'));
    expect(keyFor('delivered')).not.toBe(keyFor('read'));
  });

  it('canonicalizes underscore reconciliation events as messages.upsert', () => {
    const underscore = evolutionWebhookEventKey({
      instance: 'NEXOR_AI',
      event: 'MESSAGES_UPSERT',
      data: { key: { id: 'message-1' } },
    });
    const dotted = evolutionWebhookEventKey({
      instance: 'NEXOR_AI',
      event: 'messages.upsert',
      data: { key: { id: 'message-1' } },
    });
    expect(underscore).toBe(dotted);
  });

  it.each([
    [
      'location',
      { locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: 'Escritório', address: 'São Paulo' } },
      { type: 'location', location: { latitude: -23.5, longitude: -46.6, name: 'Escritório', address: 'São Paulo' } },
    ],
    [
      'contact',
      { contactMessage: { displayName: 'Ana', vcard: 'BEGIN:VCARD\nFN:Ana\nTEL:+5511988880000\nEND:VCARD' } },
      { type: 'contact', contact: { displayName: 'Ana', vcard: 'BEGIN:VCARD\nFN:Ana\nTEL:+5511988880000\nEND:VCARD' } },
    ],
    [
      'sticker',
      { stickerMessage: { mimetype: 'image/webp' }, mediaUrl: 'https://cdn.example/sticker.webp' },
      { type: 'sticker', sticker: { mime_type: 'image/webp', url: 'https://cdn.example/sticker.webp' } },
    ],
    [
      'poll',
      { pollCreationMessageV3: { name: 'Escolha', options: [{ optionName: 'A' }, { optionName: 'B' }], selectableOptionsCount: 1 } },
      { type: 'poll', poll: { name: 'Escolha', values: ['A', 'B'], selectableCount: 1 } },
    ],
  ])('normalizes %s messages for the inbox', (_kind, message, expected) => {
    expect(normalizeEvolutionMessage({
      key: { id: `${_kind}-1`, remoteJid: '5511999999999@s.whatsapp.net' },
      messageTimestamp: 123,
      message,
    })).toMatchObject(expected);
  });
});