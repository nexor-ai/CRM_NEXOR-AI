import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}

  const requireRole = vi.fn()
  const getCurrentAccount = vi.fn()
  const supabaseAdmin = vi.fn()
  const rpc = vi.fn()

  const profileBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  }
  profileBuilder.select.mockReturnValue(profileBuilder)
  profileBuilder.eq.mockReturnValue(profileBuilder)
  profileBuilder.single.mockResolvedValue({ data: { account_id: 'account-1' }, error: null })

  const legacyClient = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })) },
    from: vi.fn(() => profileBuilder),
  }

  const insertBuilder = {
    insert: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
  }
  insertBuilder.insert.mockReturnValue(insertBuilder)
  insertBuilder.select.mockReturnValue(insertBuilder)
  insertBuilder.single.mockResolvedValue({
    data: { id: 'flow-1', account_id: 'account-1', user_id: 'viewer-1' },
    error: null,
  })

  return {
    UnauthorizedError,
    ForbiddenError,
    requireRole,
    getCurrentAccount,
    supabaseAdmin,
    rpc,
    legacyClient,
    insertBuilder,
  }
})

vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: mocks.UnauthorizedError,
  ForbiddenError: mocks.ForbiddenError,
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      {
        status:
          error instanceof mocks.UnauthorizedError
            ? 401
            : error instanceof mocks.ForbiddenError
              ? 403
              : 500,
      },
    ),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mocks.legacyClient),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

import { POST } from './route'

function request() {
  return new Request('https://crm.test/api/flows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Viewer must not create',
      trigger_type: 'manual',
      trigger_config: {},
    }),
  })
}

describe('POST /api/flows authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRole.mockRejectedValue(
      new mocks.ForbiddenError("This action requires the 'agent' role or higher"),
    )
    mocks.supabaseAdmin.mockReturnValue({
      rpc: mocks.rpc,
    })
  })

  it('rejects a viewer before opening the service-role client', async () => {
    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled()
  })

  it('creates parent and start node through one account-scoped RPC', async () => {
    mocks.requireRole.mockResolvedValueOnce({ userId: 'agent-1', accountId: 'account-1' })
    mocks.rpc.mockResolvedValueOnce({ data: { id: 'flow-1' }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(201)
    expect(mocks.rpc).toHaveBeenCalledWith(
      'create_flow_definition_atomic',
      expect.objectContaining({
        p_user_id: 'agent-1',
        p_account_id: 'account-1',
        p_nodes: [expect.objectContaining({ node_key: 'start', node_type: 'start' })],
      }),
    )
  })
})
