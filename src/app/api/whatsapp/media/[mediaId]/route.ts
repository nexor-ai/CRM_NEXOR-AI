import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import {
  decodeChatMediaPath,
  isChatMediaPathForAccount,
} from '@/lib/whatsapp/chat-media';

export const CHAT_MEDIA_SIGNED_URL_TTL_SECONDS = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params;
    const { supabase, accountId } = await requireRole('viewer');
    const path = decodeChatMediaPath(mediaId);

    // Return the same not-found response for malformed and foreign-account
    // references so object paths do not become a tenant-enumeration oracle.
    if (!path || !isChatMediaPathForAccount(path, accountId)) {
      return NextResponse.json({ error: 'Mídia não encontrada' }, { status: 404 });
    }

    const { data, error } = await supabase.storage
      .from('chat-media')
      .createSignedUrl(path, CHAT_MEDIA_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: 'Mídia não encontrada' }, { status: 404 });
    }

    return NextResponse.redirect(data.signedUrl, 307);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    console.error('[whatsapp/media] failed:', error);
    return NextResponse.json({ error: 'Falha ao carregar mídia' }, { status: 500 });
  }
}
