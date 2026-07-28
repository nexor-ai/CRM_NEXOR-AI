import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkEvolutionHealth } from '@/lib/whatsapp/evolution-api'
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config'

const EXPECTED_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'SEND_MESSAGE',
  'CONNECTION_UPDATE',
  'CONTACTS_UPSERT',
  'QRCODE_UPDATED',
]

function expectedWebhookUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '')
  if (!base) return null
  return `${base}/api/whatsapp/webhook`
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!profile?.account_id) {
    return NextResponse.json({ live: false, checks: { account: false }, errors: ['No account linked.'] })
  }

  const explicitConfigId = new URL(request.url).searchParams.get('config_id')
  const config = await resolveActiveWhatsAppConfig(supabase, profile.account_id, { explicitConfigId })
  if (explicitConfigId && !config) {
    return NextResponse.json({ live: false, error: 'config_not_found', checks: { configured: false }, errors: ['Selected configuration was not found.'] }, { status: 404 })
  }
  if (!config?.evolution_base_url || !config.evolution_instance || !config.evolution_api_key) {
    return NextResponse.json({ live: false, checks: { configured: false }, errors: ['Evolution API is not configured.'] })
  }

  let apiKey: string
  try {
    apiKey = decrypt(config.evolution_api_key)
  } catch {
    return NextResponse.json({ live: false, checks: { configured: true, decrypted: false }, errors: ['Stored Evolution API key cannot be decrypted.'] })
  }

  const webhookUrl = expectedWebhookUrl()
  if (!webhookUrl) {
    return NextResponse.json({
      live: false,
      checks: { configured: true, site_url: false },
      errors: ['NEXT_PUBLIC_SITE_URL is missing, so webhook health cannot be verified.'],
    })
  }

  try {
    const health = await checkEvolutionHealth({
      baseUrl: config.evolution_base_url,
      instance: config.evolution_instance,
      apiKey,
      expectedWebhookUrl: webhookUrl,
      expectedEvents: EXPECTED_EVENTS,
      requireBase64: true,
    })
    await supabase
      .from('whatsapp_config')
      .update({
        connection_state: health.connectionState,
        status: health.instanceOpen ? 'connected' : 'disconnected',
      })
      .eq('id', config.id)

    return NextResponse.json({
      live: health.healthy,
      connection_state: health.connectionState,
      checks: {
        configured: true,
        instance_open: health.instanceOpen,
        webhook_operational: health.webhookOperational,
        ...health.checks,
      },
      errors: health.healthy ? [] : ['Evolution is connected, but one or more webhook checks failed.'],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Evolution API error'
    return NextResponse.json({
      live: false,
      checks: { configured: true, instance_open: false, webhook_operational: false },
      errors: [`Evolution health check failed: ${message}`],
    })
  }
}
