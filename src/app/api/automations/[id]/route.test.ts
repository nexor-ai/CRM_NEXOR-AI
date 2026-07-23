import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    requireRole: vi.fn(),
    adminClient: vi.fn(),
    rpc: vi.fn(),
  }
})

function chain(result: unknown) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => result)
  return builder
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: h.requireRole,
  requireRole: h.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'error' },
      { status: error instanceof h.ForbiddenError ? 403 : 500 },
    ),
}))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: h.adminClient }))

import { PATCH } from './route'

function request() {
  return new Request('https://crm.test/api/automations/automation-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Automação segura',
      steps: [
        {
          id: 'browser-controlled-id',
          step_type: 'condition',
          step_config: {},
          branches: {
            yes: [{ step_type: 'send_message', step_config: { text: 'ok' } }],
            no: [],
          },
        },
      ],
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({ accountId: 'account-1' })
  h.rpc.mockResolvedValue({ data: { id: 'automation-1' }, error: null })
  h.adminClient.mockImplementation(() => ({
    rpc: h.rpc,
    from: vi.fn(() => chain({ data: { id: 'automation-1' }, error: null })),
  }))
})

describe('PATCH /api/automations/[id]', () => {
  it('rejects viewer before opening the service-role client', async () => {
    h.requireRole.mockRejectedValueOnce(new h.ForbiddenError('agent required'))

    const response = await PATCH(request(), {
      params: Promise.resolve({ id: 'automation-1' }),
    })

    expect(response.status).toBe(403)
    expect(h.adminClient).not.toHaveBeenCalled()
  })

  it('uses the account-scoped atomic RPC and regenerates browser step IDs', async () => {
    const response = await PATCH(request(), {
      params: Promise.resolve({ id: 'automation-1' }),
    })

    expect(response.status).toBe(200)
    const [, args] = h.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(h.rpc.mock.calls[0][0]).toBe('save_automation_definition_atomic')
    expect(args).toMatchObject({
      p_automation_id: 'automation-1',
      p_account_id: 'account-1',
      p_patch: { name: 'Automação segura' },
    })
    const rows = args.p_steps as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0].id).not.toBe('browser-controlled-id')
    expect(rows[1].parent_step_id).toBe(rows[0].id)
    expect(rows[1].branch).toBe('yes')
  })

  it('maps a cross-account/no-row RPC result to 404', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'automation not found' },
    })

    const response = await PATCH(request(), {
      params: Promise.resolve({ id: 'automation-1' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Não encontrado' })
  })
})
