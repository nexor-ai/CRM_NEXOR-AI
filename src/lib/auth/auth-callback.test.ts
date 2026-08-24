import { describe, expect, it } from 'vitest';
import { parseAuthCallbackHash } from './auth-callback';

describe('parseAuthCallbackHash', () => {
  it('extracts an implicit-grant token pair from the URL fragment', () => {
    expect(parseAuthCallbackHash('#access_token=access-1&refresh_token=refresh-1&type=magiclink')).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
  });

  it.each(['', '#type=magiclink', '#access_token=access-only', '?access_token=query&refresh_token=query'])(
    'rejects incomplete or non-fragment callback material: %s',
    (value) => expect(parseAuthCallbackHash(value)).toBeNull()
  );
});
