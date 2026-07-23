import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  buildStepRows,
  loadStepsTree,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })

  const steps = await loadStepsTree(id)
  return NextResponse.json({ automation, steps })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })

  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('automations')
    .select('id, account_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k]
  }

  const willBeActive =
    typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
    const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
      : await loadStepsTree(id)
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Não é possível manter a automação ativa com configuração inválida',
          issues,
        },
        { status: 400 },
      )
    }
  }

  const stepRows = Array.isArray(body.steps)
    ? buildStepRows(id, body.steps as BuilderStepInput[])
    : null
  const { error: saveError } = await admin.rpc('save_automation_definition_atomic', {
    p_automation_id: id,
    p_account_id: ctx.accountId,
    p_patch: update,
    p_steps: stepRows,
  })
  if (saveError) {
    const status = saveError.code === 'P0002' ? 404 : 500
    return NextResponse.json(
      { error: status === 404 ? 'Não encontrado' : saveError.message },
      { status },
    )
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('automations')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })

  const { data: deleted, error } = await admin
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!deleted) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
