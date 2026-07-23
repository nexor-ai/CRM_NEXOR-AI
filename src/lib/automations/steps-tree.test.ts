import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: async (rows: Array<Record<string, unknown>>) => {
        mocks.inserted = rows
        return { error: null }
      },
    }),
  }),
}))

import { insertSteps } from './steps-tree'

describe('insertSteps integrity', () => {
  beforeEach(() => {
    mocks.inserted = []
  })

  it('ignores browser-provided ids and keeps generated parent references consistent', async () => {
    const error = await insertSteps('automation-1', [
      {
        id: 'attacker-controlled-parent',
        step_type: 'condition',
        step_config: {},
        branches: {
          yes: [
            {
              id: 'attacker-controlled-child',
              step_type: 'send_message',
              step_config: { text: 'ok' },
            },
          ],
        },
      },
    ])

    expect(error).toBeNull()
    expect(mocks.inserted).toHaveLength(2)
    const [parent, child] = mocks.inserted
    expect(parent.id).not.toBe('attacker-controlled-parent')
    expect(child.id).not.toBe('attacker-controlled-child')
    expect(child.parent_step_id).toBe(parent.id)
    expect(parent.automation_id).toBe('automation-1')
    expect(child.automation_id).toBe('automation-1')
  })
})
