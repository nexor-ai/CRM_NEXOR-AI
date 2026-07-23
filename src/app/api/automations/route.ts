import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getTemplate } from '@/lib/automations/templates'
import { buildStepRows, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

export async function GET() {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data, error } = await ctx.supabase
    .from('automations')
    .select('*')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ automations: data ?? [] })
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })

  const { name, description, trigger_type, trigger_config, is_active, steps, template } = body

  let effectiveSteps: BuilderStepInput[] | undefined = steps
  let effectiveName = name
  let effectiveDescription = description
  let effectiveTriggerType = trigger_type
  let effectiveTriggerConfig = trigger_config

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template)
    if (t) {
      effectiveName = effectiveName ?? t.name
      effectiveDescription = effectiveDescription ?? t.description
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
      effectiveSteps = t.steps as unknown as BuilderStepInput[]
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'name and trigger_type are required' },
      { status: 400 },
    )
  }

  // Block activation of a clearly broken automation up-front instead of
  // letting every trigger silently produce a failed log row. Drafts
  // (is_active=false) are allowed to be incomplete so users can save
  // progress mid-build.
  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
      ),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Não é possível ativar a automação com configuração inválida', issues },
        { status: 400 },
      )
    }
  }

  const admin = supabaseAdmin()
  const automationId = crypto.randomUUID()
  const stepRows = buildStepRows(automationId, effectiveSteps ?? [])
  const { data: automation, error: insertErr } = await admin.rpc(
    'create_automation_definition_atomic',
    {
      p_user_id: ctx.userId,
      p_account_id: ctx.accountId,
      p_definition: {
      name: effectiveName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      is_active: !!is_active,
      },
      p_steps: stepRows,
    },
  )

  if (insertErr || !automation) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'insert failed' },
      { status: 500 },
    )
  }

  return NextResponse.json({ automation }, { status: 201 })
}
