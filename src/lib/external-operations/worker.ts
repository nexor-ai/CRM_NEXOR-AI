import type { SupabaseClient } from '@supabase/supabase-js';

import { ExternalOperationExecutionError, type ExternalOperationRecord } from './index';
import { sendMessageToConversation, type SendMessageParams } from '@/lib/whatsapp/send-message';
import { sendReactionMessage } from '@/lib/whatsapp/evolution-api';
import { decrypt } from '@/lib/whatsapp/encryption';

function objectPayload(operation: ExternalOperationRecord): Record<string, unknown> {
  if (!operation.payload || typeof operation.payload !== 'object') {
    throw new ExternalOperationExecutionError('Malformed external operation payload', 'pre_effect');
  }
  return operation.payload;
}

export async function executeSupportedExternalOperation(
  admin: SupabaseClient,
  operation: ExternalOperationRecord,
) {
  const payload = objectPayload(operation);
  if (operation.operation_type === 'send_message') {
    if (typeof payload.conversationId !== 'string' || typeof payload.messageType !== 'string') {
      throw new ExternalOperationExecutionError('Malformed send operation payload', 'pre_effect');
    }
    const result = await sendMessageToConversation(admin, operation.account_id, payload as unknown as SendMessageParams);
    return {
      transportId: result.whatsappMessageId,
      result: { messageId: result.messageId, whatsappMessageId: result.whatsappMessageId },
    };
  }
  if (operation.operation_type === 'reaction') {
    const required = ['targetMessageId', 'to', 'emoji', 'actorId', 'messageId'] as const;
    if (required.some((key) => typeof payload[key] !== 'string') || !operation.whatsapp_config_id) {
      throw new ExternalOperationExecutionError('Malformed reaction operation payload', 'pre_effect');
    }
    const { data: config, error: configError } = await admin
      .from('whatsapp_config')
      .select('id, account_id, evolution_base_url, evolution_instance, evolution_api_key')
      .eq('id', operation.whatsapp_config_id)
      .eq('account_id', operation.account_id)
      .maybeSingle();
    if (configError || !config?.evolution_base_url || !config.evolution_instance || !config.evolution_api_key) {
      throw new ExternalOperationExecutionError('Reaction WhatsApp configuration not found', 'pre_effect');
    }
    await sendReactionMessage({
      baseUrl: config.evolution_base_url,
      instance: config.evolution_instance,
      apiKey: decrypt(config.evolution_api_key),
      to: payload.to as string,
      targetMessageId: payload.targetMessageId as string,
      emoji: payload.emoji as string,
      fromMe: payload.fromMe === true,
    });
    if (payload.emoji === '') {
      const { error } = await admin
        .from('message_reactions')
        .delete()
        .eq('message_id', payload.messageId as string)
        .eq('actor_type', 'agent')
        .eq('actor_id', payload.actorId as string);
      if (error) throw new Error(`Reaction mirror delete failed: ${error.message}`);
    } else {
      const { error } = await admin.from('message_reactions').upsert(
        {
          message_id: payload.messageId,
          conversation_id: operation.conversation_id,
          actor_type: 'agent',
          actor_id: payload.actorId,
          emoji: payload.emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );
      if (error) throw new Error(`Reaction mirror upsert failed: ${error.message}`);
    }
    return { result: { mirrored: true } };
  }
  throw new ExternalOperationExecutionError(
    `Unsupported external operation type: ${operation.operation_type}`,
    'pre_effect',
  );
}
