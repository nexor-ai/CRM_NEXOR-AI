import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators'

function buildUpsertRow(accountId: string, userId: string, payload: TemplatePayload) {
  return {
    account_id: accountId,
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    // EVOLUTION: templates are local presets. No Meta submission/review exists.
    status: 'APPROVED',
    meta_template_id: null,
    submission_error: null,
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(supabase: SupabaseClient, row: ReturnType<typeof buildUpsertRow>) {
  return supabase.from('message_templates').upsert(row, { onConflict: 'user_id,name,language' }).select().single()
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) return NextResponse.json({ error: 'Seu perfil não está vinculado a uma conta.' }, { status: 403 })

    let payload: TemplatePayload
    try { payload = (await request.json()) as TemplatePayload } catch { return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 }) }
    try { validateTemplatePayload(payload) } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Validation failed.' }, { status: 400 }) }

    const { data: row, error } = await upsertTemplateRow(supabase, buildUpsertRow(accountId, user.id, payload))
    if (error) return NextResponse.json({ error: `Não foi possível salvar o modelo local: ${error.message}` }, { status: 500 })
    return NextResponse.json({ success: true, template: row, local_preset: true })
  } catch (error) {
    console.error('Error saving template preset:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to save template preset.' }, { status: 500 })
  }
}
