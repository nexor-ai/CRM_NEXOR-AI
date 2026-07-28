const ALLOWED_MIME = new Set(['audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm']);
export const TRANSCRIPTION_LIMITS = { maxSizeBytes: 25 * 1024 * 1024, maxDurationSeconds: 1800, maxAttempts: 5 } as const;

type MediaInput = { mime: string; sizeBytes: number; durationSeconds: number };
type Validation = { ok: true } | { ok: false; code: 'unsupported_mime' | 'file_too_large' | 'duration_exceeded' };

export function validateTranscriptionMedia(input: MediaInput): Validation {
  const mime = input.mime.split(';', 1)[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return { ok: false, code: 'unsupported_mime' };
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > TRANSCRIPTION_LIMITS.maxSizeBytes) return { ok: false, code: 'file_too_large' };
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > TRANSCRIPTION_LIMITS.maxDurationSeconds) return { ok: false, code: 'duration_exceeded' };
  return { ok: true };
}

export function nextTranscriptionAttempt(attempts: number, maxAttempts: number, now = new Date()): { status: 'retry' | 'dead_letter'; availableAt: string | null } {
  if (attempts >= maxAttempts) return { status: 'dead_letter', availableAt: null };
  const seconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return { status: 'retry', availableAt: new Date(now.getTime() + seconds * 1000).toISOString() };
}

export function sanitizeTranscriptionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(/(api[_-]?key|token|secret|password)=?\S*/gi, '$1=[redacted]')
    .slice(0, 240);
}
