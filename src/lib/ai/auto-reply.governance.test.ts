import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from './types';

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  notifyOperationalEvent: vi.fn(),
  state: {
    route: [{ agent_id: 'agent-1', binding_id: 'binding-1', route_source: 'config_department', mode: 'auto_reply' }],
    routeError: null as { message: string; code?: string } | null,
    agent: {
      id: 'agent-1', account_id: 'acct-1', mode: 'auto_reply', is_active: true,
      system_prompt: 'Prompt especializado', provider: 'openai', model: 'gpt-specialized',
    } as Record<string, unknown> | null,
    agentState: { sticky_agent_id: null, handoff_status: 'none' } as Record<string, unknown> | null,
    budgetRunId: 'run-1' as string | null,
    budgetError: null as { message: string; code?: string } | null,
    conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 },
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    runUpdates: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    conversationUpdate: null as Record<string, unknown> | null,
    callOrder: [] as string[],
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({
  generateReply: (...args: unknown[]) => {
    h.state.callOrder.push('provider');
    return h.generateReply(...args);
  },
}));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((value) => value) }));
vi.mock('@/lib/whatsapp/evolution-api', () => ({ sendChatPresence: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/notifications/producer', () => ({ notifyOperationalEvent: h.notifyOperationalEvent }));

function resolved(data: unknown, error: unknown = null) {
  return Promise.resolve({ data, error });
}

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  const fluent = () => query;
  Object.assign(query, {
    select: fluent,
    eq: fluent,
    is: fluent,
    not: fluent,
    in: fluent,
    order: fluent,
    limit: () => {
      if (table === 'automations' || table === 'whatsapp_config') return resolved([]);
      return query;
    },
    maybeSingle: () => {
      if (table === 'conversations') return resolved(h.state.conv);
      if (table === 'conversation_agent_state') return resolved(h.state.agentState);
      if (table === 'ai_agents') return resolved(h.state.agent);
      if (table === 'contacts') return resolved(null);
      return resolved(null);
    },
    update: (payload: Record<string, unknown>) => {
      if (table === 'ai_agent_runs') h.state.runUpdates.push(payload);
      if (table === 'conversations') h.state.conversationUpdate = payload;
      return query;
    },
    insert: (payload: Record<string, unknown>) => {
      if (table === 'ai_agent_events') h.state.events.push(payload);
      return resolved(null);
    },
    then: (resolve: (value: unknown) => void) => resolved(null).then(resolve),
  });
  return query;
}

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => queryFor(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args });
      if (name === 'resolve_ai_agent_binding') return resolved(h.state.route, h.state.routeError);
      if (name === 'claim_ai_agent_budget') {
        h.state.callOrder.push('budget');
        return resolved(h.state.budgetRunId, h.state.budgetError);
      }
      if (name === 'claim_ai_reply_slot' || name === 'set_ai_agent_handoff') return resolved(true);
      return resolved(null, { message: 'unknown rpc' });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1',
  configOwnerUserId: 'user-1', whatsappConfigId: 'wa-1', departmentId: 'dept-1',
};

function aiConfig(): AiConfig {
  return {
    provider: 'openai', model: 'gpt-legacy', apiKey: 'fixture-provider-key', systemPrompt: 'Prompt legado',
    isActive: true, autoReplyEnabled: true, autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.route = [{ agent_id: 'agent-1', binding_id: 'binding-1', route_source: 'config_department', mode: 'auto_reply' }];
  h.state.routeError = null;
  h.state.agent = {
    id: 'agent-1', account_id: 'acct-1', mode: 'auto_reply', is_active: true,
    system_prompt: 'Prompt especializado', provider: 'openai', model: 'gpt-specialized',
  };
  h.state.agentState = { sticky_agent_id: null, handoff_status: 'none' };
  h.state.budgetRunId = 'run-1';
  h.state.budgetError = null;
  h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 };
  h.state.rpcCalls = [];
  h.state.runUpdates = [];
  h.state.events = [];
  h.state.conversationUpdate = null;
  h.state.callOrder = [];
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'Olá' }]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Resposta', handoff: false });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
  h.notifyOperationalEvent.mockResolvedValue(undefined);
});

describe('dispatchInboundToAiReply — specialized governance', () => {
  it('fails closed when schema 048 is unavailable or routing is ambiguous', async () => {
    h.state.routeError = { code: 'PGRST202', message: 'resolve_ai_agent_binding not found' };
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();

    h.state.routeError = { code: 'P0001', message: 'ambiguous_agent_binding' };
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('reserves budget before provider and records a draft without sending in non-auto mode', async () => {
    h.state.route[0].mode = 'draft_only';
    if (h.state.agent) h.state.agent.mode = 'draft_only';
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.callOrder).toEqual(['budget', 'provider']);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.runUpdates).toContainEqual(expect.objectContaining({ status: 'awaiting_approval' }));
    expect(h.state.events).toContainEqual(expect.objectContaining({ event_type: 'draft_generated' }));
  });

  it('does not call the provider or send when the governed budget claim is denied', async () => {
    h.state.budgetRunId = null;
    h.state.budgetError = { message: 'monthly_budget_exceeded' };
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('fails closed when the resolved agent cannot be loaded in the inbound tenant', async () => {
    h.state.agent = null;
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls.some((call) => call.name === 'claim_ai_agent_budget')).toBe(false);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('records handoff and never sends the generated text', async () => {
    h.generateReply.mockResolvedValue({ text: 'partial', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toContainEqual(expect.objectContaining({ name: 'set_ai_agent_handoff' }));
    expect(h.state.runUpdates).toContainEqual(expect.objectContaining({ status: 'handoff' }));
    expect(h.state.conversationUpdate).toEqual({ ai_autoreply_disabled: true, status: 'pending' });
  });

  it('uses the agent prompt/model and sends only in auto_reply mode', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toContainEqual({
      name: 'resolve_ai_agent_binding',
      args: { p_account_id: 'acct-1', p_whatsapp_config_id: 'wa-1', p_department_id: 'dept-1', p_sticky_agent_id: null },
    });
    expect(h.state.callOrder).toEqual(['budget', 'provider']);
    expect(h.generateReply).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ provider: 'openai', model: 'gpt-specialized' }),
      systemPrompt: expect.stringContaining('Prompt especializado'),
    }));
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.runUpdates).toContainEqual(expect.objectContaining({ status: 'sent', provider: 'openai', model: 'gpt-specialized' }));
  });
});
