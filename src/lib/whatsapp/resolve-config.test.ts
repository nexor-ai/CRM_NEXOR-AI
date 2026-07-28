import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AmbiguousWhatsAppConfigError,
  resolveActiveWhatsAppConfig,
  resolveWhatsAppConfigCandidates,
  whatsappTrace,
  type ActiveWhatsAppConfig,
} from './resolve-config';

function config(id: string, overrides: Partial<ActiveWhatsAppConfig> = {}): ActiveWhatsAppConfig {
  return {
    id,
    account_id: 'acc',
    user_id: 'owner',
    evolution_base_url: 'http://localhost:8080',
    evolution_instance: id,
    evolution_api_key: 'encrypted',
    disabled_at: null,
    is_default: false,
    ...overrides,
  };
}

function makeDb(rows: ActiveWhatsAppConfig[]) {
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
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return {
    db: { from: () => builder } as unknown as SupabaseClient,
    calls,
  };
}

describe('resolveWhatsAppConfigCandidates', () => {
  it('prefere config explícita à conversa e ao default', () => {
    const selected = resolveWhatsAppConfigCandidates(
      [config('explicit'), config('conversation'), config('default', { is_default: true })],
      { explicitConfigId: 'explicit', conversationConfigId: 'conversation' },
    );
    expect(selected?.id).toBe('explicit');
  });

  it('usa o carimbo da conversa quando não há config explícita', () => {
    const selected = resolveWhatsAppConfigCandidates(
      [config('conversation'), config('default', { is_default: true })],
      { conversationConfigId: 'conversation' },
    );
    expect(selected?.id).toBe('conversation');
  });

  it('usa o único default ativo antes do fallback legado', () => {
    expect(
      resolveWhatsAppConfigCandidates([
        config('other'),
        config('default', { is_default: true }),
      ])?.id,
    ).toBe('default');
  });

  it('mantém compatibilidade quando existe uma única config ativa', () => {
    expect(resolveWhatsAppConfigCandidates([config('only')])?.id).toBe('only');
  });

  it('usa a única instância do departamento quando a conversa legada não tem carimbo', () => {
    const selected = resolveWhatsAppConfigCandidates(
      [
        config('sales', { department_id: 'sales-dept' }),
        config('support', { department_id: 'support-dept' }),
      ],
      { departmentId: 'support-dept' },
    );
    expect(selected?.id).toBe('support');
  });

  it('falha fechado quando o departamento ainda possui duas instâncias sem seleção', () => {
    expect(() =>
      resolveWhatsAppConfigCandidates(
        [
          config('support-a', { department_id: 'support-dept' }),
          config('support-b', { department_id: 'support-dept' }),
        ],
        { departmentId: 'support-dept' },
      ),
    ).toThrowError(AmbiguousWhatsAppConfigError);
  });

  it('falha fechado quando múltiplas configs ativas não têm contexto', () => {
    expect(() =>
      resolveWhatsAppConfigCandidates([config('a'), config('b')]),
    ).toThrowError(AmbiguousWhatsAppConfigError);
    expect(() =>
      resolveWhatsAppConfigCandidates([config('a'), config('b')]),
    ).toThrowError('ambiguous_config');
  });

  it('falha fechado quando há mais de um default durante drift de rollout', () => {
    expect(() =>
      resolveWhatsAppConfigCandidates([
        config('a', { is_default: true }),
        config('b', { is_default: true }),
      ]),
    ).toThrowError(AmbiguousWhatsAppConfigError);
  });
});

describe('resolveActiveWhatsAppConfig', () => {
  it('carrega todas as candidatas ativas sem limit(1) silencioso', async () => {
    const { db, calls } = makeDb([config('only')]);
    const selected = await resolveActiveWhatsAppConfig(db, 'acc');
    expect(selected?.id).toBe('only');
    expect(calls).toContainEqual(['eq:account_id', 'acc']);
    expect(calls).toContainEqual(['is:disabled_at', null]);
    expect(calls).toContainEqual(['order', 'id']);
  });

  it('builds the persistence trace without credentials', () => {
    expect(whatsappTrace(config('cfg-1', { department_id: 'dep-1' }))).toEqual({
      whatsapp_config_id: 'cfg-1',
      department_id: 'dep-1',
      whatsapp_provider: 'evolution',
      whatsapp_instance: 'cfg-1',
    });
  });
});
