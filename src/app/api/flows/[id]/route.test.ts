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
  for (const method of ['select', 'eq', 'order']) builder[method] = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => result)
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
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

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: h.adminClient }))

import { PUT } from './route'

function request() {
  return new Request('https://crm.test/api/flows/flow-1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Flow seguro',
      nodes: [{ node_key: 'start', node_type: 'start', config: {} }],
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({
    accountId: 'account-1',
    supabase: {
      from: vi.fn(() => chain({ data: { id: 'flow-1' }, error: null })),
    },
  })
  h.rpc.mockResolvedValue({ data: { id: 'flow-1', name: 'Flow seguro' }, error: null })
  h.adminClient.mockImplementation(() => ({
    rpc: h.rpc,
    from: vi.fn(() => chain({ data: [{ node_key: 'start' }], error: null })),
  }))
})

describe('PUT /api/flows/[id]', () => {
  it('rejects viewer before opening the service-role client', async () => {
    h.requireRole.mockRejectedValueOnce(new h.ForbiddenError('agent required'))

    const response = await PUT(request(), { params: Promise.resolve({ id: 'flow-1' }) })

    expect(response.status).toBe(403)
    expect(h.adminClient).not.toHaveBeenCalled()
  })

  it('saves parent and nodes through the account-scoped atomic RPC', async () => {
    const response = await PUT(request(), { params: Promise.resolve({ id: 'flow-1' }) })

    expect(response.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('save_flow_definition_atomic', {
      p_flow_id: 'flow-1',
      p_account_id: 'account-1',
      p_patch: expect.objectContaining({ name: 'Flow seguro' }),
      p_nodes: [{ node_key: 'start', node_type: 'start', config: {} }],
    })
    expect(await response.json()).toEqual({
      flow: { id: 'flow-1', name: 'Flow seguro' },
      nodes: [{ node_key: 'start' }],
    })
  })

  it('maps a cross-account/no-row RPC result to 404', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'flow not found' },
    })

    const response = await PUT(request(), { params: Promise.resolve({ id: 'flow-1' }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Não encontrado' })
  })
})
