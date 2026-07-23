import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { createInstance, connectInstance, getConnectionState, setInstanceWebhook, logoutInstance, deleteInstance } from '@/lib/whatsapp/evolution-api'
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config'
import { ForbiddenError, requireRole, toErrorResponse, UnauthorizedError } from '@/lib/auth/account'
import { assertSafeEvolutionBaseUrl } from '@/lib/whatsapp/evolution-url-safety'

async function resolveAccountId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('profiles').select('account_id').eq('user_id', userId).maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

function siteWebhookUrl(request: Request): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  const url = new URL('/api/whatsapp/webhook', base)
  return url.toString()
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) return NextResponse.json({ connected: false, reason: 'no_account', message: 'Seu perfil não está vinculado a uma conta.' })

    let config
    try { config = await resolveActiveWhatsAppConfig(supabase, accountId) }
    catch { return NextResponse.json({ connected: false, reason: 'db_error', message: 'Não foi possível buscar a configuração' }) }
    if (!config?.evolution_base_url || !config?.evolution_instance || !config?.evolution_api_key) {
      return NextResponse.json({ connected: false, reason: 'no_config', message: 'Nenhuma configuração da API Evolution foi salva ainda.' })
    }

    let apiKey: string
    try { apiKey = decrypt(config.evolution_api_key) }
    catch { return NextResponse.json({ connected: false, reason: 'token_corrupted', needs_reset: true, message: 'A chave da API Evolution armazenada não pode ser descriptografada com a ENCRYPTION_KEY atual.' }) }

    try {
      const state = await getConnectionState({ baseUrl: config.evolution_base_url, instance: config.evolution_instance, apiKey })
      await supabase.from('whatsapp_config').update({ connection_state: state.state, status: state.state === 'open' ? 'connected' : 'disconnected', updated_at: new Date().toISOString() }).eq('id', config.id)
      return NextResponse.json({ connected: state.state === 'open', connection_state: state.state, instance: config.evolution_instance, base_url: config.evolution_base_url })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Evolution API error'
      return NextResponse.json({ connected: false, reason: 'evolution_api_error', message: `A API Evolution rejeitou as credenciais: ${message}` })
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json({ connected: false, reason: 'unknown', message: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId } = await requireRole('admin')

    const body = await request.json()
    const existing = await resolveActiveWhatsAppConfig(supabase, accountId)
    const requestedBaseUrl = String(body.evolution_base_url || process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '')
    const instance = String(body.evolution_instance || process.env.EVOLUTION_INSTANCE || `wacrm_${accountId.slice(0, 8)}`).trim()
    let apiKey = String(body.evolution_api_key || process.env.EVOLUTION_API_KEY || '').trim()
    if (!body.evolution_api_key && existing?.evolution_api_key) {
      try { apiKey = decrypt(existing.evolution_api_key) }
      catch { return NextResponse.json({ error: 'Não foi possível descriptografar a chave da API Evolution armazenada. Cole a apikey da Evolution novamente.' }, { status: 400 }) }
    }
    if (!requestedBaseUrl || !instance || !apiKey) return NextResponse.json({ error: 'evolution_base_url, evolution_instance and evolution_api_key are required' }, { status: 400 })
    let baseUrl: string
    try {
      baseUrl = await assertSafeEvolutionBaseUrl(requestedBaseUrl)
    } catch (error) {
      console.warn('[whatsapp/config] blocked Evolution URL:', error instanceof Error ? error.message : 'invalid URL')
      return NextResponse.json({ error: 'A URL base da Evolution não é permitida pela política do servidor' }, { status: 400 })
    }

    try {
      await createInstance({ baseUrl, instance, apiKey })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/already exists|already registered|already in use|409|Conflict/i.test(message)) {
        console.warn('[whatsapp/config] Evolution instance create failed:', message)
        return NextResponse.json({ error: 'Não foi possível criar a instância Evolution' }, { status: 400 })
      }
    }

    let qr: { base64?: string; code?: string; pairingCode?: string } = {}
    try { qr = await connectInstance({ baseUrl, instance, apiKey }) }
    catch (err) { console.warn('[whatsapp/config] QR fetch failed:', err instanceof Error ? err.message : err) }

    if (process.env.WHATSAPP_WEBHOOK_TOKEN) {
      try { await setInstanceWebhook({ baseUrl, instance, apiKey, url: siteWebhookUrl(request), webhookScopeId: accountId }) }
      catch (err) { console.warn('[whatsapp/config] webhook set failed:', err instanceof Error ? err.message : err) }
    }

    const encryptedKey = encrypt(apiKey)
    const state = await getConnectionState({ baseUrl, instance, apiKey }).catch(() => ({ state: 'connecting' }))
    const row = { evolution_base_url: baseUrl, evolution_instance: instance, evolution_api_key: encryptedKey, connection_state: state.state, status: state.state === 'open' ? 'connected' : 'disconnected', updated_at: new Date().toISOString(), phone_number_id: null, waba_id: null, access_token: null, verify_token: null, registered_at: null, subscribed_apps_at: null, last_registration_error: null }
    if (existing) {
      const { error } = await supabase.from('whatsapp_config').update(row).eq('id', existing.id)
      if (error) return NextResponse.json({ error: 'Não foi possível atualizar a configuração' }, { status: 500 })
    } else {
      const { error } = await supabase.from('whatsapp_config').insert({ account_id: accountId, user_id: userId, ...row })
      if (error) return NextResponse.json({ error: 'Não foi possível salvar a configuração' }, { status: 500 })
    }
    return NextResponse.json({ success: true, saved: true, connection_state: state.state, instance, qrcode: qr, registration_skipped: state.state !== 'open' })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) return toErrorResponse(error)
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const config = await resolveActiveWhatsAppConfig(supabase, accountId)
    if (config?.evolution_base_url && config?.evolution_instance && config?.evolution_api_key) {
      const apiKey = decrypt(config.evolution_api_key)
      await logoutInstance({ baseUrl: config.evolution_base_url, instance: config.evolution_instance, apiKey }).catch(() => undefined)
      await deleteInstance({ baseUrl: config.evolution_base_url, instance: config.evolution_instance, apiKey }).catch(() => undefined)
    }
    const { error } = config
      ? await supabase.from('whatsapp_config').delete().eq('id', config.id)
      : { error: null }
    if (error) return NextResponse.json({ error: 'Não foi possível excluir a configuração' }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) return toErrorResponse(error)
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
