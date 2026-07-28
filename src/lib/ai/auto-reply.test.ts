import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from './types';

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  sendChatPresence: vi.fn(),
  notifyOperationalEvent: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    stickyState: null as Record<string, unknown> | null,
    agent: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    route: [] as Record<string, unknown>[],
    legacyClaim: true,
    budgetRunId: 'run-1' as string | null,
    rpcErrors: {} as Record<string, { message: string }>,
    finalizeResults: [] as boolean[],
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    queryFilters: [] as { table: string; column: string; value: unknown }[],
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((value) => value) }));
vi.mock('@/lib/whatsapp/evolution-api', () => ({ sendChatPresence: h.sendChatPresence }));
vi.mock('@/lib/notifications/producer', () => ({ notifyOperationalEvent: h.notifyOperationalEvent }));

function scopedSingleChain(table: string, data: () => Record<string, unknown> | null) {
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      h.state.queryFilters.push({ table, column, value });
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: data(), error: null }),
  };
  return chain;
}

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        const chain = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            h.state.queryFilters.push({ table, column, value });
            return chain;
          },
          in: () => chain,
          limit: () => Promise.resolve({ data: h.state.autoResponders, error: null }),
        };
        return chain;
      }
      if (table === 'conversations') {
        return {
          ...scopedSingleChain(table, () => h.state.conv),
          update: (payload: Record<string, unknown>) => {
            h.state.updatePayload = payload;
            const updateChain = {
              eq: (column: string, value: unknown) => {
                h.state.queryFilters.push({ table, column, value });
                return updateChain;
              },
              then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
            };
            return updateChain;
          },
        };
      }
      if (table === 'conversation_agent_state') {
        return scopedSingleChain(table, () => h.state.stickyState);
      }
      if (table === 'ai_agents') {
        return scopedSingleChain(table, () => h.state.agent);
      }
      if (table === 'whatsapp_config') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          not: () => chain,
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return chain;
      }
      if (table === 'contacts') return scopedSingleChain(table, () => null);
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args });
      const error = h.state.rpcErrors[name] ?? null;
      if (name === 'resolve_ai_agent_binding') return Promise.resolve({ data: h.state.route, error });
      if (name === 'claim_ai_reply_slot') return Promise.resolve({ data: h.state.legacyClaim, error });
      if (name === 'claim_ai_agent_budget') return Promise.resolve({ data: h.state.budgetRunId, error });
      if (name === 'finish_ai_agent_run') {
        const data = h.state.finalizeResults.length ? h.state.finalizeResults.shift() : true;
        return Promise.resolve({ data, error });
      }
      if (name === 'set_ai_agent_handoff') return Promise.resolve({ data: true, error });
      throw new Error(`Unexpected RPC ${name}`);
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  whatsappConfigId: 'wa-config-1',
  departmentId: 'dept-1',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'secret',
    systemPrompt: 'Account prompt',
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    department_id: 'dept-1',
  };
  h.state.stickyState = { sticky_agent_id: 'agent-sticky' };
  h.state.agent = { system_prompt: 'Specialized prompt' };
  h.state.autoResponders = [];
  h.state.route = [{
    agent_id: 'agent-1',
    binding_id: 'binding-1',
    route_source: 'config_department',
    mode: 'auto_reply',
  }];
  h.state.legacyClaim = true;
  h.state.budgetRunId = 'run-1';
  h.state.rpcErrors = {};
  h.state.finalizeResults = [];
  h.state.updatePayload = null;
  h.state.rpcCalls = [];
  h.state.queryFilters = [];
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
  h.sendChatPresence.mockResolvedValue(undefined);
  h.notifyOperationalEvent.mockResolvedValue(undefined);
});

