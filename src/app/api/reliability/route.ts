import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

const RECOVERY_ALLOWLIST = new Set([
  'transcription:requeue',
  'external_operation:retry_safe',
  'webhook_event:requeue',
  'agent_run:cancel',
]);

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const url = new URL(request.url);
    const configId = url.searchParams.get('config_id');
    const departmentId = url.searchParams.get('department_id');
    const admin = supabaseAdmin();
    const jobs = admin.from('transcription_jobs')
      .select('id,status,attempts,available_at,claimed_at,completed_at,dead_letter_at,error_code,created_at')
      .eq('account_id', accountId).order('created_at', { ascending: false }).limit(100);
    let runs = admin.from('ai_agent_runs')
      .select('id,status,latency_ms,started_at,finished_at,department_id,whatsapp_config_id')
      .eq('account_id', accountId).order('started_at', { ascending: false }).limit(100);
    let operations = admin.from('external_operations')
      .select('id,status,operation_type,attempts,created_at,updated_at,department_id,whatsapp_config_id')
      .eq('account_id', accountId).in('status', ['pending', 'processing', 'failed', 'uncertain'])
      .order('created_at', { ascending: false }).limit(100);
    if (configId) { runs = runs.eq('whatsapp_config_id', configId); operations = operations.eq('whatsapp_config_id', configId); }
    if (departmentId) { runs = runs.eq('department_id', departmentId); operations = operations.eq('department_id', departmentId); }
    const [jobResult, runResult, operationResult, eventResult, reconcileResult, recoveryResult] = await Promise.all([
      jobs,
      runs,
      operations,
      admin.from('evolution_webhook_events').select('id,status,created_at,processed_at,dead_letter_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(100),
      admin.from('evolution_reconcile_checkpoints').select('*').eq('account_id', accountId).order('updated_at', { ascending: false }).limit(20),
      admin.from('reliability_recovery_requests').select('id,kind,target_id,action,reason,status,requested_by,processed_by,outcome,error_code,created_at,completed_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(100),
    ]);
    const results = [jobResult, runResult, operationResult, eventResult, reconcileResult, recoveryResult];
    return NextResponse.json({
      transcriptions: jobResult.data ?? [], agent_runs: runResult.data ?? [],
      external_operations: operationResult.data ?? [], webhook_events: eventResult.data ?? [],
      reconcile_checkpoints: reconcileResult.data ?? [], recovery_requests: recoveryResult.data ?? [],
      partial_errors: results.flatMap((result) => result.error ? [result.error.message] : []),
    });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const kind = typeof body?.kind === 'string' ? body.kind : '';
    const action = typeof body?.action === 'string' ? body.action : '';
    const targetId = typeof body?.target_id === 'string' ? body.target_id : '';
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!targetId || reason.length < 5 || !RECOVERY_ALLOWLIST.has(`${kind}:${action}`)) {
      return NextResponse.json({ error: 'Solicitação de recuperação inválida' }, { status: 400 });
    }
    const { data: created, error: createError } = await supabase
      .from('reliability_recovery_requests')
      .insert({ account_id: accountId, kind, target_id: targetId, action, reason, requested_by: userId })
      .select().single();
    if (createError) throw createError;
    const { data: executed, error: executeError } = await supabase.rpc(
      'execute_reliability_recovery_request', { p_request_id: created.id },
    );
    if (executeError) throw executeError;
    const result = Array.isArray(executed) ? executed[0] : executed;
    if (!result) return NextResponse.json({ error: 'Executor não confirmou a recuperação' }, { status: 409 });
    return NextResponse.json({ request: result }, { status: result.status === 'completed' ? 200 : 409 });
  } catch (error) { return toErrorResponse(error); }
}
