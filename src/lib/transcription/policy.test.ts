import { describe, expect, it } from 'vitest';
import { nextTranscriptionAttempt, validateTranscriptionMedia, sanitizeTranscriptionError } from './policy';

describe('transcription policy', () => {
  it('accepts governed audio and rejects MIME, size and duration overflow', () => {
    expect(validateTranscriptionMedia({ mime: 'audio/ogg', sizeBytes: 1024, durationSeconds: 20 })).toEqual({ ok: true });
    expect(validateTranscriptionMedia({ mime: 'text/plain', sizeBytes: 10, durationSeconds: 1 })).toMatchObject({ ok: false, code: 'unsupported_mime' });
    expect(validateTranscriptionMedia({ mime: 'audio/ogg', sizeBytes: 26 * 1024 * 1024, durationSeconds: 1 })).toMatchObject({ ok: false, code: 'file_too_large' });
    expect(validateTranscriptionMedia({ mime: 'audio/ogg', sizeBytes: 10, durationSeconds: 1801 })).toMatchObject({ ok: false, code: 'duration_exceeded' });
  });

  it('backs off retries and dead-letters exhausted jobs', () => {
    expect(nextTranscriptionAttempt(1, 5, new Date('2026-01-01T00:00:00Z'))).toMatchObject({ status: 'retry' });
    expect(nextTranscriptionAttempt(5, 5, new Date('2026-01-01T00:00:00Z'))).toEqual({ status: 'dead_letter', availableAt: null });
  });

  it('sanitizes credentials, URLs and long provider errors', () => {
    const value = sanitizeTranscriptionError('Bearer secret https://private.example/file?token=abc ' + 'x'.repeat(500));
    expect(value).not.toContain('secret');
    expect(value).not.toContain('token=abc');
    expect(value.length).toBeLessThanOrEqual(240);
  });
});
