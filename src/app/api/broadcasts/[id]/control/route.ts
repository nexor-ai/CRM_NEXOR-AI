import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    action?: 'pause' | 'resume' | 'cancel';
  } | null;
  if (!body?.action || !['pause', 'resume', 'cancel'].includes(body.action)) {
    return NextResponse.json({ error: 'Ação inválida' }, { status: 400 });
  }

  const { data: current } = await supabase
    .from('broadcasts')
    .select('id,status,scheduled_at')
    .eq('id', id)
    .maybeSingle();
  if (!current)
    return NextResponse.json({ error: 'Não encontrado' }, { status: 404 });

  const now = new Date().toISOString();
  const patch =
    body.action === 'pause'
      ? { status: 'paused', paused_at: now }
      : body.action === 'resume'
        ? { status: 'sending', paused_at: null, next_send_at: now }
        : { status: 'cancelled', completed_at: now, next_send_at: null };

  const { data, error } = await supabase
    .from('broadcasts')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });

  if (body.action === 'cancel') {
    await supabase
      .from('broadcast_recipients')
      .update({ status: 'cancelled' })
      .eq('broadcast_id', id)
      .eq('status', 'pending');
  }

  return NextResponse.json({ broadcast: data });
}
