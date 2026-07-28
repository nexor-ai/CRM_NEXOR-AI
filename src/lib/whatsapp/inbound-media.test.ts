import { describe, expect, it, vi } from 'vitest';

import { persistInboundMedia } from './inbound-media';

function storageMock() {
  const upload = vi.fn(async () => ({ data: { path: 'stored' }, error: null }));
  const getPublicUrl = vi.fn(() => ({
    data: { publicUrl: 'https://storage.example/public/chat-media/leak.jpg' },
  }));
  const from = vi.fn(() => ({ upload, getPublicUrl }));
  return { storage: { from }, upload, getPublicUrl };
}

describe('persistInboundMedia', () => {
  it('stores base64 media by account path and returns only an authenticated proxy reference', async () => {
    const client = storageMock();
    const media = {
      base64: Buffer.from('private image').toString('base64'),
      mime_type: 'image/jpeg',
    };

    await persistInboundMedia(
      client as never,
      media,
      'account-a',
      'transport/message-1'
    );

    expect(client.upload).toHaveBeenCalledWith(
      'account-account-a/inbound/transport_message-1.jpg',
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'image/jpeg' })
    );
    expect(client.getPublicUrl).not.toHaveBeenCalled();
    expect(media).not.toHaveProperty('base64');
    expect(media).toHaveProperty(
      'url',
      expect.stringMatching(/^\/api\/whatsapp\/media\/[A-Za-z0-9_-]+$/)
    );
  });

  it('keeps an external HTTPS reference only when no persisted payload is available', async () => {
    const client = storageMock();
    const media = { url: 'https://cdn.example/media.jpg', mime_type: 'image/jpeg' };

    await persistInboundMedia(client as never, media, 'account-a', 'message-2');

    expect(client.upload).not.toHaveBeenCalled();
    expect(media.url).toBe('https://cdn.example/media.jpg');
  });

  it.each([
    'http://cdn.example/media.jpg',
    'https://user:password@cdn.example/media.jpg',
    'https://localhost/media.jpg',
    'https://127.0.0.1/media.jpg',
  ])('rejects unsafe external media URL %s', async (url) => {
    const client = storageMock();

    await expect(
      persistInboundMedia(
        client as never,
        { url, mime_type: 'image/jpeg' },
        'account-a',
        'message-3'
      )
    ).rejects.toThrow(/safe HTTPS URL/);
  });
});
