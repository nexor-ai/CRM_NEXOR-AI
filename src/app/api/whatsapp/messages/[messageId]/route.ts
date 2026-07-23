import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { buildRemoteJid } from '@/lib/whatsapp/chat-actions';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  deleteMessageForEveryone,
  editMessage,
} from '@/lib/whatsapp/evolution-api';
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';

type MessageRow = {
  id: string;
  message_id: string | null;
  sender_type: string;
  content_type: string;
  content_text: string | null;
  original_content_text: string | null;
  deleted_at: string | null;
  conversation:
    | {
        id: string;
        whatsapp_config_id: string | null;
        contact: { phone: string } | Array<{ phone: string }> | null;
      }
    | Array<{
        id: string;
        whatsapp_config_id: string | null;
        contact: { phone: string } | Array<{ phone: string }> | null;
      }>;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function loadScopedMessage(
  messageId: string,
  accountId: string,
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase']
): Promise<MessageRow | null> {
  const { data, error } = await supabase
    .from('messages')
    .select(
      'id, message_id, sender_type, content_type, content_text, original_content_text, deleted_at, conversation:conversations!inner(id, account_id, whatsapp_config_id, contact:contacts(phone))'
    )
    .eq('id', messageId)
    .eq('conversations.account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as MessageRow;
}

async function transportContext(
  row: MessageRow,
  accountId: string,
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase']
) {
  const conversation = one(row.conversation);
  const contact = one(conversation?.contact ?? null);
  if (!conversation || !contact?.phone || !row.message_id) return null;
  const config = await resolveActiveWhatsAppConfig(supabase, accountId, {
    preferConfigId: conversation.whatsapp_config_id,
  });
  if (
    !config?.evolution_base_url ||
    !config.evolution_instance ||
    !config.evolution_api_key
  )
    return null;
  const remoteJid = buildRemoteJid(contact.phone);
  return {
    conversation,
    credentials: {
      baseUrl: config.evolution_base_url,
      instance: config.evolution_instance,
      apiKey: decrypt(config.evolution_api_key),
    },
    phone: contact.phone,
    key: { id: row.message_id, remoteJid, fromMe: true },
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await params;
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      text?: unknown;
    } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4096) {
      return NextResponse.json(
        { error: 'O texto deve conter de 1 a 4096 caracteres' },
        { status: 400 }
      );
    }
    const row = await loadScopedMessage(messageId, accountId, supabase);
    if (!row)
      return NextResponse.json({ error: 'Mensagem não encontrada' }, { status: 404 });
    if (
      row.sender_type === 'customer' ||
      row.content_type !== 'text' ||
      row.deleted_at
    ) {
      return NextResponse.json(
        { error: 'Somente mensagens de texto de saída ativas podem ser editadas' },
        { status: 409 }
      );
    }
    const transport = await transportContext(row, accountId, supabase);
    if (!transport)
      return NextResponse.json(
        { error: 'O contexto de transporte de mensagens está indisponível' },
        { status: 400 }
      );

    await editMessage({
      ...transport.credentials,
      to: transport.phone,
      key: transport.key,
      text,
    });
    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from('messages')
      .update({
        original_content_text: row.original_content_text ?? row.content_text,
        content_text: text,
        edited_at: now,
        edited_by_user_id: userId,
      })
      .eq('id', row.id)
      .select('*')
      .single();
    if (error) throw new Error(`Local edit audit failed: ${error.message}`);
    return NextResponse.json({ success: true, message: updated });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return toErrorResponse(error);
    console.error('[whatsapp/message-edit] failed:', error);
    return NextResponse.json({ error: 'Falha ao editar a mensagem' }, { status: 502 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await params;
    const { supabase, accountId, userId } = await requireRole('agent');
    const row = await loadScopedMessage(messageId, accountId, supabase);
    if (!row)
      return NextResponse.json({ error: 'Mensagem não encontrada' }, { status: 404 });
    if (row.sender_type === 'customer' || row.deleted_at) {
      return NextResponse.json(
        { error: 'Somente mensagens de saída ativas podem ser excluídas' },
        { status: 409 }
      );
    }
    const transport = await transportContext(row, accountId, supabase);
    if (!transport)
      return NextResponse.json(
        { error: 'O contexto de transporte de mensagens está indisponível' },
        { status: 400 }
      );

    await deleteMessageForEveryone({
      ...transport.credentials,
      key: transport.key,
    });
    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from('messages')
      .update({
        original_content_text: row.original_content_text ?? row.content_text,
        content_text: null,
        media_url: null,
        deleted_at: now,
        deleted_by_user_id: userId,
      })
      .eq('id', row.id)
      .select('*')
      .single();
    if (error) throw new Error(`Local delete audit failed: ${error.message}`);
    return NextResponse.json({ success: true, message: updated });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return toErrorResponse(error);
    console.error('[whatsapp/message-delete] failed:', error);
    return NextResponse.json(
      { error: 'Falha ao excluir a mensagem' },
      { status: 502 }
    );
  }
}
