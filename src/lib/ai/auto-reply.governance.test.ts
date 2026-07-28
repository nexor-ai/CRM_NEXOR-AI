import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from './types';

// Contrato governado pela migration 048. Dois pontos dela definem o que este
// arquivo pode afirmar, e uma versão anterior destes testes violava os dois:
//
// 1. `REVOKE INSERT, UPDATE, DELETE ON conversation_agent_state, ai_agent_runs,
//    ai_agent_events` (048 L184). O runtime NUNCA escreve nessas tabelas direto;
//    quem faz o UPDATE do run e insere o evento é `finish_ai_agent_run`
//    (SECURITY DEFINER). Portanto asserção de progresso de run é sobre a RPC.
// 2. `claim_ai_agent_budget` só atende `mode = 'auto_reply'` (048 L304) e
//    `finish_ai_agent_run` só aceita generated/sent/handoff/failed. Não existe
//    caminho de rascunho: agente fora de auto_reply não reserva budget nem
//    chega ao provider. E `ai_agents` não tem coluna provider/model — o modelo
//    é sempre o da conta; o agente contribui com o system_prompt.
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
    agent: { system_prompt: 'Prompt especializado' } as Record<string, unknown> | null,
    agentState: { sticky_agent_id: null, handoff_status: 'none' } as Record<string, unknown> | null,
    budgetRunId: 'run-1' as string | null,
    budgetError: null as { message: string; code?: string } | null,
    // department_id é obrigatório: auto-reply.ts:81/84 aborta antes de qualquer
    // RPC se a conversa não estiver carimbada no mesmo departamento do webhook.
    // Sem ele os testes de fail-closed passavam vazios, provando nada.
    conv: {
      assigned_agent_id: null, ai_autoreply_disabled: false,
      ai_reply_count: 0, department_id: 'dept-1',
    } as Record<string, unknown>,
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
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
      // conversations é a única tabela deste fluxo que o runtime pode escrever
      // direto; ai_agent_runs/ai_agent_events estão sob REVOKE na 048.
      if (table === 'conversations') h.state.conversationUpdate = payload;
      if (table === 'ai_agent_runs' || table === 'ai_agent_events') {
        throw new Error(`escrita direta proibida pela 048: ${table}`);
      }
      return query;
    },
    insert: () => {
      if (table === 'ai_agent_runs' || table === 'ai_agent_events') {
        throw new Error(`escrita direta proibida pela 048: ${table}`);
      }
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
      if (
        name === 'claim_ai_reply_slot' ||
        name === 'set_ai_agent_handoff' ||
        name === 'finish_ai_agent_run'
      ) return resolved(true);
      return resolved(null, { message: 'unknown rpc' });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1',
  configOwnerUserId: 'user-1', whatsappConfigId: 'wa-1', departmentId: 'dept-1',
};

const rpcNames = () => h.state.rpcCalls.map((call) => call.name);
const finishes = () =>
  h.state.rpcCalls
    .filter((call) => call.name === 'finish_ai_agent_run')
    .map((call) => ({ from: call.args.p_expected_status, to: call.args.p_status }));

