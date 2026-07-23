import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    UnauthorizedError,
    ForbiddenError,
    requireRole: vi.fn(),
    getCurrentAccount: vi.fn(),
    runAutomationsForTrigger: vi.fn(),
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

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mocks.runAutomationsForTrigger,
}))

import { POST } from './route'

function request(body: Record<string, unknown> = {}) {
  return new Request('https://crm.test/api/automations/engine', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger_type: 'new_message_received', ...body }),
  })
}

describe('POST /api/automations/engine authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentAccount.mockResolvedValue({ accountId: 'account-1', role: 'viewer' })
    mocks.requireRole.mockRejectedValue(
      new mocks.ForbiddenError("This action requires the 'agent' role or higher"),
    )
  })

  it('rejects a viewer before dispatching automations', async () => {
    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(mocks.runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('returns 404 for a contact outside the caller account without dispatching', async () => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {}
    for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder)
    builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
    mocks.requireRole.mockResolvedValueOnce({
      accountId: 'account-1',
      supabase: { from: vi.fn(() => builder) },
    })

    const response = await POST(request({ contact_id: 'foreign-contact' }))

    expect(response.status).toBe(404)
    expect(builder.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(mocks.runAutomationsForTrigger).not.toHaveBeenCalled()
  })
})
