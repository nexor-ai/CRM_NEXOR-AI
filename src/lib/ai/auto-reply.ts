import { supabaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { buildConversationContext } from './context';
import { retrieveKnowledge } from './knowledge';
import { generateReply } from './generate';
import { buildSystemPrompt } from './defaults';
import { latestUserMessage } from './query';
import { engineSendText } from '@/lib/flows/meta-send';
import { notifyOperationalEvent } from '@/lib/notifications/producer';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendChatPresence, type EvolutionCredentials } from '@/lib/whatsapp/evolution-api';


interface DispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  /** Exact inbound transport configuration used by the specialized-agent router. */
  whatsappConfigId: string;
  /** Department resolved by the webhook from that exact configuration. */
  departmentId: string | null;
}

type AgentRoute = {
  agent_id: string;
  binding_id: string | null;
  route_source: 'sticky' | 'config_department' | 'config' | 'department' | 'default';
  mode: 'disabled' | 'draft_only' | 'supervised' | 'auto_reply';
};

type RunStatus = 'claimed' | 'generated';
type TerminalRunStatus = 'generated' | 'sent' | 'handoff' | 'failed';

const DEFAULT_ESTIMATED_COST_CENTS = 10;

function estimatedAgentCostCents(): number {
  const configured = Number(process.env.AI_AGENT_ESTIMATED_COST_CENTS);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_ESTIMATED_COST_CENTS;
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Specialized-agent resolution, legacy conversation cap and the P2 budget/cap
 * reservation all fail closed. Only an explicitly resolved `auto_reply` agent
 * may reach a provider or the WhatsApp send seam.
 */
export async function dispatchInboundToAiReply(args: DispatchArgs): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    whatsappConfigId,
    departmentId,
  } = args;

  try {
    const db = supabaseAdmin();
    const config = await loadAiConfig(db, accountId);
    if (!config) return;

    const { data: autoResponders, error: autoRespondersError } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1);
    if (autoRespondersError || (autoResponders && autoResponders.length > 0)) return;

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, department_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (convErr || !conv || !conv.department_id || !departmentId) return;
    // Never route a webhook-supplied config through a conversation stamped to
    // another department. Ambiguity/drift is a fail-closed no-op.
    if (conv.department_id !== departmentId) return;
    if (conv.assigned_agent_id || conv.ai_autoreply_disabled) return;

    const { data: stickyState, error: stickyError } = await db
      .from('conversation_agent_state')
      .select('sticky_agent_id')
      .eq('conversation_id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (stickyError) return;

    const { data: resolvedData, error: resolveError } = await db.rpc(
      'resolve_ai_agent_binding',
      {
        p_account_id: accountId,
        p_whatsapp_config_id: whatsappConfigId,
        p_department_id: departmentId,
        p_sticky_agent_id: stickyState?.sticky_agent_id ?? null,
      }
    );
    const routeRows = Array.isArray(resolvedData) ? resolvedData : resolvedData ? [resolvedData] : [];
    const route = routeRows.length === 1 ? routeRows[0] as AgentRoute : null;
    // Draft/supervised/disabled agents require human review and never reach
    // a provider or send from this automatic inbound pipeline.
    if (resolveError || !route || route.mode !== 'auto_reply') return;

    const { data: agent, error: agentError } = await db
      .from('ai_agents')
      .select('system_prompt')
      .eq('id', route.agent_id)
      .eq('account_id', accountId)
      .eq('is_active', true)
      .maybeSingle();
    if (agentError || !agent) return;
    if (!config.autoReplyEnabled) return;
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return;

    const messages = await buildConversationContext(db, conversationId);
    if (messages.length === 0) return;

    // Keep the legacy per-conversation cap until all callers/readers migrate.
    // Claim it before the P2 reservation so neither race can lead to a provider call.
    const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
      conversation_id: conversationId,
      max_replies: config.autoReplyMaxPerConversation,
    });
    if (claimErr || claimed !== true) return;

    const { data: runId, error: budgetError } = await db.rpc('claim_ai_agent_budget', {
      p_account_id: accountId,
      p_conversation_id: conversationId,
      p_agent_id: route.agent_id,
      p_binding_id: route.binding_id,
      p_whatsapp_config_id: whatsappConfigId,
      p_department_id: departmentId,
      p_route_source: route.route_source,
      p_estimated_cost_cents: estimatedAgentCostCents(),
    });
    if (budgetError || typeof runId !== 'string' || !runId) return;

    let runStatus: RunStatus = 'claimed';
    const failRun = async (error: unknown) => {
      await finishRun(db, {
        accountId,
        runId,
        expectedStatus: runStatus,
        status: 'failed',
        provider: config.provider,
        model: config.model,
        errorCode: error instanceof Error && 'code' in error
          ? String((error as Error & { code?: unknown }).code ?? 'ai_error')
          : 'ai_error',
        errorMessage: 'Falha governada no runtime do agente',
      }).catch((finishError) =>
        console.error('[ai auto-reply] failed to finalize failed run', {
          accountId,
          runId,
          errorType: finishError instanceof Error ? finishError.name : 'unknown',
        })
      );
    };

    try {
      // Knowledge retrieval can invoke an embeddings provider, so it must happen
      // only after the atomic P2 reservation.
      const knowledge = await retrieveKnowledge(
        db,
        accountId,
        config,
        latestUserMessage(messages)
      );
      const systemPrompt = buildSystemPrompt({
        userPrompt: agent.system_prompt ?? config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      });

      const presence = await loadEvolutionPresenceContext(
        db,
        accountId,
        contactId,
        whatsappConfigId
      );
      if (presence) {
        await sendChatPresence({
          ...presence.credentials,
          to: presence.phone,
          presence: 'composing',
        }).catch((error) =>
          console.warn('[ai auto-reply] composing presence failed:', error)
        );
      }

      let generated: Awaited<ReturnType<typeof generateReply>>;
      try {
        generated = await generateReply({ config: config, systemPrompt, messages });
      } finally {
        if (presence) {
          await sendChatPresence({
            ...presence.credentials,
            to: presence.phone,
            presence: 'paused',
          }).catch((error) =>
            console.warn('[ai auto-reply] paused presence failed:', error)
          );
        }
      }

      const generatedFinalized = await finishRun(db, {
        accountId,
        runId,
        expectedStatus: 'claimed',
        status: 'generated',
        provider: config.provider,
        model: config.model,
      });
      if (!generatedFinalized) return;
      runStatus = 'generated';

      const { text, handoff } = generated;
      if (handoff || !text) {
        const { data: handoffSet, error: handoffError } = await db.rpc(
          'set_ai_agent_handoff',
          {
            p_account_id: accountId,
            p_conversation_id: conversationId,
            p_status: 'requested',
            p_reason: handoff ? 'model_requested_handoff' : 'empty_model_reply',
          }
        );
        if (handoffError || handoffSet !== true) {
          throw handoffError ?? new Error('ai_agent_handoff_not_set');
        }

        const { error: conversationUpdateError } = await db
          .from('conversations')
          .update({ ai_autoreply_disabled: true, status: 'pending' })
          .eq('id', conversationId)
          .eq('account_id', accountId);
        if (conversationUpdateError) throw conversationUpdateError;

        const handoffFinalized = await finishRun(db, {
          accountId,
          runId,
          expectedStatus: 'generated',
          status: 'handoff',
          provider: config.provider,
          model: config.model,
        });
        if (!handoffFinalized) return;

        await notifyOperationalEvent(db, {
          accountId,
          userId: configOwnerUserId,
          eventKey: 'ai.handoff',
          category: 'ai',
          severity: 'warning',
          title: 'Agente de IA solicitou atendimento humano',
          body: 'A conversa foi movida para pendente e as respostas automáticas foram interrompidas.',
          targetUrl: `/inbox?c=${conversationId}`,
          entityType: 'conversation',
          entityId: conversationId,
          dedupeKey: `ai-handoff:${conversationId}`,
        }).catch((error) =>
          console.error('[ai auto-reply] handoff notification failed:', error)
        );
        return;
      }

      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
      });

      const sentFinalized = await finishRun(db, {
        accountId,
        runId,
        expectedStatus: 'generated',
        status: 'sent',
        provider: config.provider,
        model: config.model,
      });
      if (!sentFinalized) {
        console.error('[ai auto-reply] sent run lost its finalization fence:', runId);
      }
    } catch (error) {
      await failRun(error);
      throw error;
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err);
  }
}

