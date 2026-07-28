import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';

const MODES = new Set(['disabled', 'draft_only', 'supervised', 'auto_reply']);
export async function GET() {
  try { const { supabase, accountId } = await getCurrentAccount(); const { data, error } = await supabase.from('ai_agents').select('*, ai_agent_bindings(*)').eq('account_id', accountId).order('is_default', { ascending: false }).order('name'); if (error) throw error; return NextResponse.json({ agents: data ?? [] }); } catch (error) { return toErrorResponse(error); }
}
export async function POST(request: Request) {
  try { const { supabase, accountId, userId } = await requireRole('admin'); const body = await request.json().catch(() => null); const name = typeof body?.name === 'string' ? body.name.trim() : ''; const mode = typeof body?.mode === 'string' ? body.mode : 'draft_only'; if (!name || !MODES.has(mode)) return NextResponse.json({ error: 'Nome ou modo inválido' }, { status: 400 }); if (mode === 'auto_reply' && body?.confirm_auto_reply !== true) return NextResponse.json({ error: 'auto_reply exige confirmação explícita' }, { status: 400 }); const { data, error } = await supabase.from('ai_agents').insert({ account_id: accountId, created_by: userId, name, description: body.description ?? null, system_prompt: body.system_prompt ?? null, mode, is_default: false, daily_reply_cap: Math.max(0, Math.min(10000, Number(body.daily_reply_cap) || 50)), monthly_budget_cents: Math.max(0, Number(body.monthly_budget_cents) || 0) }).select().single(); if (error) throw error; return NextResponse.json({ agent: data }, { status: 201 }); } catch (error) { return toErrorResponse(error); }
}
