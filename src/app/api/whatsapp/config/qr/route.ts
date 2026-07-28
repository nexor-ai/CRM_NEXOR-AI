import { NextResponse } from 'next/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { connectInstance, setInstanceWebhook } from '@/lib/whatsapp/evolution-api'
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config'
import { ForbiddenError, requireRole, toErrorResponse, UnauthorizedError } from '@/lib/auth/account'

function siteWebhookUrl(request: Request): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  const url = new URL('/api/whatsapp/webhook', base)
  return url.toString()
}

// Re-fetches the QR/pairing payload for an already-saved instance without
// re-running the full Save flow (no credential re-validation, no instance
// re-create) — for when the previous QR expired before the user scanned it.
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const body = (await request.json().catch(() => ({}))) as { config_id?: unknown }
    const explicitConfigId = typeof body.config_id === 'string' ? body.config_id : null
    const config = await resolveActiveWhatsAppConfig(supabase, accountId, { explicitConfigId })
    if (explicitConfigId && !config) {
      return NextResponse.json({ error: 'Configuração não encontrada.' }, { status: 404 })
    }
    if (!config?.evolution_base_url || !config?.evolution_instance || !config?.evolution_api_key) {
      return NextResponse.json({ error: 'Nenhuma configuração da API Evolution foi salva ainda.' }, { status: 400 })
    }

    let apiKey: string
    try { apiKey = decrypt(config.evolution_api_key) }
    catch { return NextResponse.json({ error: 'Não foi possível descriptografar a chave da API Evolution armazenada.' }, { status: 400 }) }

    const baseUrl = config.evolution_base_url
    const instance = config.evolution_instance

    const qr = await connectInstance({ baseUrl, instance, apiKey })

    if (process.env.WHATSAPP_WEBHOOK_TOKEN) {
      try { await setInstanceWebhook({ baseUrl, instance, apiKey, url: siteWebhookUrl(request), webhookScopeId: accountId }) }
      catch (err) { console.warn('[whatsapp/config/qr] webhook set failed:', err instanceof Error ? err.message : err) }
    }

    return NextResponse.json({ qrcode: qr })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) return toErrorResponse(error)
    const message = error instanceof Error ? error.message : 'Unknown Evolution API error'
    console.error('Error in WhatsApp config/qr POST:', error)
    return NextResponse.json({ error: `Falha ao atualizar o QR da Evolution: ${message}` }, { status: 500 })
  }
}
