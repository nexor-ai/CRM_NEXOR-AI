import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    const { count, error } = await supabase.from('message_templates').select('id', { count: 'exact', head: true }).eq('account_id', accountId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // EVOLUTION: no remote template catalog exists. Existing local presets are already authoritative.
    return NextResponse.json({ success: true, total: count ?? 0, inserted: 0, updated: 0, errors: [], local_only: true })
  } catch (error) {
    console.error('Error checking local WhatsApp presets:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to check local presets' }, { status: 500 })
  }
}
