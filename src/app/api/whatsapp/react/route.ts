import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { submitExternalOperation } from '@/lib/external-operations';
import {
  createExternalOperationStore,
  operationHttpStatus,
} from '@/lib/external-operations/supabase-store';
import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { sendReactionMessage } from '@/lib/whatsapp/evolution-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction through Evolution and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji, idempotency_key } = body as {
      message_id?: string;
      emoji?: string;
      idempotency_key?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id, sender_type')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Mensagem não encontrada' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No WhatsApp transport ID yet — usually a sending/failed agent message. We can't
      // tell Evolution to react to a message it never received.
      return NextResponse.json(
        { error: 'Não é possível reagir a uma mensagem que não foi enviada ao WhatsApp' },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, whatsapp_config_id, contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversa não encontrada' },
        { status: 404 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Número de telefone do contato não encontrado' },
        { status: 400 },
      );
    }

    // Use the same Evolution instance that received this conversation.
    // Legacy conversations without a stamp fall back deterministically to
    // the account's active configuration.
    let config;
    try {
      config = await resolveActiveWhatsAppConfig(supabase, accountId, {
        preferConfigId: conversation.whatsapp_config_id ?? null,
      });
    } catch (error) {
      console.error('[whatsapp/react] config resolution failed:', error);
      config = null;
    }

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp não configurado.' },
        { status: 400 },
      );
    }

    // Defense in depth: resolution is account-scoped, but a malformed/custom
    // resolver result must never route an effect through another tenant.
    if (config.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Configuração do WhatsApp não encontrada' },
        { status: 404 },
      );
    }

    if (!config.evolution_base_url || !config.evolution_instance || !config.evolution_api_key) {
      return NextResponse.json({ error: 'A API Evolution não está configurada.' }, { status: 400 });
    }
    const apiKey = decrypt(config.evolution_api_key);
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
    const requestId =
      (typeof idempotency_key === 'string' && idempotency_key.trim()) ||
      request.headers.get('idempotency-key')?.trim() ||
      randomUUID();

    const operation = await submitExternalOperation(
      createExternalOperationStore(),
      {
        accountId,
        whatsappConfigId: config.id,
        conversationId: targetMessage.conversation_id,
        messageId: targetMessage.id,
        operationType: 'reaction',
        idempotencyKey: requestId,
        payload: {
          messageId: targetMessage.id,
          targetMessageId: targetMessage.message_id,
          to: sanitizedPhone,
          emoji,
          fromMe: targetMessage.sender_type !== 'customer',
          actorId: userId,
        },
        retryPolicy: 'at_most_once',
        maxAttempts: 1,
        requestedBy: userId,
      },
      async () => {
        await sendReactionMessage({
          baseUrl: config.evolution_base_url!,
          instance: config.evolution_instance!,
          apiKey,
          to: sanitizedPhone,
          targetMessageId: targetMessage.message_id,
          emoji,
          fromMe: targetMessage.sender_type !== 'customer',
        });

        if (emoji === '') {
          const { error: delError } = await supabase
            .from('message_reactions')
            .delete()
            .eq('message_id', targetMessage.id)
            .eq('actor_type', 'agent')
            .eq('actor_id', userId);
          if (delError) throw new Error(`Reaction mirror delete failed: ${delError.message}`);
        } else {
          const { error: upsertError } = await supabase.from('message_reactions').upsert(
            {
              message_id: targetMessage.id,
              conversation_id: targetMessage.conversation_id,
              actor_type: 'agent',
              actor_id: userId,
              emoji,
            },
            { onConflict: 'message_id,actor_type,actor_id' },
          );
          if (upsertError) throw new Error(`Reaction mirror upsert failed: ${upsertError.message}`);
        }
        return { result: { mirrored: true } };
      },
    );

    if (operation.status !== 'succeeded') {
      return NextResponse.json(
        { success: false, operation_id: operation.id, operation_status: operation.status },
        { status: operationHttpStatus(operation.status) },
      );
    }
    return NextResponse.json({ success: true, operation_id: operation.id });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Não foi possível reagir à mensagem' },
      { status: 500 },
    );
  }
}
