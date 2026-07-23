import { createHmac, timingSafeEqual } from 'crypto'

export function evolutionWebhookTokenForScope(scopeId: string): string {
  const root = process.env.WHATSAPP_WEBHOOK_TOKEN || ''
  if (!root || !scopeId) return ''
  return createHmac('sha256', root).update(`wacrm-evolution:${scopeId}`).digest('hex')
}

/**
 * Evolution API does not sign payloads like Meta. Each account receives a
 * derived callback token, so disclosure by one Evolution instance cannot
 * authorize callbacks for another tenant.
 */
export function verifyEvolutionWebhookToken(request: Request): boolean {
  const scopeId = request.headers.get('x-wacrm-webhook-scope') || ''
  const expected = evolutionWebhookTokenForScope(scopeId)
  if (!expected) return false
  const received = request.headers.get('x-wacrm-webhook-token') || request.headers.get('x-evolution-webhook-token') || ''
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
