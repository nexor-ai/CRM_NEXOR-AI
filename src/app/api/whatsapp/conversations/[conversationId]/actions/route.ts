import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import {
  buildContactProfilePatch,
  buildRemoteJid,
  parseWhatsAppNumberValidation,
} from '@/lib/whatsapp/chat-actions';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  archiveChat,
  fetchProfile,
  fetchProfilePicture,
  markChatUnread,
  validateWhatsAppNumbers,
  type EvolutionLastMessage,
} from '@/lib/whatsapp/evolution-api';
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';

type ConversationAction =
  | 'archive'
  | 'unarchive'
  | 'mark_unread'
  | 'refresh_profile'
  | 'validate_number';

const ACTIONS = new Set<ConversationAction>([
  'archive',
  'unarchive',
  'mark_unread',
  'refresh_profile',
  'validate_number',
]);

function relation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const { conversationId } = await params;
    const { supabase, accountId } = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
    } | null;
    const action = body?.action;
    if (
      typeof action !== 'string' ||
      !ACTIONS.has(action as ConversationAction)
    ) {
      return NextResponse.json(
        { error: 'Ação de conversa não suportada' },
        { status: 400 }
      );
    }

    const { data: conversation, error } = await supabase
      .from('conversations')
      .select(
        'id, contact_id, whatsapp_config_id, archived_at, unread_count, contact:contacts(id, phone, avatar_url, whatsapp_push_name, whatsapp_profile_status, whatsapp_profile_synced_at, whatsapp_number_exists, whatsapp_number_jid, whatsapp_number_validated_at)'
      )
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !conversation) {
      return NextResponse.json(
        { error: 'Conversa não encontrada' },
        { status: 404 }
      );
    }
    const contact = relation(conversation.contact);
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Número de telefone do contato não encontrado' },
        { status: 400 }
      );
    }

    const config = await resolveActiveWhatsAppConfig(supabase, accountId, {
      preferConfigId: conversation.whatsapp_config_id ?? null,
    });
    if (
      !config?.evolution_base_url ||
      !config.evolution_instance ||
      !config.evolution_api_key
    ) {
      return NextResponse.json(
        { error: 'A API Evolution não está configurada' },
        { status: 400 }
      );
    }
    const credentials = {
      baseUrl: config.evolution_base_url,
      instance: config.evolution_instance,
      apiKey: decrypt(config.evolution_api_key),
    };
    const normalized = String(contact.phone).replace(/\D/g, '');
    const remoteJid = buildRemoteJid(normalized);

    const { data: latest } = await supabase
      .from('messages')
      .select('message_id, sender_type, created_at')
      .eq('conversation_id', conversationId)
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastMessage: EvolutionLastMessage | undefined = latest?.message_id
      ? {
          key: {
            id: latest.message_id,
            remoteJid,
            fromMe: latest.sender_type !== 'customer',
          },
          messageTimestamp: Math.floor(
            new Date(latest.created_at).getTime() / 1000
          ),
        }
      : undefined;

    if (action === 'archive' || action === 'unarchive') {
      const archive = action === 'archive';
      await archiveChat({ ...credentials, remoteJid, archive, lastMessage });
      const archivedAt = archive ? new Date().toISOString() : null;
      const { error: updateError } = await supabase
        .from('conversations')
        .update({ archived_at: archivedAt })
        .eq('id', conversationId)
        .eq('account_id', accountId);
      if (updateError)
        throw new Error(`CRM archive state failed: ${updateError.message}`);
      return NextResponse.json({ success: true, archived_at: archivedAt });
    }

    if (action === 'mark_unread') {
      if (!lastMessage) {
        return NextResponse.json(
          { error: 'A conversa não tem mensagem do WhatsApp para marcar como não lida' },
          { status: 409 }
        );
      }
      await markChatUnread({ ...credentials, remoteJid, lastMessage });
      const { error: updateError } = await supabase
        .from('conversations')
        .update({ unread_count: Math.max(1, conversation.unread_count ?? 0) })
        .eq('id', conversationId)
        .eq('account_id', accountId);
      if (updateError)
        throw new Error(`CRM unread state failed: ${updateError.message}`);
      return NextResponse.json({
        success: true,
        unread_count: Math.max(1, conversation.unread_count ?? 0),
      });
    }

    if (action === 'refresh_profile') {
      const [profile, picture] = await Promise.all([
        fetchProfile({ ...credentials, to: normalized }),
        fetchProfilePicture({ ...credentials, to: normalized }).catch(
          () => null
        ),
      ]);
      const patch = {
        ...buildContactProfilePatch(profile),
        ...buildContactProfilePatch(picture),
      };
      const { data: updated, error: updateError } = await supabase
        .from('contacts')
        .update(patch)
        .eq('id', contact.id)
        .eq('account_id', accountId)
        .select('*')
        .single();
      if (updateError)
        throw new Error(`Profile cache failed: ${updateError.message}`);
      return NextResponse.json({ success: true, contact: updated });
    }

    const validatedAt = contact.whatsapp_number_validated_at
      ? new Date(contact.whatsapp_number_validated_at).getTime()
      : 0;
    if (
      validatedAt > Date.now() - 24 * 60 * 60 * 1000 &&
      contact.whatsapp_number_exists !== null
    ) {
      return NextResponse.json({
        success: true,
        cached: true,
        validation: {
          exists: contact.whatsapp_number_exists === true,
          jid: contact.whatsapp_number_jid ?? null,
        },
      });
    }
    const validation = parseWhatsAppNumberValidation(
      await validateWhatsAppNumbers({ ...credentials, numbers: [normalized] }),
      normalized
    );
    const { error: updateError } = await supabase
      .from('contacts')
      .update({
        whatsapp_number_exists: validation.exists,
        whatsapp_number_jid: validation.jid,
        whatsapp_number_validated_at: new Date().toISOString(),
      })
      .eq('id', contact.id)
      .eq('account_id', accountId);
    if (updateError)
      throw new Error(`Number cache failed: ${updateError.message}`);
    return NextResponse.json({ success: true, validation });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    console.error('[whatsapp/conversation-action] failed:', error);
    return NextResponse.json(
      { error: 'Falha na ação da conversa' },
      { status: 502 }
    );
  }
}
