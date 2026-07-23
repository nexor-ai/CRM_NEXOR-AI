import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function POST(
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
  const { data: original, error: origErr } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (origErr) return NextResponse.json({ error: origErr.message }, { status: 500 })
  if (!original) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })

  const { data: steps, error: stepsError } = await admin
    .from('automation_steps')
    .select('id, parent_step_id, branch, step_type, step_config, position')
    .eq('automation_id', id)
    .order('position', { ascending: true })
  if (stepsError) return NextResponse.json({ error: stepsError.message }, { status: 500 })

  const idMap = new Map<string, string>()
  for (const row of steps ?? []) idMap.set(row.id as string, crypto.randomUUID())
  const rows = (steps ?? []).map((row) => ({
    id: idMap.get(row.id as string)!,
    automation_id: '00000000-0000-0000-0000-000000000000',
    parent_step_id: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
    branch: row.branch,
    step_type: row.step_type,
    step_config: row.step_config,
    position: row.position,
  }))

  const { data: copy, error: copyErr } = await admin.rpc(
    'create_automation_definition_atomic',
    {
      p_user_id: ctx.userId,
      p_account_id: ctx.accountId,
      p_definition: {
        name: `${original.name} (Copy)`,
        description: original.description,
        trigger_type: original.trigger_type,
        trigger_config: original.trigger_config,
        is_active: false,
      },
      p_steps: rows,
    },
  )
  if (copyErr || !copy) {
    return NextResponse.json({ error: copyErr?.message ?? 'copy failed' }, { status: 500 })
  }

  return NextResponse.json({ automation: copy }, { status: 201 })
}
