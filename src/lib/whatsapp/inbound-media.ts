import { isIP } from 'node:net';

import { chatMediaReference } from './chat-media';

export const INBOUND_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INBOUND_MIME = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac)|application\/(pdf|octet-stream))$/i;

type InboundMedia = {
  url?: string;
  base64?: string;
  mime_type?: string;
  filename?: string;
  size_bytes?: number;
  duration_seconds?: number;
};

type StorageClient = {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Buffer,
        options: { contentType: string; cacheControl: string; upsert: boolean }
      ): Promise<{ error: { message: string } | null }>;
    };
  };
};

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 0
  );
}

export function isSafeExternalMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return false;
    }
    const ipVersion = isIP(hostname);
    if (ipVersion === 4 && isPrivateIpv4(hostname)) return false;
    if (ipVersion === 6 && (hostname === '::1' || hostname.startsWith('fe80:'))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function persistInboundMedia(
  client: StorageClient,
  media: InboundMedia,
  accountId: string,
  transportMessageId: string
): Promise<void> {
  const mime = String(media.mime_type || 'application/octet-stream')
    .split(';')[0]
    .trim();
  if (!SAFE_INBOUND_MIME.test(mime)) {
    throw new Error(`Unsupported inbound media MIME type: ${mime}`);
  }

  if (media.base64) {
    const clean = media.base64.replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(clean, 'base64');
    if (bytes.length === 0 || bytes.length > INBOUND_MEDIA_MAX_BYTES) {
      throw new Error('Inbound media exceeds the controlled size limit');
    }
    const extension = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
    const safeId = transportMessageId
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120);
    const path = `account-${accountId}/inbound/${safeId}.${extension}`;
    const { error } = await client.storage.from('chat-media').upload(path, bytes, {
      contentType: mime,
      cacheControl: '3600',
      upsert: false,
    });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      throw new Error(`Could not persist inbound media: ${error.message}`);
    }
    media.size_bytes = bytes.length;
    media.url = chatMediaReference(path);
    delete media.base64;
    return;
  }

  if (media.url && !isSafeExternalMediaUrl(media.url)) {
    throw new Error('Inbound media URL must be a safe HTTPS URL');
  }
}
