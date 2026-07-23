import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
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
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const limit = checkRateLimit(`react:${user.id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // Resolve the caller's account_id so conversation + whatsapp_config
    // lookups work for teammates who didn't author the rows directly.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
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

    if (!config.evolution_base_url || !config.evolution_instance || !config.evolution_api_key) {
      return NextResponse.json({ error: 'A API Evolution não está configurada.' }, { status: 400 });
    }
    const apiKey = decrypt(config.evolution_api_key);
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone);

    try {
      await sendReactionMessage({
        baseUrl: config.evolution_base_url,
        instance: config.evolution_instance,
        apiKey,
        to: sanitizedPhone,
        targetMessageId: targetMessage.message_id,
        emoji,
        fromMe: targetMessage.sender_type !== 'customer',
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Evolution API error';
      console.error('[whatsapp/react] Evolution send failed:', message);
      return NextResponse.json(
        { error: `Erro da API Evolution: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      const { error: delError } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', targetMessage.id)
        .eq('actor_type', 'agent')
        .eq('actor_id', user.id);

      if (delError) {
        console.error('[whatsapp/react] DB delete failed:', delError.message);
        return NextResponse.json(
          { error: 'Reação enviada à Evolution, mas a exclusão no banco falhou' },
          { status: 500 },
        );
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      const { error: upsertError } = await supabase.from('message_reactions').upsert(
        {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: user.id,
          emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );

      if (upsertError) {
        console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
        return NextResponse.json(
          { error: 'Reação enviada à Evolution, mas a gravação no banco falhou' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Não foi possível reagir à mensagem' },
      { status: 500 },
    );
  }
}
