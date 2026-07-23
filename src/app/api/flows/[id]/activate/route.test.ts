import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    requireRole: vi.fn(),
    adminClient: vi.fn(),
    mutationResult: { data: null as unknown, error: null as { message: string } | null },
  }
})

function chain(result: () => unknown) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'update']) {
    builder[method] = vi.fn(() => builder)
  }
  builder.maybeSingle = vi.fn(async () => result())
  return builder
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'error' },
      { status: error instanceof h.ForbiddenError ? 403 : 500 },
    ),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: h.adminClient,
}))

vi.mock('@/lib/flows/validate', () => ({
  validateFlowForActivation: vi.fn(() => []),
}))

import { POST } from './route'

function request(status = 'draft') {
  return new Request('https://crm.test/api/flows/flow-1/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.mutationResult = { data: null, error: null }
  h.requireRole.mockResolvedValue({
    accountId: 'account-1',
    supabase: {
      from: vi.fn(() => chain(() => ({ data: { id: 'flow-1' }, error: null }))),
    },
  })
  h.adminClient.mockImplementation(() => ({
    from: vi.fn(() => chain(() => h.mutationResult)),
  }))
})

describe('POST /api/flows/[id]/activate', () => {
  it('rejects viewer before opening the service-role client', async () => {
    h.requireRole.mockRejectedValueOnce(new h.ForbiddenError('agent required'))

    const response = await POST(request(), { params: Promise.resolve({ id: 'flow-1' }) })

    expect(response.status).toBe(403)
    expect(h.adminClient).not.toHaveBeenCalled()
  })

  it('returns 404 instead of false success when the scoped update affects no row', async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: 'flow-1' }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Não encontrado' })
  })

  it('returns the updated flow when the scoped mutation affects one row', async () => {
    h.mutationResult = { data: { id: 'flow-1', status: 'draft' }, error: null }

    const response = await POST(request(), { params: Promise.resolve({ id: 'flow-1' }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ flow: { id: 'flow-1', status: 'draft' } })
  })
})
