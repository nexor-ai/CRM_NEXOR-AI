import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const API_ROOT = join(process.cwd(), 'src/app/api')

const interactiveMutations = [
  'flows/route.ts',
  'flows/[id]/route.ts',
  'flows/[id]/activate/route.ts',
  'automations/route.ts',
  'automations/[id]/route.ts',
  'automations/[id]/duplicate/route.ts',
  'automations/engine/route.ts',
]

const adminResourceRoutes = [
  'flows/route.ts',
  'flows/[id]/route.ts',
  'flows/[id]/activate/route.ts',
  'automations/route.ts',
  'automations/[id]/route.ts',
  'automations/[id]/duplicate/route.ts',
]

describe('Flows and Automations authorization contract', () => {
  it.each(interactiveMutations)('%s gates interactive mutations at agent+', (relative) => {
    const source = readFileSync(join(API_ROOT, relative), 'utf8')

    expect(source).toMatch(/requireRole\(['"]agent['"]\)/)
  })

  it.each(adminResourceRoutes)('%s scopes service-role resources by account_id', (relative) => {
    const source = readFileSync(join(API_ROOT, relative), 'utf8')

    expect(source).toContain(".eq('account_id'")
  })

  it.each([
    'automations/[id]/route.ts',
    'automations/[id]/duplicate/route.ts',
  ])('%s does not use author identity as tenant ownership', (relative) => {
    const source = readFileSync(join(API_ROOT, relative), 'utf8')

    expect(source).not.toContain(".eq('user_id'")
    expect(source).not.toContain('.eq("user_id"')
  })
})

describe('Evolution webhook multi-instance authorization contract', () => {
  const webhookSource = readFileSync(join(API_ROOT, 'whatsapp/webhook/route.ts'), 'utf8')
  const workerSource = readFileSync(join(API_ROOT, 'internal/evolution/cron/route.ts'), 'utf8')

  it('requires account scope before resolving a repeated instance name', () => {
    expect(webhookSource).toContain("request.headers.get('x-wacrm-webhook-scope')")
    expect(webhookSource).toContain(".eq('account_id', accountScope)")
    expect(webhookSource).toMatch(/configRows\?\.length !== 1/)
  })

  it('propagates durable account and config identity into the worker', () => {
    expect(workerSource).toContain('accountId: claim.account_id')
    expect(workerSource).toContain('configId: claim.whatsapp_config_id')
  })
})
