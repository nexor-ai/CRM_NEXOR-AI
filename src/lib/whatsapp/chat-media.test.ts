import { describe, expect, it } from 'vitest';

import {
  chatMediaPathFromReference,
  chatMediaReference,
  normalizeStoredChatMediaReference,
} from './chat-media';

const path = 'account-account-a/inbound/message-1.jpg';

describe('chat media references', () => {
  it('round-trips an account-scoped storage path through an opaque proxy id', () => {
    const reference = chatMediaReference(path);
    expect(reference).toMatch(/^\/api\/whatsapp\/media\/[A-Za-z0-9_-]+$/);
    expect(chatMediaPathFromReference(reference)).toBe(path);
  });

  it('upgrades legacy public chat-media URLs to the authenticated proxy', () => {
    expect(
      normalizeStoredChatMediaReference(
        `https://project.supabase.co/storage/v1/object/public/chat-media/${path}`
      )
    ).toBe(chatMediaReference(path));
  });

  it('keeps safe legacy external HTTPS URLs and rejects unsafe URLs', () => {
    expect(
      normalizeStoredChatMediaReference('https://cdn.example/legacy/image.jpg')
    ).toBe('https://cdn.example/legacy/image.jpg');
    expect(
      normalizeStoredChatMediaReference('http://cdn.example/legacy/image.jpg')
    ).toBeNull();
    expect(
      normalizeStoredChatMediaReference('https://localhost/legacy/image.jpg')
    ).toBeNull();
  });
});
