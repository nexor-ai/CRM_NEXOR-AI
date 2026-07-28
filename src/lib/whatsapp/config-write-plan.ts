import { AmbiguousWhatsAppConfigError } from './resolve-config';

export interface ConfigWriteCandidate {
  id: string;
  account_id: string;
  is_default?: boolean;
}

export type ConfigWritePlan =
  | { kind: 'create' }
  | { kind: 'update'; config: ConfigWriteCandidate };

export class WhatsAppConfigNotFoundError extends Error {
  readonly code = 'config_not_found' as const;
  readonly status = 404 as const;

  constructor() {
    super('config_not_found');
    this.name = 'WhatsAppConfigNotFoundError';
  }
}

/**
 * Decide whether a settings POST creates or updates without relying on row
 * order. The one-row branch is retained solely for the legacy settings form.
 */
export function planWhatsAppConfigWrite(
  candidates: readonly ConfigWriteCandidate[],
  input: { configId?: string | null; createNew?: boolean },
): ConfigWritePlan {
  if (input.createNew) return { kind: 'create' };
  if (input.configId) {
    const config = candidates.find((candidate) => candidate.id === input.configId);
    if (!config) throw new WhatsAppConfigNotFoundError();
    return { kind: 'update', config };
  }
  if (candidates.length === 0) return { kind: 'create' };
  if (candidates.length === 1) return { kind: 'update', config: candidates[0] };
  throw new AmbiguousWhatsAppConfigError();
}
