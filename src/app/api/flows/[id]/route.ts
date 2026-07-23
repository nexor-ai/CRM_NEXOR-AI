import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

type AccountContext = Awaited<ReturnType<typeof getCurrentAccount>>

type AccessResult =
  | { ok: true; ctx: AccountContext }
  | { ok: false; status: number; body: { error: string } }

async function requireFlowAccess(flowId: string, mutate: boolean): Promise<AccessResult> {
  let ctx: AccountContext
  try {
    ctx = mutate ? await requireRole('agent') : await getCurrentAccount()
  } catch (err) {
    const response = toErrorResponse(err)
    return {
      ok: false,
      status: response.status,
      body: (await response.json()) as { error: string },
    }
  }

  const { data: flow } = await ctx.supabase
    .from('flows')
    .select('id')
    .eq('id', flowId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Não encontrado' } }
  }
  return { ok: true, ctx }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireFlowAccess(id, false)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })
  const { supabase } = guard.ctx

  const [{ data: flow, error: flowError }, { data: nodes, error: nodesError }] = await Promise.all([
    supabase
      .from('flows')
      .select('*')
      .eq('id', id)
      .eq('account_id', guard.ctx.accountId)
      .maybeSingle(),
    supabase
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (flowError || nodesError) {
    return NextResponse.json(
      { error: flowError?.message ?? nodesError?.message ?? 'Falha ao carregar flow' },
      { status: 500 },
    )
  }
  if (!flow) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  return NextResponse.json({ flow, nodes: nodes ?? [] })
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireFlowAccess(id, true)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const body = (await request.json().catch(() => null)) as PutBody | null
  if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const flowPatch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) flowPatch.name = body.name.trim()
  if (body.description !== undefined) flowPatch.description = body.description
  if (body.trigger_type !== undefined) flowPatch.trigger_type = body.trigger_type
  if (body.trigger_config !== undefined) flowPatch.trigger_config = body.trigger_config
  if (body.entry_node_id !== undefined) flowPatch.entry_node_id = body.entry_node_id
  if (body.fallback_policy !== undefined) flowPatch.fallback_policy = body.fallback_policy

  const { data: savedFlow, error: saveError } = await admin.rpc(
    'save_flow_definition_atomic',
    {
      p_flow_id: id,
      p_account_id: guard.ctx.accountId,
      p_patch: flowPatch,
      p_nodes: body.nodes === undefined ? null : body.nodes,
    },
  )
  if (saveError) {
    const status = saveError.code === 'P0002' ? 404 : 500
    return NextResponse.json(
      { error: status === 404 ? 'Não encontrado' : saveError.message },
      { status },
    )
  }

  const { data: nodes, error: nodesError } = await admin
    .from('flow_nodes')
    .select('*')
    .eq('flow_id', id)
    .order('created_at', { ascending: true })
  if (nodesError) return NextResponse.json({ error: nodesError.message }, { status: 500 })
  return NextResponse.json({ flow: savedFlow, nodes: nodes ?? [] })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireFlowAccess(id, true)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const { data: deleted, error } = await supabaseAdmin()
    .from('flows')
    .delete()
    .eq('id', id)
    .eq('account_id', guard.ctx.accountId)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!deleted) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
