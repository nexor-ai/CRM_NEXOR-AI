import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'

/**
 * Manual trigger for testing or for external integrations that want
 * to fire automations. Auth is required — we resolve the caller's
 * account_id and dispatch over the account's automations.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body?.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }

  if (body.contact_id) {
    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', body.contact_id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!contact) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  }

  if (body.context?.conversation_id) {
    let query = ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', body.context.conversation_id)
      .eq('account_id', ctx.accountId)
    if (body.contact_id) query = query.eq('contact_id', body.contact_id)
    const { data: conversation } = await query.maybeSingle()
    if (!conversation) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  }

  await runAutomationsForTrigger({
    accountId: ctx.accountId,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId: body.contact_id ?? null,
    context: body.context ?? {},
  })

  return NextResponse.json({ ok: true })
}