async function finishRun(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string;
    runId: string;
    expectedStatus: RunStatus;
    status: TerminalRunStatus;
    provider: string;
    model: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  }
): Promise<boolean> {
  const { data, error } = await db.rpc('finish_ai_agent_run', {
    p_account_id: args.accountId,
    p_run_id: args.runId,
    p_expected_status: args.expectedStatus,
    p_status: args.status,
    p_provider: args.provider,
    p_model: args.model,
    p_error_code: args.errorCode ?? null,
    p_error_message: args.errorMessage ?? null,
  });
  if (error) throw error;
  return data === true;
}

async function loadEvolutionPresenceContext(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
  whatsappConfigId: string
): Promise<{ credentials: EvolutionCredentials; phone: string } | null> {
  const [{ data: configs }, { data: contact }] = await Promise.all([
    db
      .from('whatsapp_config')
      .select('evolution_base_url, evolution_instance, evolution_api_key')
      .eq('id', whatsappConfigId)
      .eq('account_id', accountId)
      .is('disabled_at', null)
      .not('evolution_base_url', 'is', null)
      .not('evolution_instance', 'is', null)
      .not('evolution_api_key', 'is', null)
      .limit(1),
    db
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);
  const transport = configs?.[0];
  if (
    !transport?.evolution_base_url ||
    !transport.evolution_instance ||
    !transport.evolution_api_key ||
    !contact?.phone
  ) return null;
  return {
    credentials: {
      baseUrl: transport.evolution_base_url,
      instance: transport.evolution_instance,
      apiKey: decrypt(transport.evolution_api_key),
    },
    phone: contact.phone,
  };
}
