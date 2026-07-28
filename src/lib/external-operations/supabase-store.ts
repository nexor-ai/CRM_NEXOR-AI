import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import type {
  EnqueueExternalOperationInput,
  ExternalOperationRecord,
  ExternalOperationStatus,
  ExternalOperationStore,
} from './index';

function one(data: unknown): ExternalOperationRecord | null {
  if (Array.isArray(data)) return (data[0] as ExternalOperationRecord | undefined) ?? null;
  return (data as ExternalOperationRecord | null) ?? null;
}

export function createExternalOperationStore(
  admin: SupabaseClient = supabaseAdmin(),
): ExternalOperationStore {
  return {
    async enqueue(input: EnqueueExternalOperationInput) {
      const { data, error } = await admin.rpc('enqueue_external_operation', {
        account_id_arg: input.accountId,
        whatsapp_config_id_arg: input.whatsappConfigId ?? null,
        conversation_id_arg: input.conversationId ?? null,
        message_id_arg: input.messageId ?? null,
        operation_type_arg: input.operationType,
        idempotency_key_arg: input.idempotencyKey,
        payload_arg: input.payload,
        retry_policy_arg: input.retryPolicy ?? 'at_most_once',
        max_attempts_arg: input.maxAttempts ?? 1,
        requested_by_arg: input.requestedBy ?? null,
      });
      const operation = one(data);
      if (error || !operation) throw new Error(`Could not persist external operation: ${error?.message ?? 'zero rows'}`);
      return operation;
    },
    async claim(id: string) {
      const { data, error } = await admin.rpc('claim_external_operations', {
        worker_limit: 1,
        operation_id_arg: id,
      });
      if (error) throw new Error(`Could not claim external operation: ${error.message}`);
      return one(data);
    },
    async finalize(id, fencingToken, status, result, operationError, transportId) {
      const { data, error } = await admin.rpc('finalize_external_operation', {
        operation_id_arg: id,
        fencing_token_arg: fencingToken,
        status_arg: status,
        result_arg: result,
        error_arg: operationError,
        transport_id_arg: transportId,
      });
      const operation = one(data);
      if (error || !operation) throw new Error(`Could not finalize external operation: ${error?.message ?? 'zero rows'}`);
      return operation;
    },
  };
}

export function operationHttpStatus(status: ExternalOperationStatus): number {
  if (status === 'succeeded') return 200;
  if (status === 'failed' || status === 'cancelled') return 422;
  return 202;
}
