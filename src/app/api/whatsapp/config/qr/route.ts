import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { connectInstance, setInstanceWebhook } from '@/lib/whatsapp/evolution-api'

function siteWebhookUrl(request: Request): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  const token = process.env.WHATSAPP_WEBHOOK_TOKEN
  const url = new URL('/api/whatsapp/webhook', base)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

// Re-fetches the QR/pairing payload for an already-saved instance without
// re-running the full Save flow (no credential re-validation, no instance
// re-create) — for when the previous QR expired before the user scanned it.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).maybeSingle()
    if (!profile?.account_id) return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })

    const { data: config } = await supabase.from('whatsapp_config').select('*').eq('account_id', profile.account_id).maybeSingle()
    if (!config?.evolution_base_url || !config?.evolution_instance || !config?.evolution_api_key) {
      return NextResponse.json({ error: 'No Evolution API configuration saved yet.' }, { status: 400 })
    }

    let apiKey: string
    try { apiKey = decrypt(config.evolution_api_key) }
    catch { return NextResponse.json({ error: 'Stored Evolution API key cannot be decrypted.' }, { status: 400 }) }

    const baseUrl = config.evolution_base_url
    const instance = config.evolution_instance

    const qr = await connectInstance({ baseUrl, instance, apiKey })

    if (process.env.WHATSAPP_WEBHOOK_TOKEN) {
      try { await setInstanceWebhook({ baseUrl, instance, apiKey, url: siteWebhookUrl(request) }) }
      catch (err) { console.warn('[whatsapp/config/qr] webhook set failed:', err instanceof Error ? err.message : err) }
    }

    return NextResponse.json({ qrcode: qr })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Evolution API error'
    console.error('Error in WhatsApp config/qr POST:', error)
    return NextResponse.json({ error: `Evolution QR refresh failed: ${message}` }, { status: 500 })
  }
}
