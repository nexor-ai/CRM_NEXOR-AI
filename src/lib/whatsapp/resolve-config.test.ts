import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveActiveWhatsAppConfig, whatsappTrace } from './resolve-config';

function makeDb(rows: Record<string, unknown>[]) {
  const calls: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      calls.push([`eq:${column}`, value]);
      return builder;
    },
    is: (column: string, value: unknown) => {
      calls.push([`is:${column}`, value]);
      return builder;
    },
    order: (column: string) => {
      calls.push(['order', column]);
      return builder;
    },
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return {
    db: { from: () => builder } as unknown as SupabaseClient,
    calls,
  };
}

describe('resolveActiveWhatsAppConfig', () => {
  it('excludes disabled rows and selects deterministically', async () => {
    const { db, calls } = makeDb([{ id: 'cfg-1', account_id: 'acc' }]);
    const config = await resolveActiveWhatsAppConfig(db, 'acc');
    expect(config?.id).toBe('cfg-1');
    expect(calls).toContainEqual(['eq:account_id', 'acc']);
    expect(calls).toContainEqual(['is:disabled_at', null]);
    expect(calls).toContainEqual(['order', 'updated_at']);
  });

  it('honours a conversation-pinned config id', async () => {
    const { db, calls } = makeDb([{ id: 'cfg-pinned', account_id: 'acc' }]);
    await resolveActiveWhatsAppConfig(db, 'acc', {
      preferConfigId: 'cfg-pinned',
    });
    expect(calls).toContainEqual(['eq:id', 'cfg-pinned']);
  });

  it('builds the persistence trace without credentials', () => {
    expect(
      whatsappTrace({
        id: 'cfg-1',
        account_id: 'acc',
        user_id: 'owner',
        evolution_base_url: 'http://localhost:8080',
        evolution_instance: 'nexor',
        evolution_api_key: 'encrypted',
      })
    ).toEqual({
      whatsapp_config_id: 'cfg-1',
      whatsapp_provider: 'evolution',
      whatsapp_instance: 'nexor',
    });
  });
});
