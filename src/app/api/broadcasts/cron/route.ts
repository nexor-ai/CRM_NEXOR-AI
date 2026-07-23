import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendTemplateMessage } from '@/lib/whatsapp/evolution-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveActiveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  isRecipientNotAllowedError,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { notifyOperationalEvent } from '@/lib/notifications/producer';

interface QueueClaim {
  recipient_id: string;
  broadcast_id: string;
  account_id: string;
  contact_id: string;
  template_name: string;
  template_language: string;
  variation_text: string | null;
  send_params: unknown;
}

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET ?? '';
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function renderVariation(text: string, params: string[]): string {
  let rendered = text;
  params.forEach((value, index) => {
    rendered = rendered.replaceAll(`{{${index + 1}}}`, value);
  });
  return rendered;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('claim_next_broadcast_recipient', {
    p_now: new Date().toISOString(),
  });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const claim = (data?.[0] as QueueClaim | undefined) ?? null;
  if (!claim) return NextResponse.json({ processed: 0 });

  const [{ data: contact }, { data: templateRaw }, config] = await Promise.all([
    admin
      .from('contacts')
      .select('phone')
      .eq('id', claim.contact_id)
      .eq('account_id', claim.account_id)
      .maybeSingle(),
    admin
      .from('message_templates')
      .select('*')
      .eq('account_id', claim.account_id)
      .eq('name', claim.template_name)
      .eq('language', claim.template_language)
      .maybeSingle(),
    resolveActiveWhatsAppConfig(admin, claim.account_id),
  ]);

  const params = Array.isArray(claim.send_params)
    ? claim.send_params.filter(
        (item): item is string => typeof item === 'string'
      )
    : [];
  const template =
    templateRaw && isMessageTemplate(templateRaw)
      ? (templateRaw as MessageTemplate)
      : null;

  let sentMessageId: string | null = null;
  let lastError = '';

  try {
    if (!contact?.phone) throw new Error('Contact has no phone number');
    if (
      !config?.evolution_base_url ||
      !config.evolution_instance ||
      !config.evolution_api_key
    ) {
      throw new Error('Evolution API is not configured');
    }

    const selectedTemplate = claim.variation_text
      ? {
          ...(template ?? {
            id: `variation-${claim.broadcast_id}`,
            user_id: '',
            account_id: claim.account_id,
            name: claim.template_name,
            category: 'Utility' as const,
            language: claim.template_language,
            status: 'APPROVED' as const,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
          body_text: renderVariation(claim.variation_text, params),
        }
      : (template ?? undefined);

    for (const phone of phoneVariants(sanitizePhoneForMeta(contact.phone))) {
      try {
        const result = await sendTemplateMessage({
          baseUrl: config.evolution_base_url,
          instance: config.evolution_instance,
          apiKey: decrypt(config.evolution_api_key),
          to: phone,
          templateName: claim.template_name,
          language: claim.template_language,
          template: selectedTemplate,
          params: claim.variation_text ? [] : params,
        });
        sentMessageId = result.messageId;
        break;
      } catch (sendError) {
        lastError =
          sendError instanceof Error ? sendError.message : 'Erro desconhecido';
        if (!isRecipientNotAllowedError(lastError)) break;
      }
    }
  } catch (sendError) {
    lastError =
      sendError instanceof Error ? sendError.message : 'Erro desconhecido';
  }

  if (sentMessageId) {
    await admin
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        whatsapp_message_id: sentMessageId,
        whatsapp_instance: config?.evolution_instance ?? null,
        processing_started_at: null,
        error_message: null,
      })
      .eq('id', claim.recipient_id);
  } else {
    await admin
      .from('broadcast_recipients')
      .update({
        status: 'uncertain',
        processing_started_at: null,
        error_message:
          lastError ||
          'Delivery result uncertain. Manual review required; the worker will not retry automatically.',
      })
      .eq('id', claim.recipient_id);
  }

  const { count: pending } = await admin
    .from('broadcast_recipients')
    .select('*', { count: 'exact', head: true })
    .eq('broadcast_id', claim.broadcast_id)
    .in('status', ['pending', 'processing']);
  if ((pending ?? 0) === 0) {
    const { count: sent } = await admin
      .from('broadcast_recipients')
      .select('*', { count: 'exact', head: true })
      .eq('broadcast_id', claim.broadcast_id)
      .in('status', ['sent', 'delivered', 'read', 'replied']);
    const finalStatus = (sent ?? 0) > 0 ? 'sent' : 'failed';
    await admin
      .from('broadcasts')
      .update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        next_send_at: null,
      })
      .eq('id', claim.broadcast_id);
    const { data: campaign } = await admin
      .from('broadcasts')
      .select('user_id,name,failed_count,total_recipients')
      .eq('id', claim.broadcast_id)
      .maybeSingle();
    if (campaign?.user_id) {
      await notifyOperationalEvent(admin, {
        accountId: claim.account_id,
        userId: campaign.user_id,
        eventKey:
          finalStatus === 'sent' ? 'broadcast.completed' : 'broadcast.failed',
        category: 'broadcast',
        severity: finalStatus === 'sent' ? 'info' : 'error',
        title:
          finalStatus === 'sent'
            ? `Campanha concluída: ${campaign.name}`
            : `Campanha com falha: ${campaign.name}`,
        body: `${sent ?? 0} de ${campaign.total_recipients} destinatários enviados.`,
        targetUrl: `/broadcasts/${claim.broadcast_id}`,
        entityType: 'broadcast',
        entityId: claim.broadcast_id,
        dedupeKey: `broadcast:${claim.broadcast_id}:final`,
      });
    }
  }

  return NextResponse.json({
    processed: 1,
    broadcast_id: claim.broadcast_id,
    recipient_id: claim.recipient_id,
    status: sentMessageId ? 'sent' : 'failed',
  });
}
