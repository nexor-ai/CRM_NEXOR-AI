import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

const MAX_ITEMS = 50;

export async function GET() {
  try {
    const { accountId } = await requireRole('admin');
    const admin = supabaseAdmin();
    const [
      { data: deadLetters, error: eventError },
      { data: effects, error: effectError },
      { data: externalCounts, error: externalCountError },
      { data: externalItems, error: externalItemsError },
    ] = await Promise.all([
        admin
          .from('evolution_webhook_events')
          .select('id, instance, event_type, attempts, last_error, dead_letter_at, created_at')
          .eq('account_id', accountId)
          .eq('status', 'dead_letter')
          .order('dead_letter_at', { ascending: false })
          .limit(MAX_ITEMS),
        admin
          .from('evolution_message_effects')
          .select(
            'id, message_id, effect_name, status, retry_policy, attempts, last_error, updated_at'
          )
          .eq('account_id', accountId)
          .in('status', ['failed', 'uncertain'])
          .order('updated_at', { ascending: false })
          .limit(MAX_ITEMS),
        admin.rpc('external_operations_reliability_counts', {
          account_id_arg: accountId,
        }),
        admin
          .from('external_operations')
          .select(
            'id, operation_type, status, retry_policy, attempts, max_attempts, available_at, claimed_at, completed_at, created_at, updated_at, last_error'
          )
          .eq('account_id', accountId)
          .in('status', ['pending', 'processing', 'failed', 'uncertain'])
          .order('updated_at', { ascending: false })
          .limit(MAX_ITEMS),
      ]);
    if (eventError) throw new Error(`Could not load dead-letter events: ${eventError.message}`);
    if (effectError) throw new Error(`Could not load effect checkpoints: ${effectError.message}`);
    if (externalCountError) throw new Error(`Could not load external operation counts: ${externalCountError.message}`);
    if (externalItemsError) throw new Error(`Could not load external operations: ${externalItemsError.message}`);
    const counts = Array.isArray(externalCounts) ? externalCounts[0] : externalCounts;
    return NextResponse.json({
      dead_letter_events: deadLetters ?? [],
      effect_checkpoints: effects ?? [],
      external_operations: {
        counts: counts ?? {
          pending: 0,
          processing: 0,
          failed: 0,
          uncertain: 0,
          dead_letter: 0,
        },
        items: externalItems ?? [],
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    console.error('[whatsapp/reliability] inspection failed:', error);
    return NextResponse.json({ error: 'Não foi possível inspecionar o estado de confiabilidade' }, { status: 500 });
  }
}

type RecoveryBody =
  | { kind: 'event'; id: string; action: 'requeue' }
  | { kind: 'effect'; id: string; action: 'retry' | 'mark_completed' }
  | { kind: 'external_operation'; id: string; action: 'retry' };

export async function POST(request: Request) {
  try {
    const { userId, accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as RecoveryBody | null;
    if (!body || typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ error: 'É necessário um id válido de item de confiabilidade' }, { status: 400 });
    }
    const admin = supabaseAdmin();
    const now = new Date().toISOString();

    if (body.kind === 'event' && body.action === 'requeue') {
      const { data, error } = await admin
        .from('evolution_webhook_events')
        .update({
          status: 'failed',
          attempts: 0,
          available_at: now,
          claimed_at: null,
          dead_letter_at: null,
          last_error: `Reenfileirado manualmente por ${userId}`,
          updated_at: now,
        })
        .eq('id', body.id)
        .eq('account_id', accountId)
        .eq('status', 'dead_letter')
        .select('id, status')
        .maybeSingle();
      if (error) throw new Error(`Could not requeue event: ${error.message}`);
      if (!data) return NextResponse.json({ error: 'Evento de dead-letter não encontrado' }, { status: 404 });
      return NextResponse.json({ success: true, item: data });
    }

    if (body.kind === 'effect' && body.action === 'retry') {
      const { data, error } = await admin
        .from('evolution_message_effects')
        .update({
          status: 'failed',
          manual_retry_at: now,
          last_error: `Nova tentativa manual aprovada por ${userId}`,
          lease_expires_at: null,
          updated_at: now,
        })
        .eq('id', body.id)
        .eq('account_id', accountId)
        .eq('retry_policy', 'retry_safe')
        .in('status', ['failed', 'uncertain'])
        .select('id, status, retry_policy, manual_retry_at')
        .maybeSingle();
      if (error) throw new Error(`Could not schedule effect retry: ${error.message}`);
      if (!data) return NextResponse.json({ error: 'Efeito recuperável não encontrado' }, { status: 404 });
      return NextResponse.json({ success: true, item: data });
    }

    if (body.kind === 'effect' && body.action === 'mark_completed') {
      const { data, error } = await admin
        .from('evolution_message_effects')
        .update({
          status: 'completed',
          result: { manually_resolved: true, resolved_by: userId },
          completed_at: now,
          manual_retry_at: null,
          lease_expires_at: null,
          updated_at: now,
        })
        .eq('id', body.id)
        .eq('account_id', accountId)
        .in('status', ['failed', 'uncertain'])
        .select('id, status')
        .maybeSingle();
      if (error) throw new Error(`Could not resolve effect: ${error.message}`);
      if (!data) return NextResponse.json({ error: 'Efeito recuperável não encontrado' }, { status: 404 });
      return NextResponse.json({ success: true, item: data });
    }

    if (body.kind === 'external_operation' && body.action === 'retry') {
      const { data, error } = await admin.rpc('retry_external_operation', {
        operation_id_arg: body.id,
        account_id_arg: accountId,
        requested_by_arg: userId,
      });
      if (error) {
        return NextResponse.json({ error: 'Operação externa não é recuperável com segurança' }, { status: 404 });
      }
      const confirmed = Array.isArray(data) ? data[0] : data;
      if (!confirmed) {
        return NextResponse.json({ error: 'Operação externa não é recuperável com segurança' }, { status: 404 });
      }
      return NextResponse.json({ success: true, item: confirmed });
    }

    return NextResponse.json({ error: 'Ação de confiabilidade não suportada' }, { status: 400 });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    console.error('[whatsapp/reliability] recovery failed:', error);
    return NextResponse.json({ error: 'Não foi possível atualizar o estado de confiabilidade' }, { status: 500 });
  }
}
