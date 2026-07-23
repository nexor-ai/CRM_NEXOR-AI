import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { processEvolutionWebhook } from '@/app/api/whatsapp/webhook/route'

type WebhookEventClaim = {
  id: string
  payload: Record<string, unknown>
  attempts: number
  claim_token: string
}

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET ?? ''
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(expected)
  const b = Buffer.from(supplied)
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('claim_evolution_webhook_events', {
    worker_limit: 1,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const claims = (data ?? []) as WebhookEventClaim[]
  let processed = 0
  let failed = 0
  let deadLettered = 0
  let stateWriteFailures = 0

  for (const claim of claims) {
    try {
      const outcome = await processEvolutionWebhook(claim.payload, 'webhook')
      const { error: updateError } = await admin.rpc('finish_evolution_webhook_event', {
        event_id_arg: claim.id,
        claim_token_arg: claim.claim_token,
        succeeded_arg: true,
        error_arg: outcome === 'ignored' ? 'Event acknowledged as ignored' : null,
      })
      if (updateError) throw updateError
      processed += 1
    } catch (claimError) {
      const message = claimError instanceof Error ? claimError.message : 'Unknown webhook processing error'
      const { data: finalStatus, error: failureUpdateError } = await admin.rpc(
        'finish_evolution_webhook_event',
        {
          event_id_arg: claim.id,
          claim_token_arg: claim.claim_token,
          succeeded_arg: false,
          error_arg: message,
        }
      )
      if (failureUpdateError) {
        stateWriteFailures += 1
        console.error('[evolution-worker] failed to persist retry state:', claim.id, failureUpdateError.message)
      }
      if (finalStatus === 'dead_letter') deadLettered += 1
      failed += 1
      console.error('[evolution-worker] event failed:', claim.id, message)
    }
  }

  return NextResponse.json(
    {
      claimed: claims.length,
      processed,
      failed,
      dead_lettered: deadLettered,
      state_write_failures: stateWriteFailures,
    },
    { status: stateWriteFailures > 0 ? 500 : 200 }
  )
}
