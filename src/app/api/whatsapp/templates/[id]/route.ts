import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { validateTemplatePayload, type TemplatePayload } from '@/lib/whatsapp/template-validators'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function accountForCurrentUser() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { supabase, user: null, accountId: null }
  const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).maybeSingle()
  return { supabase, user, accountId: profile?.account_id as string | undefined }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'ID de modelo inválido.' }, { status: 400 })
  const { supabase, accountId } = await accountForCurrentUser()
  if (!accountId) return NextResponse.json({ error: 'Não autorizado ou conta ausente.' }, { status: 401 })
  let payload: TemplatePayload
  try { payload = (await request.json()) as TemplatePayload } catch { return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 }) }
  try { validateTemplatePayload(payload) } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Validation failed.' }, { status: 400 }) }
  const { data: row, error } = await supabase.from('message_templates').update({
    category: payload.category,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: 'APPROVED',
    meta_template_id: null,
    submission_error: null,
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }).eq('id', id).eq('account_id', accountId).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, template: row, local_preset: true })
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'ID de modelo inválido.' }, { status: 400 })
  const { supabase, accountId } = await accountForCurrentUser()
  if (!accountId) return NextResponse.json({ error: 'Não autorizado ou conta ausente.' }, { status: 401 })
  const { error } = await supabase.from('message_templates').delete().eq('id', id).eq('account_id', accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // EVOLUTION: local delete only; no remote template lifecycle exists.
  return NextResponse.json({ success: true, local_preset: true })
}
