import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { assertManualChannelAction } from '@/lib/channels/manual-channel';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { supabase, accountId } = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const action = typeof body?.action === 'string' ? body.action : '';
    const { data: post, error: postError } = await supabase
      .from('channel_posts')
      .select('id,status,current_revision')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (postError) throw postError;
    if (!post) return NextResponse.json({ error: 'Publicação não encontrada' }, { status: 404 });

    try {
      assertManualChannelAction(post.status, action);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Ação inválida' },
        { status: 409 },
      );
    }

    if (action === 'revise') {
      if (typeof body.title !== 'string' || typeof body.body !== 'string') {
        return NextResponse.json({ error: 'Título e conteúdo são obrigatórios' }, { status: 400 });
      }
      const { data, error } = await supabase.rpc('create_channel_revision', {
        p_post_id: id,
        p_title: body.title.trim(),
        p_body: body.body,
        p_metadata: body.metadata ?? {},
      });
      if (error) throw error;
      return NextResponse.json({ revision: data });
    }

    const { data: revision, error: revisionError } = await supabase
      .from('channel_post_revisions')
      .select('id')
      .eq('post_id', id)
      .eq('revision', post.current_revision)
      .maybeSingle();
    if (revisionError) throw revisionError;
    if (!revision) return NextResponse.json({ error: 'Revisão atual não encontrada' }, { status: 409 });

    if (action === 'approve' || action === 'reject') {
      const { data, error } = await supabase.rpc('decide_channel_revision', {
        p_post_id: id,
        p_revision_id: revision.id,
        p_decision: action === 'approve' ? 'approved' : 'rejected',
        p_note: typeof body.note === 'string' ? body.note : null,
      });
      if (error) throw error;
      return NextResponse.json({ approval: data });
    }

    if (action === 'export') {
      const { data, error } = await supabase.rpc('export_manual_channel_package', {
        p_post_id: id,
        p_revision_id: revision.id,
      });
      if (error) throw error;
      return NextResponse.json({ package: data });
    }

    if (typeof body.confirmation !== 'string' || body.confirmation.trim().length < 5) {
      return NextResponse.json({ error: 'Confirmação humana é obrigatória' }, { status: 400 });
    }
    if (typeof body.package_id !== 'string' || !body.package_id) {
      return NextResponse.json({ error: 'Pacote manual é obrigatório' }, { status: 400 });
    }
    const { data, error } = await supabase.rpc('confirm_manual_channel_publish', {
      p_post_id: id,
      p_package_id: body.package_id,
      p_confirmation: body.confirmation.trim(),
      p_external_reference: typeof body.external_reference === 'string' ? body.external_reference : null,
      p_evidence: body.evidence ?? {},
    });
    if (error) throw error;
    return NextResponse.json({ evidence: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
