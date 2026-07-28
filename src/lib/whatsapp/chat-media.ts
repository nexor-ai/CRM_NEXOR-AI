const CHAT_MEDIA_PROXY_PREFIX = '/api/whatsapp/media/';
const CHAT_MEDIA_ACCOUNT_PREFIX = 'account-';

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '='
  );
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function isChatMediaPathForAccount(
  path: string,
  accountId: string
): boolean {
  if (!accountId || path.length === 0 || path.length > 1024) return false;
  if (path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    return false;
  }
  return path.split('/')[0] === `${CHAT_MEDIA_ACCOUNT_PREFIX}${accountId}`;
}

export function encodeChatMediaPath(path: string): string {
  return toBase64Url(path);
}

export function decodeChatMediaPath(mediaId: string): string | null {
  return fromBase64Url(mediaId);
}

export function chatMediaReference(path: string): string {
  return `${CHAT_MEDIA_PROXY_PREFIX}${encodeChatMediaPath(path)}`;
}

export function chatMediaPathFromReference(reference: string): string | null {
  if (!reference.startsWith(CHAT_MEDIA_PROXY_PREFIX)) return null;
  const mediaId = reference.slice(CHAT_MEDIA_PROXY_PREFIX.length);
  if (!mediaId || mediaId.includes('/')) return null;
  return decodeChatMediaPath(mediaId);
}

/**
 * Convert migration-023 public Storage URLs into the authenticated proxy while
 * leaving safe third-party HTTPS URLs intact for legacy Evolution messages.
 */
export function normalizeStoredChatMediaReference(
  reference: string | null | undefined
): string | null {
  if (!reference) return null;
  if (reference.startsWith(CHAT_MEDIA_PROXY_PREFIX)) {
    return chatMediaPathFromReference(reference) ? reference : null;
  }

  try {
    const url = new URL(reference);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (
      !hostname ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '::1'
    ) {
      return null;
    }

    const publicMarker = '/storage/v1/object/public/chat-media/';
    const markerIndex = url.pathname.indexOf(publicMarker);
    if (markerIndex >= 0) {
      const encodedPath = url.pathname.slice(markerIndex + publicMarker.length);
      const path = decodeURIComponent(encodedPath);
      return path ? chatMediaReference(path) : null;
    }
    return url.href;
  } catch {
    return null;
  }
}