describe('dispatchInboundToAiReply — specialized agent routing', () => {
  it('resolves account-scoped state, reserves budget before generation, and records the real route', async () => {
    vi.stubEnv('AI_AGENT_ESTIMATED_COST_CENTS', '17');

    await dispatchInboundToAiReply(ARGS);

    expect(h.state.queryFilters).toEqual(expect.arrayContaining([
      { table: 'conversations', column: 'account_id', value: 'acct-1' },
      { table: 'conversation_agent_state', column: 'account_id', value: 'acct-1' },
      { table: 'ai_agents', column: 'account_id', value: 'acct-1' },
    ]));
    expect(h.state.rpcCalls.map((call) => call.name)).toEqual([
      'resolve_ai_agent_binding',
      'claim_ai_reply_slot',
      'claim_ai_agent_budget',
      'finish_ai_agent_run',
      'finish_ai_agent_run',
    ]);
    expect(h.state.rpcCalls[0].args).toEqual({
      p_account_id: 'acct-1',
      p_whatsapp_config_id: 'wa-config-1',
      p_department_id: 'dept-1',
      p_sticky_agent_id: 'agent-sticky',
    });
    expect(h.state.rpcCalls[2].args).toEqual({
      p_account_id: 'acct-1',
      p_conversation_id: 'conv-1',
      p_agent_id: 'agent-1',
      p_binding_id: 'binding-1',
      p_whatsapp_config_id: 'wa-config-1',
      p_department_id: 'dept-1',
      p_route_source: 'config_department',
      p_estimated_cost_cents: 17,
    });
    expect(h.generateReply).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Specialized prompt'),
    }));
    expect(h.generateReply.mock.calls[0][0].systemPrompt).not.toContain('Account prompt');
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
  });

  it.each(['draft_only', 'supervised', 'disabled'] as const)(
    'does not call the provider or send in %s mode',
    async (mode) => {
      h.state.route = [{ ...h.state.route[0], mode }];
      await dispatchInboundToAiReply(ARGS);
      expect(h.generateReply).not.toHaveBeenCalled();
      expect(h.engineSendText).not.toHaveBeenCalled();
      expect(h.state.rpcCalls.map((call) => call.name)).toEqual(['resolve_ai_agent_binding']);
    }
  );

  it.each([
    ['ambiguous/error', { message: 'ambiguous_agent_binding' }, h.state.route],
    ['empty resolution', null, []],
  ])('fails closed on %s', async (_label, error, route) => {
    h.state.rpcErrors = error ? { resolve_ai_agent_binding: error } : {};
    h.state.route = route as Record<string, unknown>[];
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('fails closed when the budget claim fails before generation', async () => {
    h.state.rpcErrors = { claim_ai_agent_budget: { message: 'monthly_budget_exceeded' } };
    h.state.budgetRunId = null;
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls.map((call) => call.name)).toEqual([
      'resolve_ai_agent_binding', 'claim_ai_reply_slot', 'claim_ai_agent_budget',
    ]);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

describe('dispatchInboundToAiReply — lifecycle and handoff', () => {
  it('finalizes generated then sent with fenced status transitions', async () => {
    await dispatchInboundToAiReply(ARGS);
    const finishes = h.state.rpcCalls.filter((call) => call.name === 'finish_ai_agent_run');
    expect(finishes.map((call) => call.args)).toEqual([
      expect.objectContaining({ p_account_id: 'acct-1', p_run_id: 'run-1', p_expected_status: 'claimed', p_status: 'generated' }),
      expect.objectContaining({ p_account_id: 'acct-1', p_run_id: 'run-1', p_expected_status: 'generated', p_status: 'sent' }),
    ]);
  });

  it('requests specialized-agent handoff and finalizes the run without sending', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);

    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true, status: 'pending' });
    expect(h.state.rpcCalls.map((call) => call.name)).toEqual([
      'resolve_ai_agent_binding',
      'claim_ai_reply_slot',
      'claim_ai_agent_budget',
      'finish_ai_agent_run',
      'set_ai_agent_handoff',
      'finish_ai_agent_run',
    ]);
    expect(h.state.rpcCalls.at(-1)?.args).toEqual(expect.objectContaining({
      p_expected_status: 'generated',
      p_status: 'handoff',
    }));
  });

  it('marks a claimed run failed when generation throws', async () => {
    h.generateReply.mockRejectedValue(new Error('provider unavailable'));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls.at(-1)).toEqual({
      name: 'finish_ai_agent_run',
      args: expect.objectContaining({
        p_expected_status: 'claimed',
        p_status: 'failed',
        p_error_message: 'Falha governada no runtime do agente',
      }),
    });
  });

  it('does not send if generated-state finalization loses its fence', async () => {
    h.state.finalizeResults = [false];
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

describe('dispatchInboundToAiReply — legacy eligibility gates', () => {
  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }];
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
  });

  it('does not generate when the legacy atomic slot claim loses the race', async () => {
    h.state.legacyClaim = false;
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it.each([
    ['human assignment', { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false, ai_reply_count: 0, department_id: 'dept-1' }],
    ['conversation handoff', { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 0, department_id: 'dept-1' }],
    ['conversation cap', { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3, department_id: 'dept-1' }],
  ])('skips for %s', async (_label, conv) => {
    h.state.conv = conv;
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when account AI is disabled or context is empty', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    h.loadAiConfig.mockResolvedValue(aiConfig());
    h.buildConversationContext.mockResolvedValue([]);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
  });
});
