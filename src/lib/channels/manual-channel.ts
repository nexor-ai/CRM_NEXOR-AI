import { createHash } from 'node:crypto';

export interface ManualChannelTarget { provider: string; target: string; autoPublish: boolean }

export type ManualChannelStatus = 'draft' | 'in_review' | 'approved' | 'exported' | 'confirmed' | 'cancelled';
export type ManualChannelAction = 'revise' | 'approve' | 'reject' | 'export' | 'confirm';

const MANUAL_ACTION_STATES: Record<ManualChannelAction, readonly ManualChannelStatus[]> = {
  revise: ['draft', 'in_review', 'approved'],
  approve: ['in_review'],
  reject: ['in_review'],
  export: ['approved'],
  confirm: ['exported'],
};

export function assertManualChannelAction(status: string, action: string): asserts action is ManualChannelAction {
  if (!(action in MANUAL_ACTION_STATES)) throw new Error('channel_action_forbidden');
  if (!MANUAL_ACTION_STATES[action as ManualChannelAction].includes(status as ManualChannelStatus)) {
    throw new Error('channel_transition_forbidden');
  }
}

export function assertManualChannelTarget(input: ManualChannelTarget): void {
  if (input.provider !== 'manual') throw new Error('manual_provider_only');
  if (input.autoPublish) throw new Error('auto_publish_forbidden');
  if (input.target.toLowerCase().includes('@newsletter')) throw new Error('newsletter_target_forbidden');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function createRevisionHash(payload: Record<string, unknown>): Promise<string> {
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

export async function verifyRevisionHash(payload: Record<string, unknown>, expected: string): Promise<boolean> {
  return (await createRevisionHash(payload)) === expected;
}
