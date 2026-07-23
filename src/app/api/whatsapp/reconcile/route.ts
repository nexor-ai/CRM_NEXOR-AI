import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { reconcileEvolutionMessages } from '@/app/api/whatsapp/webhook/route';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as {
      remoteJid?: unknown;
      limit?: unknown;
    };
    const remoteJid =
      typeof body.remoteJid === 'string' && body.remoteJid.endsWith('@s.whatsapp.net')
        ? body.remoteJid
        : undefined;
    if (body.remoteJid !== undefined && !remoteJid) {
      return NextResponse.json(
        { error: 'remoteJid must be a phone JID ending in @s.whatsapp.net' },
        { status: 400 }
      );
    }
    const requestedLimit = typeof body.limit === 'number' ? body.limit : 50;
    const limit = Math.max(1, Math.min(Math.floor(requestedLimit), 200));
    const config = await resolveActiveWhatsAppConfig(supabase, accountId);
    if (!config?.evolution_base_url || !config.evolution_instance || !config.evolution_api_key) {
      return NextResponse.json({ error: 'A API Evolution não está configurada' }, { status: 400 });
    }

    const result = await reconcileEvolutionMessages({
      baseUrl: config.evolution_base_url,
      instance: config.evolution_instance,
      configId: config.id,
      apiKey: decrypt(config.evolution_api_key),
      remoteJid,
      limit,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    const message = error instanceof Error ? error.message : 'Unknown reconciliation error';
    console.error('[whatsapp/reconcile] failed:', message);
    return NextResponse.json(
      { error: 'Não foi possível reconciliar as mensagens da Evolution' },
      { status: 502 }
    );
  }
}