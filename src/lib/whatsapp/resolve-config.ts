import type { SupabaseClient } from '@supabase/supabase-js';

export interface ActiveWhatsAppConfig {
  id: string;
  account_id: string;
  user_id: string;
  evolution_base_url: string | null;
  evolution_instance: string | null;
  evolution_api_key: string | null;
  phone_number_id?: string | null;
  disabled_at?: string | null;
  [key: string]: unknown;
}

interface ResolveOptions {
  preferConfigId?: string | null;
}

/**
 * Resolve the account's active WhatsApp configuration deterministically.
 *
 * `disabled_at` is always excluded. A conversation-pinned config wins when
 * supplied; otherwise the most recently updated active row is selected. The
 * database migration also enforces one active row per account, while the
 * ordered limit keeps reads graceful during rollout or legacy cleanup.
 */
export async function resolveActiveWhatsAppConfig(
  db: SupabaseClient,
  accountId: string,
  options: ResolveOptions = {}
): Promise<ActiveWhatsAppConfig | null> {
  let query = db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .is('disabled_at', null);

  if (options.preferConfigId) {
    query = query.eq('id', options.preferConfigId);
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(
      `Failed to resolve active WhatsApp configuration: ${error.message}`
    );
  }

  return (data?.[0] as ActiveWhatsAppConfig | undefined) ?? null;
}

export function whatsappTrace(config: ActiveWhatsAppConfig) {
  return {
    whatsapp_config_id: config.id,
    whatsapp_provider: 'evolution',
    whatsapp_instance: config.evolution_instance,
  };
}
