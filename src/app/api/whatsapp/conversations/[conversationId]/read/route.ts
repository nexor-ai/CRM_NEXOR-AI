import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { markMessagesAsRead } from '@/lib/whatsapp/evolution-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { uniqueReadReceipts } from '@/lib/whatsapp/read-receipts';
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const { conversationId } = await params;
    const { supabase, accountId } = await requireRole('agent');

    const { data: conversation, error: conversationError } = await supabase
      .from('conversations')
      .select('id, unread_count, whatsapp_config_id, contact:contacts(phone)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (conversationError || !conversation) {
      return NextResponse.json(
        { error: 'Conversa não encontrada' },
        { status: 404 }
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;

    const readCount = Math.max(0, Number(conversation.unread_count || 0));
    const { error: updateError } = await supabase.rpc('mark_conversation_read_through', {
      conversation_id_arg: conversationId,
      account_id_arg: accountId,
      read_count_arg: readCount,
    });

    if (updateError) {
      return NextResponse.json(
        { error: 'Falha ao atualizar o estado do CRM' },
        { status: 500 }
      );
    }

    let marked = 0;
    let transportReadError: string | null = null;
    try {
      if (!contact?.phone) throw new Error('Contact phone number not found');
      const config = await resolveActiveWhatsAppConfig(supabase, accountId, {
        preferConfigId: conversation.whatsapp_config_id ?? null,
      });
      if (!config?.evolution_base_url || !config.evolution_instance || !config.evolution_api_key) {
        throw new Error('Evolution API is not configured');
      }
      const { data: messages, error: messagesError } = await supabase
        .from('messages')
        .select('message_id, whatsapp_instance')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .not('message_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);
      if (messagesError) {
        throw new Error(`Could not load transport messages: ${messagesError.message}`);
      }
      const number = sanitizePhoneForMeta(contact.phone);
      const remoteJid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
      const readMessages = uniqueReadReceipts(
        messages ?? [],
        config.evolution_instance,
        remoteJid
      );
      marked = readMessages.length;
      await markMessagesAsRead({
        baseUrl: config.evolution_base_url,
        instance: config.evolution_instance,
        apiKey: decrypt(config.evolution_api_key),
        messages: readMessages,
      });
    } catch (error) {
      transportReadError =
        error instanceof Error ? error.message : 'Unknown Evolution API error';
      console.error('[whatsapp/read] remote receipt failed:', transportReadError);
    }

    return NextResponse.json({
      success: true,
      marked,
      transport_synced: transportReadError === null,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    const message =
      error instanceof Error ? error.message : 'Unknown Evolution API error';
    console.error('[whatsapp/read] failed:', message);
    return NextResponse.json(
      { error: `Não foi possível marcar a conversa como lida: ${message}` },
      { status: 502 }
    );
  }
}
