import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { reconcileEvolutionMessages } from '@/app/api/whatsapp/webhook/route';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET ?? '';
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: configs, error } = await admin
    .from('whatsapp_config')
    .select('id, evolution_base_url, evolution_instance, evolution_api_key')
    .is('disabled_at', null)
    .not('evolution_base_url', 'is', null)
    .not('evolution_instance', 'is', null)
    .not('evolution_api_key', 'is', null)
    .order('last_reconciliation_at', { ascending: true, nullsFirst: true })
    .limit(1);
  if (error) {
    console.error('[evolution-reconcile-worker] config selection failed:', error);
    return NextResponse.json(
      { error: 'Não foi possível selecionar o alvo de reconciliação' },
      { status: 500 }
    );
  }
  const config = configs?.[0];
  if (!config) return NextResponse.json({ selected: 0, reconciled: 0 });

  try {
    const summary = await reconcileEvolutionMessages({
      baseUrl: config.evolution_base_url,
      instance: config.evolution_instance,
      configId: config.id,
      apiKey: decrypt(config.evolution_api_key),
      limit: 50,
    });
    return NextResponse.json({ selected: 1, reconciled: 1, config_id: config.id, ...summary });
  } catch (reconciliationError) {
    console.error('[evolution-reconcile-worker] failed:', reconciliationError);
    return NextResponse.json(
      { selected: 1, reconciled: 0, config_id: config.id, error: 'Falha na reconciliação' },
      { status: 502 }
    );
  }
}
