export type AuthCallbackTokens = {
  accessToken: string;
  refreshToken: string;
};

/**
 * Reads only the implicit-grant tokens returned by Supabase after a valid
 * magic-link or recovery action. It never accepts tokens from query params,
 * keeping URLs/caches/proxy logs free of credentials.
 */
export function parseAuthCallbackHash(hash: string): AuthCallbackTokens | null {
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}
