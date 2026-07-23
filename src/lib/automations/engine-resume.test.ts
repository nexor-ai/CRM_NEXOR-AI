import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  contactOwned: false,
  logOwned: false,
  writes: [] as Array<{ table: string; type: string; filters: Array<[string, unknown]> }>,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}))

vi.mock('./admin-client', () => {
  function builder(table: string) {
    const ops = {
      type: 'select',
      filters: [] as Array<[string, unknown]>,
    }
    const result = () => {
      h.reads.push({ table, filters: [...ops.filters] })
      if (table === 'automation_pending_executions' && ops.type === 'select') {
        return { data: { id: 'pending-1' }, error: null }
      }
      if (table === 'automation_pending_executions' && ops.type === 'update') {
        h.writes.push({ table, type: ops.type, filters: [...ops.filters] })
        return { data: { id: 'pending-1' }, error: null }
      }
      if (table === 'contacts') {
        return { data: h.contactOwned ? { id: 'contact-1' } : null, error: null }
      }
      if (table === 'automation_logs') {
        return { data: h.logOwned ? { id: 'log-1' } : null, error: null }
      }
      if (ops.type !== 'select') {
        h.writes.push({ table, type: ops.type, filters: [...ops.filters] })
      }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => {
        ops.type = 'update'
        return b
      },
      eq: (key: string, value: unknown) => {
        ops.filters.push([key, value])
        return b
      },
      is: (key: string, value: unknown) => {
        ops.filters.push([key, value])
        return b
      },
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) =>
        Promise.resolve(result()).then(onFulfilled, onRejected),
    }
    return b
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => builder(table),
      rpc: async () => ({ error: null }),
    }),
  }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(),
  engineSendTemplate: vi.fn(),
}))

import { resumePendingExecution, type PendingExecution } from './engine'

const pending = (overrides: Partial<PendingExecution> = {}): PendingExecution => ({
  id: 'pending-1',
  automation_id: 'automation-1',
  account_id: 'account-1',
  user_id: 'user-1',
  contact_id: 'contact-1',
  log_id: 'log-1',
  parent_step_id: null,
  branch: null,
  next_step_position: 1,
  context: {},
  ...overrides,
})

beforeEach(() => {
  h.contactOwned = false
  h.logOwned = false
  h.writes = []
  h.reads = []
})

describe('resumePendingExecution tenant scope', () => {
  it('fails only the scoped pending row when contact belongs to another account', async () => {
    await resumePendingExecution(pending())

    expect(h.reads.some((read) => read.table === 'automations')).toBe(false)
    expect(h.writes).toEqual([
      {
        table: 'automation_pending_executions',
        type: 'update',
        filters: [
          ['id', 'pending-1'],
          ['account_id', 'account-1'],
          ['automation_id', 'automation-1'],
          ['status', 'running'],
        ],
      },
    ])
  })

  it('does not execute steps when log is outside the automation/account scope', async () => {
    h.contactOwned = true
    h.logOwned = false

    await resumePendingExecution(pending())

    const logRead = h.reads.find((read) => read.table === 'automation_logs')
    expect(logRead?.filters).toEqual(
      expect.arrayContaining([
        ['id', 'log-1'],
        ['account_id', 'account-1'],
        ['automation_id', 'automation-1'],
        ['contact_id', 'contact-1'],
      ]),
    )
    expect(h.reads.some((read) => read.table === 'automations')).toBe(false)
    expect(h.writes.every((write) => write.table === 'automation_pending_executions')).toBe(true)
  })
})
