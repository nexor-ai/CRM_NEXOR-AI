import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { listEvolutionInstances } from '@/lib/whatsapp/evolution-api'
import { assertSafeEvolutionBaseUrl } from '@/lib/whatsapp/evolution-url-safety'
import { resolveWhatsAppConfigCandidates, type ActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config'

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select('id, account_id, user_id, evolution_base_url, evolution_instance, evolution_api_key, connection_state, status, department_id, is_default')
      .eq('account_id', accountId)
      .is('disabled_at', null)
      .order('created_at', { ascending: true })
    if (error) throw error

    const configs = (data ?? []) as ActiveWhatsAppConfig[]
    let selected: ActiveWhatsAppConfig | null = null
    try {
      selected = resolveWhatsAppConfigCandidates(configs)
    } catch {
      selected = configs.find((item) => item.is_default) ?? configs[0] ?? null
    }

    const requestedBaseUrl = selected?.evolution_base_url || process.env.EVOLUTION_API_URL || ''
    const apiKey = selected?.evolution_api_key
      ? decrypt(selected.evolution_api_key)
      : process.env.EVOLUTION_API_KEY || ''
    if (!requestedBaseUrl || !apiKey) {
      return NextResponse.json({ instances: [], source: 'unconfigured' })
    }

    const baseUrl = await assertSafeEvolutionBaseUrl(requestedBaseUrl)
    const remote = await listEvolutionInstances({ baseUrl, apiKey })
    const localByName = new Map(configs.map((item) => [item.evolution_instance, item]))
    const { data: globallyLinked, error: globallyLinkedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id, evolution_instance, evolution_base_url')
      .is('disabled_at', null)
      .eq('evolution_base_url', baseUrl)
    if (globallyLinkedError) throw globallyLinkedError
    const foreignInstanceNames = new Set(
      (globallyLinked ?? [])
        .filter((item) => item.account_id !== accountId && item.evolution_instance)
        .map((item) => String(item.evolution_instance)),
    )
    return NextResponse.json({
      source: 'evolution',
      base_url: baseUrl,
      source_config_id: selected?.id ?? null,
      instances: remote
        .filter((item) => !foreignInstanceNames.has(item.name) || localByName.has(item.name))
        .map((item) => {
        const local = localByName.get(item.name) ?? null
        return {
          name: item.name,
          state: item.state,
          linked: Boolean(local),
          config_id: local?.id ?? null,
          department_id: local?.department_id ?? null,
          local_connection_state: local?.connection_state ?? null,
        }
      }),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
