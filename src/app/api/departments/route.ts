import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;

function departmentBody(value: unknown): { name: string; description: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as { name?: unknown; description?: unknown };
  if (typeof body.name !== 'string') return null;
  const name = body.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  if (body.description != null && typeof body.description !== 'string') return null;
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > MAX_DESCRIPTION_LENGTH) return null;
  return { name, description: description || null };
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    let query = ctx.supabase
      .from('departments')
      .select(
        'id, account_id, name, description, is_default, created_at, updated_at, department_memberships(user_id), whatsapp_config(id, evolution_instance, phone_number_id, connection_state, disabled_at, is_default)',
      )
      .eq('account_id', ctx.accountId);

    // Admin+ is global within the account. Agents/viewers receive only rows
    // carrying their membership; RLS in 047 independently enforces this.
    if (!hasMinRole(ctx.role, 'admin')) {
      query = query.eq('department_memberships.user_id', ctx.userId);
    }

    const { data, error } = await query.order('created_at', { ascending: true });
    if (error) {
      console.error('[GET /api/departments] fetch error:', error);
      return NextResponse.json({ error: 'Não foi possível carregar os departamentos' }, { status: 500 });
    }
    return NextResponse.json({ departments: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = departmentBody(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json(
        { error: `Informe um nome de até ${MAX_NAME_LENGTH} caracteres` },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from('departments')
      .insert({
        account_id: ctx.accountId,
        name: body.name,
        description: body.description,
        created_by_user_id: ctx.userId,
      })
      .select('id, account_id, name, description, is_default, created_at, updated_at')
      .single();

    if (error || !data) {
      const conflict = error?.code === '23505';
      return NextResponse.json(
        { error: conflict ? 'Já existe um departamento com esse nome' : 'Não foi possível criar o departamento' },
        { status: conflict ? 409 : 500 },
      );
    }
    return NextResponse.json({ department: data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
