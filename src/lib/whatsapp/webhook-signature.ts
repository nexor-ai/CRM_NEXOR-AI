import { timingSafeEqual } from 'crypto'

/**
 * EVOLUTION: Evolution API does not sign payloads like Meta. We fail-closed
 * against our own shared token, supplied as `?token=` or `x-wacrm-webhook-token`.
 */
export function verifyEvolutionWebhookToken(request: Request): boolean {
  const expected = process.env.WHATSAPP_WEBHOOK_TOKEN
  if (!expected) return false
  const url = new URL(request.url)
  const received = url.searchParams.get('token') || request.headers.get('x-wacrm-webhook-token') || request.headers.get('x-evolution-webhook-token') || ''
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
