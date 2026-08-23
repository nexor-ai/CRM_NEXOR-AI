import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { createInstance, connectInstance, getConnectionState, setInstanceWebhook, logoutInstance, deleteInstance } from '@/lib/whatsapp/evolution-api'
import { AmbiguousWhatsAppConfigError, resolveWhatsAppConfigCandidates, type ActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config'
import { planWhatsAppConfigWrite, WhatsAppConfigNotFoundError } from '@/lib/whatsapp/config-write-plan'
import { ForbiddenError, requireRole, toErrorResponse, UnauthorizedError } from '@/lib/auth/account'
import { assertSafeEvolutionBaseUrl } from '@/lib/whatsapp/evolution-url-safety'

async function resolveAccountId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('profiles').select('account_id').eq('user_id', userId).maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

function siteWebhookUrl(request: Request): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  return new URL('/api/whatsapp/webhook', base).toString()
}

async function loadConfigs(supabase: Awaited<ReturnType<typeof createClient>>, accountId: string) {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('*, department:departments(id, name, is_default)')
    .eq('account_id', accountId)
    .is('disabled_at', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to list WhatsApp configurations: ${error.message}`)
  return (data ?? []) as ActiveWhatsAppConfig[]
}

function publicConfig(config: ActiveWhatsAppConfig) {
  const safe = { ...config } as Record<string, unknown>
  const hasApiKey = Boolean(safe.evolution_api_key)
  delete safe.evolution_api_key
  delete safe.access_token
  delete safe.verify_token
  return { ...safe, has_api_key: hasApiKey }
}

function selectionError(error: unknown) {
  if (error instanceof AmbiguousWhatsAppConfigError) {
    return NextResponse.json({ error: 'ambiguous_config', message: 'Selecione uma instância do WhatsApp.' }, { status: 409 })
  }
  if (error instanceof WhatsAppConfigNotFoundError) {
    return NextResponse.json({ error: 'config_not_found' }, { status: 404 })
  }
  return null
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) return NextResponse.json({ connected: false, reason: 'no_account', configurations: [], message: 'Seu perfil não está vinculado a uma conta.' })

    const configs = await loadConfigs(supabase, accountId)
    const configurations = configs.map(publicConfig)
    const url = new URL(request.url)
    const explicitConfigId = url.searchParams.get('config_id')
    let selected: ActiveWhatsAppConfig | null
    try {
      selected = resolveWhatsAppConfigCandidates(configs, { explicitConfigId })
      if (explicitConfigId && !selected) throw new WhatsAppConfigNotFoundError()
    } catch (error) {
      if (error instanceof AmbiguousWhatsAppConfigError) {
        return NextResponse.json({ error: 'ambiguous_config', message: 'Selecione uma instância do WhatsApp.', configurations, selected_config_id: null }, { status: 409 })
      }
      return selectionError(error) ?? NextResponse.json({ error: 'Não foi possível selecionar a configuração' }, { status: 500 })
    }

    if (!selected) {
      return NextResponse.json({ connected: false, reason: 'no_config', configurations, selected_config_id: null, message: 'Nenhuma configuração da API Evolution foi salva ainda.' })
    }

    const basePayload = {
      configurations,
      selected_config_id: selected.id,
      config: publicConfig(selected),
      connected: selected.connection_state === 'open',
      connection_state: selected.connection_state ?? 'unknown',
      instance: selected.evolution_instance,
      base_url: selected.evolution_base_url,
    }
    // Listing settings is read-only and never calls Evolution. Health checks
    // happen only after the user presses "Testar conexão".
    if (url.searchParams.get('check') !== 'true') return NextResponse.json(basePayload)

    if (!selected.evolution_base_url || !selected.evolution_instance || !selected.evolution_api_key) {
      return NextResponse.json({ ...basePayload, connected: false, reason: 'no_config', message: 'A instância selecionada está incompleta.' })
    }
    let apiKey: string
    try { apiKey = decrypt(selected.evolution_api_key) }
    catch { return NextResponse.json({ ...basePayload, connected: false, reason: 'token_corrupted', needs_reset: true, message: 'A chave da API Evolution armazenada não pode ser descriptografada com a ENCRYPTION_KEY atual.' }) }

    try {
      const state = await getConnectionState({ baseUrl: selected.evolution_base_url, instance: selected.evolution_instance, apiKey })
      await supabase.from('whatsapp_config').update({ connection_state: state.state, status: state.state === 'open' ? 'connected' : 'disconnected', updated_at: new Date().toISOString() }).eq('id', selected.id).eq('account_id', accountId)
      return NextResponse.json({ ...basePayload, connected: state.state === 'open', connection_state: state.state })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Evolution API error'
      return NextResponse.json({ ...basePayload, connected: false, reason: 'evolution_api_error', message: `A API Evolution rejeitou as credenciais: ${message}` })
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
    const configs = await loadConfigs(supabase, accountId)
    let plan
    try {
      plan = planWhatsAppConfigWrite(configs, {
        configId: typeof body.config_id === 'string' ? body.config_id : null,
        createNew: body.create_new === true,
      })
    } catch (error) {
      return selectionError(error) ?? NextResponse.json({ error: 'Não foi possível selecionar a configuração' }, { status: 500 })
    }
    const existing = plan.kind === 'update' ? configs.find((item) => item.id === plan.config.id) ?? null : null

    if (typeof body.department_id === 'string') {
      const { data: department, error: departmentError } = await supabase
        .from('departments')
        .select('id')
        .eq('id', body.department_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (departmentError || !department) {
        return NextResponse.json({ error: 'department_not_found' }, { status: 404 })
      }
    }

    const requestedBaseUrl = String(body.evolution_base_url || existing?.evolution_base_url || process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '')
    const instance = String(body.evolution_instance || existing?.evolution_instance || process.env.EVOLUTION_INSTANCE || `wacrm_${accountId.slice(0, 8)}`).trim()
    let apiKey = String(body.evolution_api_key || (plan.kind === 'create' ? process.env.EVOLUTION_API_KEY : '') || '').trim()
    if (!body.evolution_api_key && existing?.evolution_api_key) {
      try { apiKey = decrypt(existing.evolution_api_key) }
      catch { return NextResponse.json({ error: 'Não foi possível descriptografar a chave armazenada. Cole a apikey novamente.' }, { status: 400 }) }
    }
    if (!requestedBaseUrl || !instance || !apiKey) return NextResponse.json({ error: 'evolution_base_url, evolution_instance and evolution_api_key are required' }, { status: 400 })

    let baseUrl: string
    try { baseUrl = await assertSafeEvolutionBaseUrl(requestedBaseUrl) }
    catch (error) {
      console.warn('[whatsapp/config] blocked Evolution URL:', error instanceof Error ? error.message : 'invalid URL')
      return NextResponse.json({ error: 'A URL base da Evolution não é permitida pela política do servidor' }, { status: 400 })
    }

    try { await createInstance({ baseUrl, instance, apiKey }) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already exists|already registered|already in use|409|Conflict/i.test(message)) {
        return NextResponse.json({ error: 'Não foi possível criar a instância Evolution' }, { status: 400 })
      }
    }
    let qr: { base64?: string; code?: string; pairingCode?: string } = {}
    try { qr = await connectInstance({ baseUrl, instance, apiKey }) }
    catch (error) { console.warn('[whatsapp/config] QR fetch failed:', error instanceof Error ? error.message : error) }
    if (process.env.WHATSAPP_WEBHOOK_TOKEN) {
      try { await setInstanceWebhook({ baseUrl, instance, apiKey, url: siteWebhookUrl(request), webhookScopeId: accountId }) }
      catch (error) { console.warn('[whatsapp/config] webhook set failed:', error instanceof Error ? error.message : error) }
    }

    const state = await getConnectionState({ baseUrl, instance, apiKey }).catch(() => ({ state: 'connecting' }))
    const row: Record<string, unknown> = {
      evolution_base_url: baseUrl, evolution_instance: instance, evolution_api_key: encrypt(apiKey),
      connection_state: state.state, status: state.state === 'open' ? 'connected' : 'disconnected', updated_at: new Date().toISOString(),
      phone_number_id: null, waba_id: null, access_token: null, verify_token: null, registered_at: null, subscribed_apps_at: null, last_registration_error: null,
    }
    if (typeof body.department_id === 'string') row.department_id = body.department_id

    let savedId: string
    if (plan.kind === 'update') {
      const { data, error } = await supabase.from('whatsapp_config').update(row).eq('id', plan.config.id).eq('account_id', accountId).select('id').maybeSingle()
      if (error || !data) return NextResponse.json({ error: 'Não foi possível atualizar a configuração' }, { status: error ? 500 : 404 })
      savedId = data.id
    } else {
      let departmentId = typeof body.department_id === 'string' ? body.department_id : null
      if (!departmentId) {
        const { data: department } = await supabase.from('departments').select('id').eq('account_id', accountId).eq('is_default', true).maybeSingle()
        departmentId = department?.id ?? null
      }
      if (!departmentId) return NextResponse.json({ error: 'department_id is required' }, { status: 400 })
      const { data, error } = await supabase.from('whatsapp_config').insert({ account_id: accountId, user_id: userId, department_id: departmentId, is_default: configs.length === 0, provider: 'evolution', ...row }).select('id').single()
      if (error || !data) return NextResponse.json({ error: 'Não foi possível salvar a configuração' }, { status: 500 })
      savedId = data.id
    }
    return NextResponse.json({ success: true, saved: true, config_id: savedId, connection_state: state.state, instance, qrcode: qr, registration_skipped: state.state !== 'open' })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) return toErrorResponse(error)
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const configs = await loadConfigs(supabase, accountId)
    const explicitConfigId = new URL(request.url).searchParams.get('config_id')
    let config: ActiveWhatsAppConfig | null
    try {
      config = resolveWhatsAppConfigCandidates(configs, { explicitConfigId })
      if (explicitConfigId && !config) throw new WhatsAppConfigNotFoundError()
    } catch (error) {
      return selectionError(error) ?? NextResponse.json({ error: 'Não foi possível selecionar a configuração' }, { status: 500 })
    }
    if (!config) return NextResponse.json({ success: true })
    // Detach is intentionally local-only: it removes this account's CRM
    // binding without logging out or deleting a shared Evolution instance.
    // Remote deletion remains the explicit legacy DELETE path below.
    if (new URL(request.url).searchParams.get('detach') === 'true') {
      const { error } = await supabase
        .from('whatsapp_config')
        .update({ disabled_at: new Date().toISOString(), status: 'disconnected', connection_state: 'close' })
        .eq('id', config.id)
        .eq('account_id', accountId)
      if (error) return NextResponse.json({ error: 'Não foi possível remover a configuração do CRM' }, { status: 500 })
      return NextResponse.json({ success: true, detached: true, config_id: config.id })
    }
    if (config.evolution_base_url && config.evolution_instance && config.evolution_api_key) {
      const apiKey = decrypt(config.evolution_api_key)
      await logoutInstance({ baseUrl: config.evolution_base_url, instance: config.evolution_instance, apiKey }).catch(() => undefined)
      await deleteInstance({ baseUrl: config.evolution_base_url, instance: config.evolution_instance, apiKey }).catch(() => undefined)
    }
    const { error } = await supabase.from('whatsapp_config').delete().eq('id', config.id).eq('account_id', accountId)
    if (error) return NextResponse.json({ error: 'Não foi possível excluir a configuração' }, { status: 500 })
    return NextResponse.json({ success: true, config_id: config.id })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) return toErrorResponse(error)
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
