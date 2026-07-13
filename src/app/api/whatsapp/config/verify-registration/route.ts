import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getConnectionState } from '@/lib/whatsapp/evolution-api'

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).maybeSingle()
  if (!profile?.account_id) return NextResponse.json({ live: false, checks: { account: false }, errors: ['No account linked.'] })
  const { data: config } = await supabase.from('whatsapp_config').select('*').eq('account_id', profile.account_id).maybeSingle()
  if (!config?.evolution_base_url || !config?.evolution_instance || !config?.evolution_api_key) return NextResponse.json({ live: false, checks: { configured: false }, errors: ['Evolution API is not configured.'] })

  let apiKey: string
  try { apiKey = decrypt(config.evolution_api_key) }
  catch { return NextResponse.json({ live: false, checks: { configured: true, decrypted: false }, errors: ['Stored Evolution API key cannot be decrypted.'] }) }

  try {
    const state = await getConnectionState({ baseUrl: config.evolution_base_url, instance: config.evolution_instance, apiKey })
    await supabase.from('whatsapp_config').update({ connection_state: state.state, status: state.state === 'open' ? 'connected' : 'disconnected' }).eq('id', config.id)
    return NextResponse.json({ live: state.state === 'open', connection_state: state.state, checks: { configured: true, instance_open: state.state === 'open' } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Evolution API error'
    return NextResponse.json({ live: false, checks: { configured: true, instance_open: false }, errors: [`Evolution API rejected the credentials: ${message}`] })
  }
}
