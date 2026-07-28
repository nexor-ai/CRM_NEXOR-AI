import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { completeClaimedExternalOperation, type ExternalOperationRecord } from '@/lib/external-operations';
import { createExternalOperationStore } from '@/lib/external-operations/supabase-store';
import { executeSupportedExternalOperation } from '@/lib/external-operations/worker';

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET ?? '';
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('claim_external_operations', {
    worker_limit: 5,
    operation_id_arg: null,
  });
  if (error) return NextResponse.json({ error: 'Não foi possível reclamar operações externas' }, { status: 500 });

  const claims = (data ?? []) as ExternalOperationRecord[];
  const store = createExternalOperationStore(admin);
  const counts = { claimed: claims.length, succeeded: 0, failed: 0, uncertain: 0, state_write_failures: 0 };

  for (const claim of claims) {
    try {
      const final = await completeClaimedExternalOperation(
        store,
        claim,
        (operation) => executeSupportedExternalOperation(admin, operation),
      );
      if (final.status === 'succeeded') counts.succeeded += 1;
      else if (final.status === 'uncertain') counts.uncertain += 1;
      else counts.failed += 1;
    } catch (claimError) {
      counts.state_write_failures += 1;
      console.error('[external-operations-worker] state write failed:', claim.id, claimError);
    }
  }

  return NextResponse.json(counts, { status: counts.state_write_failures > 0 ? 500 : 200 });
}
