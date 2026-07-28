import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';

interface PatchBody {
  name?: unknown;
  description?: unknown;
  memberIds?: unknown;
  whatsappConfigIds?: unknown;
}

function stringIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return [...new Set(value as string[])];
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as PatchBody | null;
    if (!body) return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 });

    const changes: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) {
        return NextResponse.json({ error: 'Nome inválido' }, { status: 400 });
      }
      changes.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return NextResponse.json({ error: 'Descrição inválida' }, { status: 400 });
      }
      changes.description = typeof body.description === 'string' ? body.description.trim() || null : null;
    }

    let data: unknown = { id };
    if (Object.keys(changes).length > 0) {
      const result = await ctx.supabase
        .from('departments')
        .update(changes)
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .select('id, account_id, name, description, is_default, created_at, updated_at')
        .maybeSingle();
      if (result.error) {
        const status = result.error.code === '23505' ? 409 : 500;
        return NextResponse.json({ error: status === 409 ? 'Nome de departamento já utilizado' : 'Não foi possível atualizar o departamento' }, { status });
      }
      if (!result.data) return NextResponse.json({ error: 'Departamento não encontrado' }, { status: 404 });
      data = result.data;
    }

    const memberIds = stringIds(body.memberIds);
    const configIds = stringIds(body.whatsappConfigIds);
    if (memberIds === null || configIds === null) {
      return NextResponse.json({ error: 'Associações inválidas' }, { status: 400 });
    }

    if (body.memberIds !== undefined || body.whatsappConfigIds !== undefined) {
      const { data: department, error: lookupError } = await ctx.supabase
        .from('departments')
        .select('id, is_default')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (lookupError) return NextResponse.json({ error: 'Não foi possível validar o departamento' }, { status: 500 });
      if (!department) return NextResponse.json({ error: 'Departamento não encontrado' }, { status: 404 });

      if (body.memberIds !== undefined) {
        const { data: profiles, error: profileError } = await ctx.supabase
          .from('profiles')
          .select('user_id')
          .eq('account_id', ctx.accountId)
          .in('user_id', memberIds);
        if (profileError || (profiles?.length ?? 0) !== memberIds.length) {
          return NextResponse.json({ error: 'Um ou mais membros não pertencem à conta' }, { status: 400 });
        }
        if (!department.is_default) {
          const deleteResult = await ctx.supabase
            .from('department_memberships')
            .delete()
            .eq('department_id', id)
            .eq('account_id', ctx.accountId);
          if (deleteResult.error) return NextResponse.json({ error: 'Não foi possível atualizar membros' }, { status: 500 });
        }
        if (memberIds.length > 0) {
          const upsertResult = await ctx.supabase.from('department_memberships').upsert(
            memberIds.map((userId) => ({ department_id: id, account_id: ctx.accountId, user_id: userId, created_by_user_id: ctx.userId })),
            { onConflict: 'department_id,user_id' },
          );
          if (upsertResult.error) return NextResponse.json({ error: 'Não foi possível associar membros' }, { status: 500 });
        }
      }

      if (body.whatsappConfigIds !== undefined) {
        const { data: configs, error: configError } = await ctx.supabase
          .from('whatsapp_config')
          .select('id')
          .eq('account_id', ctx.accountId)
          .in('id', configIds);
        if (configError || (configs?.length ?? 0) !== configIds.length) {
          return NextResponse.json({ error: 'Um ou mais números não pertencem à conta' }, { status: 400 });
        }
        if (configIds.length > 0) {
          const configUpdate = await ctx.supabase
            .from('whatsapp_config')
            .update({ department_id: id })
            .eq('account_id', ctx.accountId)
            .in('id', configIds);
          if (configUpdate.error) return NextResponse.json({ error: 'Não foi possível associar números' }, { status: 500 });
        }
      }
    }

    return NextResponse.json({ department: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from('departments')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .eq('is_default', false)
      .select('id')
      .maybeSingle();
    if (error) return NextResponse.json({ error: 'Departamento em uso não pode ser excluído' }, { status: 409 });
    if (!data) return NextResponse.json({ error: 'Departamento não encontrado ou é o padrão' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
