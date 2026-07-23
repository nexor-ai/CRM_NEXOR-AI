import type { SupabaseClient } from '@supabase/supabase-js';

interface OperationalNotificationInput {
  accountId: string;
  userId: string;
  eventKey: string;
  category:
    | 'inbox'
    | 'pipeline'
    | 'broadcast'
    | 'automation'
    | 'flow'
    | 'ai'
    | 'integration'
    | 'system';
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  body?: string;
  targetUrl?: string;
  entityType?: string;
  entityId?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

/** Best-effort notification producer. Business operations must not roll back
 * if the notification layer is temporarily unavailable. */
export async function notifyOperationalEvent(
  db: SupabaseClient,
  input: OperationalNotificationInput
): Promise<void> {
  const { error } = await db.rpc('create_contextual_notification', {
    p_account_id: input.accountId,
    p_user_id: input.userId,
    p_event_key: input.eventKey,
    p_category: input.category,
    p_severity: input.severity,
    p_title: input.title,
    p_body: input.body ?? null,
    p_target_url: input.targetUrl ?? null,
    p_entity_type: input.entityType ?? null,
    p_entity_id: input.entityId ?? null,
    p_dedupe_key: input.dedupeKey ?? null,
    p_metadata: input.metadata ?? {},
  });
  if (error) console.error('[notifications] producer failed:', error.message);
}