// Guarda contra teste vazio: prova que o dispatch passou das checagens de
// conversa/departamento e chegou de fato ao roteamento do 048. Sem isso, um
// bail-out precoce faz toda asserção "not.toHaveBeenCalled" passar de graça.
const expectReachedRouting = () =>
  expect(rpcNames(), 'dispatch abortou antes do roteamento 048').toContain('resolve_ai_agent_binding');

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
  h.state.agent = { system_prompt: 'Prompt especializado' };
  h.state.agentState = { sticky_agent_id: null, handoff_status: 'none' };
  h.state.budgetRunId = 'run-1';
  h.state.budgetError = null;
  h.state.conv = {
    assigned_agent_id: null, ai_autoreply_disabled: false,
    ai_reply_count: 0, department_id: 'dept-1',
  };
  h.state.rpcCalls = [];
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
    expectReachedRouting();
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();

    h.state.rpcCalls = [];
    h.state.routeError = { code: 'P0001', message: 'ambiguous_agent_binding' };
    await dispatchInboundToAiReply(ARGS);
    expectReachedRouting();
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('never reserves budget nor reaches the provider outside auto_reply mode', async () => {
    // 048 L304: claim_ai_agent_budget levanta agent_unavailable fora de
    // auto_reply. O runtime nem tenta — barra no roteamento.
    for (const mode of ['draft_only', 'supervised', 'disabled']) {
      h.state.rpcCalls = [];
      h.state.callOrder = [];
      h.state.route[0].mode = mode;
      await dispatchInboundToAiReply(ARGS);
      expectReachedRouting();
      expect(rpcNames(), `modo ${mode} reservou budget`).not.toContain('claim_ai_agent_budget');
      expect(h.state.callOrder, `modo ${mode} chegou ao provider`).toEqual([]);
      expect(h.engineSendText).not.toHaveBeenCalled();
    }
  });

  it('does not call the provider or send when the governed budget claim is denied', async () => {
    h.state.budgetRunId = null;
    h.state.budgetError = { message: 'monthly_budget_exceeded' };
    await dispatchInboundToAiReply(ARGS);
    expect(rpcNames()).toContain('claim_ai_agent_budget');
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('fails closed when the resolved agent cannot be loaded in the inbound tenant', async () => {
    h.state.agent = null;
    await dispatchInboundToAiReply(ARGS);
    expectReachedRouting();
    expect(rpcNames()).not.toContain('claim_ai_agent_budget');
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('fails closed when the inbound department does not match the conversation', async () => {
    h.state.conv.department_id = 'dept-outro';
    await dispatchInboundToAiReply(ARGS);
    expect(rpcNames()).toEqual([]);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('records handoff through the governed RPC and never sends the generated text', async () => {
    h.generateReply.mockResolvedValue({ text: 'partial', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toContainEqual(expect.objectContaining({
      name: 'set_ai_agent_handoff',
      args: expect.objectContaining({
        p_account_id: 'acct-1', p_conversation_id: 'conv-1',
        p_status: 'requested', p_reason: 'model_requested_handoff',
      }),
    }));
    expect(finishes()).toEqual([
      { from: 'claimed', to: 'generated' },
      { from: 'generated', to: 'handoff' },
    ]);
    expect(h.state.conversationUpdate).toEqual({ ai_autoreply_disabled: true, status: 'pending' });
  });

  it('treats an empty model reply as a handoff instead of sending', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: false });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toContainEqual(expect.objectContaining({
      name: 'set_ai_agent_handoff',
      args: expect.objectContaining({ p_reason: 'empty_model_reply' }),
    }));
  });

  it('uses the agent prompt over the account model and sends in auto_reply mode', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toContainEqual({
      name: 'resolve_ai_agent_binding',
      args: { p_account_id: 'acct-1', p_whatsapp_config_id: 'wa-1', p_department_id: 'dept-1', p_sticky_agent_id: null },
    });
    // O budget é reservado ANTES de qualquer chamada paga ao provider.
    expect(h.state.callOrder).toEqual(['budget', 'provider']);
    expect(h.generateReply).toHaveBeenCalledWith(expect.objectContaining({
      // ai_agents não tem provider/model: o modelo é o da conta, o agente entra
      // com o system_prompt.
      config: expect.objectContaining({ provider: 'openai', model: 'gpt-legacy' }),
      systemPrompt: expect.stringContaining('Prompt especializado'),
    }));
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(finishes()).toEqual([
      { from: 'claimed', to: 'generated' },
      { from: 'generated', to: 'sent' },
    ]);
  });

  it('claims the legacy reply slot before reserving the governed budget', async () => {
    await dispatchInboundToAiReply(ARGS);
    const order = rpcNames();
    expect(order.indexOf('claim_ai_reply_slot')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('claim_ai_reply_slot')).toBeLessThan(order.indexOf('claim_ai_agent_budget'));
  });
});
