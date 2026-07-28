import type { SupabaseClient } from '@supabase/supabase-js';

export interface ActiveWhatsAppConfig {
  id: string;
  account_id: string;
  user_id: string;
  department_id?: string | null;
  is_default?: boolean;
  provider?: string | null;
  evolution_base_url: string | null;
  evolution_instance: string | null;
  evolution_api_key: string | null;
  phone_number_id?: string | null;
  disabled_at?: string | null;
  [key: string]: unknown;
}

export interface ResolveOptions {
  /** Config selected by the caller/request. Invalid ids fail closed. */
  explicitConfigId?: string | null;
  /** Transport stamp persisted on the conversation/delayed job. */
  conversationConfigId?: string | null;
  /** Backwards-compatible alias for conversationConfigId. */
  preferConfigId?: string | null;
  /** Department fallback when no config was stamped on the operation. */
  departmentId?: string | null;
}

export class AmbiguousWhatsAppConfigError extends Error {
  readonly code = 'ambiguous_config' as const;
  readonly status = 409 as const;

  constructor() {
    super('ambiguous_config');
    this.name = 'AmbiguousWhatsAppConfigError';
  }
}

/**
 * Pure deterministic resolver. Candidates must already be active and scoped to
 * one account. No timestamp or array-order tie-break is allowed: ambiguity is
 * an operational state that callers must surface instead of guessing a number.
 */
export function resolveWhatsAppConfigCandidates(
  candidates: readonly ActiveWhatsAppConfig[],
  options: ResolveOptions = {},
): ActiveWhatsAppConfig | null {
  const explicitId = options.explicitConfigId ?? null;
  if (explicitId) {
    return candidates.find((candidate) => candidate.id === explicitId) ?? null;
  }

  const conversationId =
    options.conversationConfigId ?? options.preferConfigId ?? null;
  if (conversationId) {
    return candidates.find((candidate) => candidate.id === conversationId) ?? null;
  }

  const eligible = options.departmentId
    ? candidates.filter((candidate) => candidate.department_id === options.departmentId)
    : candidates;

  const defaults = eligible.filter((candidate) => candidate.is_default === true);
  if (defaults.length === 1) return defaults[0];
  if (defaults.length > 1) throw new AmbiguousWhatsAppConfigError();

  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0];
  throw new AmbiguousWhatsAppConfigError();
}

/**
 * Load every active candidate in the account, then apply the pure resolver.
 * Deliberately contains no `.limit(1)`, `.single()` or timestamp fallback.
 */
export async function resolveActiveWhatsAppConfig(
  db: SupabaseClient,
  accountId: string,
  options: ResolveOptions = {},
): Promise<ActiveWhatsAppConfig | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .is('disabled_at', null)
    .order('id', { ascending: true });

  if (error) {
    throw new Error(
      `Failed to resolve active WhatsApp configuration: ${error.message}`,
    );
  }

  return resolveWhatsAppConfigCandidates(
    (data ?? []) as ActiveWhatsAppConfig[],
    options,
  );
}

export function whatsappTrace(config: ActiveWhatsAppConfig) {
  return {
    whatsapp_config_id: config.id,
    ...(config.department_id ? { department_id: config.department_id } : {}),
    whatsapp_provider: config.provider ?? 'evolution',
    whatsapp_instance: config.evolution_instance,
  };
}
