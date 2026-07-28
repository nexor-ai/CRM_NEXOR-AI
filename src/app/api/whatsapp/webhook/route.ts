import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { verifyEvolutionWebhookToken } from '@/lib/whatsapp/webhook-signature';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  findMessages,
  getBase64FromMediaMessage,
  type EvolutionCredentials,
} from '@/lib/whatsapp/evolution-api';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistInboundMedia } from '@/lib/whatsapp/inbound-media';
import { buildInboundTranscriptionJob } from '@/lib/transcription/enqueue';

export const maxDuration = 60;

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin() {
  if (!_adminClient)
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  return _adminClient;
}

type JsonRecord = Record<string, unknown>;

type EvolutionWebhookBody = {
  event?: string;
  instance?: string;
  sender?: string;
  data?: unknown;
  apikey?: string;
  date_time?: string;
};

type NormalizedEvolutionMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  interactive?: {
    type?: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  context?: { id: string };
  reaction?: { message_id?: string; emoji?: string };
  image?: EvolutionMedia;
  video?: EvolutionMedia;
  audio?: EvolutionMedia;
  document?: EvolutionMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contact?: { displayName?: string; vcard?: string };
  sticker?: EvolutionMedia;
  poll?: { name: string; values: string[]; selectableCount: number };
};

type EvolutionMedia = {
  caption?: string;
  filename?: string;
  url?: string;
  base64?: string;
  mime_type?: string;
  size_bytes?: number;
  duration_seconds?: number;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? (value as JsonRecord) : {};
}

export async function GET() {
  // EVOLUTION: no hub.verify_token handshake; this is just a health-check endpoint.
  return NextResponse.json({ ok: true, provider: 'evolution' });
}

export async function POST(request: Request) {
  if (!verifyEvolutionWebhookToken(request)) {
    console.warn('[webhook] rejected Evolution request with invalid token');
    return NextResponse.json(
      { error: 'Token de webhook inválido' },
      { status: 401 }
    );
  }
  let body: EvolutionWebhookBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const instance = body.instance || String(asRecord(body.data).instance || '');
  if (!instance) return NextResponse.json({ error: 'Instância Evolution ausente' }, { status: 400 });
  const accountScope = request.headers.get('x-wacrm-webhook-scope');
  if (!accountScope) {
    return NextResponse.json({ error: 'Escopo do webhook ausente' }, { status: 401 });
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id')
    .eq('evolution_instance', instance)
    .eq('account_id', accountScope)
    .is('disabled_at', null)
    .maybeSingle();
  if (configError || !config) {
    console.warn('[webhook] rejected unknown or mismatched Evolution instance');
    return NextResponse.json({ error: 'Instância Evolution desconhecida' }, { status: 401 });
  }

  const eventKey = evolutionWebhookEventKey(body);
  const { error } = await supabaseAdmin().from('evolution_webhook_events').insert({
    event_key: eventKey,
    instance,
    event_type: canonicalEvolutionEvent(body.event),
    payload: body,
    account_id: config.account_id,
    whatsapp_config_id: config.id,
  });
  if (error && error.code !== '23505') {
    console.error('[webhook] durable enqueue failed:', error.message);
    return NextResponse.json({ error: 'Fila de webhook indisponível' }, { status: 503 });
  }
  return NextResponse.json({ status: error?.code === '23505' ? 'duplicate' : 'queued' }, { status: 202 });
}

export function evolutionWebhookEventKey(body: EvolutionWebhookBody): string {
  const data = asRecord(body.data);
  const key = asRecord(data.key);
  const stableTransportId = key.id || data.keyId || data.id;
  if (stableTransportId) {
    const event = canonicalEvolutionEvent(body.event);
    const semanticSuffix = event === 'messages.update'
      ? `:${normalizeEvolutionStatus(data.status ?? asRecord(data.update).status)}`
      : '';
    return createHash('sha256')
      .update(`${body.instance || data.instance || ''}:${event}:${stableTransportId}${semanticSuffix}`)
      .digest('hex');
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function canonicalEvolutionEvent(event: unknown): string {
  return String(event || '').trim().toLowerCase().replaceAll('_', '.');
}

export async function processEvolutionWebhook(
  body: EvolutionWebhookBody,
  source: 'webhook' | 'reconciliation' = 'webhook',
  scope: { accountId?: string | null; configId?: string | null } = {}
): Promise<'processed' | 'duplicate' | 'ignored'> {
  const event = canonicalEvolutionEvent(body.event);
  const eventData = asRecord(body.data);
  const instance = body.instance || String(eventData.instance || '');
  if (!instance) return 'ignored';

  let configQuery = supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('evolution_instance', instance)
    .is('disabled_at', null);
  if (scope.accountId) configQuery = configQuery.eq('account_id', scope.accountId);
  if (scope.configId) configQuery = configQuery.eq('id', scope.configId);
  const { data: configRows, error } = await configQuery.limit(2);
  if (error || configRows?.length !== 1) {
    throw new Error(
      error
        ? `Failed to resolve Evolution config: ${error.message}`
        : `Evolution config resolution is ${configRows?.length ? 'ambiguous' : 'empty'}`
    );
  }
  const config = configRows[0];

  if (source === 'webhook') {
    const { error: telemetryError } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({ last_webhook_at: new Date().toISOString() })
      .eq('id', config.id);
    if (telemetryError) {
      console.error('[webhook] failed to update last_webhook_at:', telemetryError);
    }
  }

  if (event.includes('connection.update')) {
    const state =
      eventData.state ??
      asRecord(eventData.instance).state ??
      eventData.connection ??
      'connecting';
    await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        connection_state: state,
        status: state === 'open' ? 'connected' : 'disconnected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', config.id);
    return 'processed';
  }

  if (event.includes('messages.update') || event.includes('send.message')) {
    const rows = Array.isArray(body.data) ? body.data : [body.data];
    for (const rawRow of rows) {
      const statusEvent = normalizeEvolutionStatusEvent(rawRow);
      await handleStatusUpdate(statusEvent, instance);
    }
    return 'processed';
  }

  if (!event.includes('messages.upsert')) return 'ignored';

  const data = asRecord(body.data);
  const dataKey = asRecord(data.key);
  if (!dataKey.id) return 'ignored';
  if (dataKey.fromMe) return 'ignored';
  const transportMessageId = String(dataKey.id);
  const normalized = normalizeEvolutionMessage(data);
  if (!normalized) return 'ignored';
  const inboundMedia =
    normalized.image || normalized.video || normalized.audio || normalized.document || normalized.sticker;
  if (
    inboundMedia &&
    !inboundMedia.url &&
    !inboundMedia.base64 &&
    config.evolution_base_url &&
    config.evolution_instance &&
    config.evolution_api_key
  ) {
    try {
      const transportCredential = decrypt(config.evolution_api_key);
      const downloaded = await getBase64FromMediaMessage({
        baseUrl: config.evolution_base_url,
        instance: config.evolution_instance,
        apiKey: transportCredential,
        message: data,
      });
      inboundMedia.base64 = downloaded.base64;
      if (downloaded.mimetype) inboundMedia.mime_type = downloaded.mimetype;
    } catch (mediaError) {
      console.error('[webhook] inbound media fallback failed for', transportMessageId, mediaError);
    }
  }
  if (inboundMedia) {
    await persistInboundMedia(
      supabaseAdmin(),
      inboundMedia,
      config.account_id,
      transportMessageId
    );
  }
  await processMessage(
    normalized,
    {
      profile: { name: String(data.pushName || normalized.from) },
      wa_id: normalized.from,
    },
    config.account_id,
    config.user_id,
    {
      id: config.id,
      instance: config.evolution_instance,
      departmentId: config.department_id ?? null,
      accountPhone: body.sender
        ? String(body.sender)
        : data.sender
          ? String(data.sender)
        : data.owner
          ? String(data.owner)
          : null,
    }
  );
  return 'processed';
}

export function extractEvolutionMessageRecords(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  const messages = asRecord(root.messages);
  const candidate = Array.isArray(payload)
    ? payload
    : Array.isArray(root.records)
      ? root.records
      : Array.isArray(messages.records)
        ? messages.records
        : Array.isArray(root.messages)
          ? root.messages
          : [];
  const seen = new Set<string>();
  return candidate
    .map(asRecord)
    .filter((record) => {
      const id = String(asRecord(record.key).id || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

export async function collectEvolutionMessageRecords(args: {
  limit: number;
  pageSize?: number;
  fetchPage: (page: number, pageSize: number) => Promise<unknown>;
}): Promise<JsonRecord[]> {
  const limit = Math.max(1, Math.min(Math.floor(args.limit), 1_000));
  const pageSize = Math.max(1, Math.min(Math.floor(args.pageSize ?? 50), 200));
  const records: JsonRecord[] = [];
  const seen = new Set<string>();

  for (let page = 1; records.length < limit && page <= 100; page += 1) {
    const payload = await args.fetchPage(page, pageSize);
    const pageRecords = extractEvolutionMessageRecords(payload);
    for (const record of pageRecords) {
      const id = String(asRecord(record.key).id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      records.push(record);
      if (records.length >= limit) break;
    }
    if (pageRecords.length < pageSize) break;
  }
  return records;
}

export type ReconciliationSummary = {
  fetched: number;
  processed: number;
  duplicates: number;
  ignored: number;
  failed: number;
  errors: Array<{ message_id: string; error: string }>;
};

export async function processReconciliationRecords(
  records: JsonRecord[],
  processRecord: (
    record: JsonRecord
  ) => Promise<'processed' | 'duplicate' | 'ignored'>
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    fetched: records.length,
    processed: 0,
    duplicates: 0,
    ignored: 0,
    failed: 0,
    errors: [],
  };
  for (const record of records.slice().reverse()) {
    const messageId = String(asRecord(record.key).id || 'unknown');
    try {
      const outcome = await processRecord(record);
      if (outcome === 'processed') summary.processed += 1;
      else if (outcome === 'duplicate') summary.duplicates += 1;
      else summary.ignored += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        message_id: messageId,
        error: error instanceof Error ? error.message : 'Unknown reconciliation error',
      });
    }
  }
  return summary;
}

export async function reconcileEvolutionMessages(
  args: EvolutionCredentials & {
    instance: string;
    configId?: string;
    remoteJid?: string;
    limit?: number;
  }
): Promise<ReconciliationSummary> {
  try {
    const requestedLimit = args.limit ?? 50;
    const records = await collectEvolutionMessageRecords({
      limit: requestedLimit,
      pageSize: Math.min(requestedLimit, 50),
      fetchPage: (page, pageSize) => findMessages({
        ...args,
        remoteJid: args.remoteJid,
        limit: pageSize,
        page,
      }),
    });
    const summary = await processReconciliationRecords(records, (record) =>
      processEvolutionWebhook(
        { event: 'MESSAGES_UPSERT', instance: args.instance, data: record },
        'reconciliation',
        { configId: args.configId }
      )
    );
    let telemetryUpdate = supabaseAdmin()
      .from('whatsapp_config')
      .update({
        last_reconciliation_at: new Date().toISOString(),
        last_reconciliation_error:
          summary.failed > 0 ? `${summary.failed} reconciliation record(s) failed` : null,
      });
    telemetryUpdate = args.configId
      ? telemetryUpdate.eq('id', args.configId)
      : telemetryUpdate.eq('evolution_instance', args.instance);
    const { error } = await telemetryUpdate.is('disabled_at', null);
    if (error) throw new Error(`Failed to persist reconciliation telemetry: ${error.message}`);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown reconciliation error';
    let telemetryUpdate = supabaseAdmin()
      .from('whatsapp_config')
      .update({ last_reconciliation_error: message });
    telemetryUpdate = args.configId
      ? telemetryUpdate.eq('id', args.configId)
      : telemetryUpdate.eq('evolution_instance', args.instance);
    await telemetryUpdate.is('disabled_at', null);
    throw error;
  }
}

function normalizeEvolutionStatus(status: unknown): string {
  const s = String(status ?? '').toLowerCase();
  if (['read', 'delivered', 'failed', 'sent'].includes(s)) return s;
  if (s === 'server_ack' || s === 'delivery_ack') return 'delivered';
  if (s === 'read_ack') return 'read';
  return 'sent';
}

export function normalizeEvolutionStatusEvent(rawRow: unknown) {
  const row = asRecord(rawRow);
  const key = asRecord(row.key);
  const update = asRecord(row.update);
  return {
    id: String(row.keyId ?? key.id ?? row.id ?? ''),
    status: normalizeEvolutionStatus(row.status ?? update.status),
    timestamp: String(
      row.messageTimestamp ?? Math.floor(Date.now() / 1000)
    ),
    recipient_id: String(row.remoteJid ?? key.remoteJid ?? ''),
  };
}

export function normalizeEvolutionMessage(
  rawData: JsonRecord
): NormalizedEvolutionMessage | null {
  const data = rawData;
  const msg = asRecord(data.message);
  const key = asRecord(data.key);
  const id = String(key.id || '');
  const primaryRemote = String(key.remoteJid || '');
  const alternateRemote = String(key.remoteJidAlt || '');
  const remote = primaryRemote.endsWith('@s.whatsapp.net')
    ? primaryRemote
    : alternateRemote.endsWith('@s.whatsapp.net')
      ? alternateRemote
      : primaryRemote;
  // Only process messages from actual WhatsApp users (not groups or lite IDs)
  if (!remote.endsWith('@s.whatsapp.net')) {
    return null;
  }
  const cleanRemote = remote.replace(/@.*/, '');
  const timestamp = String(
    data.messageTimestamp ?? Math.floor(Date.now() / 1000)
  );
  if (msg.reactionMessage) {
    const reaction = asRecord(msg.reactionMessage);
    return {
      id,
      from: cleanRemote,
      timestamp,
      type: 'reaction',
      reaction: {
        message_id: String(asRecord(reaction.key).id || ''),
        emoji: String(reaction.text || ''),
      },
    };
  }
  if (msg.buttonsResponseMessage) {
    const buttons = asRecord(msg.buttonsResponseMessage);
    const buttonId = String(buttons.selectedButtonId || '');
    const buttonTitle = String(buttons.selectedDisplayText || buttonId);
    return {
      id,
      from: cleanRemote,
      timestamp,
      type: 'interactive',
      text: { body: buttonTitle },
      interactive: {
        type: 'button_reply',
        button_reply: { id: buttonId, title: buttonTitle },
      },
    };
  }
  if (msg.listResponseMessage) {
    const list = asRecord(msg.listResponseMessage);
    const selected = asRecord(list.singleSelectReply);
    const rowId = String(selected.selectedRowId || '');
    const rowTitle = String(list.title || rowId);
    return {
      id,
      from: cleanRemote,
      timestamp,
      type: 'interactive',
      text: { body: rowTitle },
      interactive: {
        type: 'list_reply',
        list_reply: { id: rowId, title: rowTitle },
      },
    };
  }
  if (msg.locationMessage) {
    const location = asRecord(msg.locationMessage);
    return {
      id, from: cleanRemote, timestamp, type: 'location',
      location: {
        latitude: Number(location.degreesLatitude),
        longitude: Number(location.degreesLongitude),
        name: location.name ? String(location.name) : undefined,
        address: location.address ? String(location.address) : undefined,
      },
    };
  }
  if (msg.contactMessage) {
    const contact = asRecord(msg.contactMessage);
    return {
      id, from: cleanRemote, timestamp, type: 'contact',
      contact: {
        displayName: contact.displayName ? String(contact.displayName) : undefined,
        vcard: contact.vcard ? String(contact.vcard) : undefined,
      },
    };
  }
  if (msg.stickerMessage) {
    const sticker = asRecord(msg.stickerMessage);
    return {
      id, from: cleanRemote, timestamp, type: 'sticker',
      sticker: {
        mime_type: String(sticker.mimetype || 'image/webp'),
        url: msg.mediaUrl ? String(msg.mediaUrl) : sticker.url ? String(sticker.url) : undefined,
        base64: msg.base64 ? String(msg.base64) : sticker.base64 ? String(sticker.base64) : undefined,
      },
    };
  }
  if (msg.pollCreationMessageV3 || msg.pollCreationMessage) {
    const poll = asRecord(msg.pollCreationMessageV3 || msg.pollCreationMessage);
    const options = Array.isArray(poll.options) ? poll.options : [];
    return {
      id, from: cleanRemote, timestamp, type: 'poll',
      poll: {
        name: String(poll.name || 'Enquete'),
        values: options.map(option => String(asRecord(option).optionName || '')).filter(Boolean),
        selectableCount: Number(poll.selectableOptionsCount || 1),
      },
    };
  }
  const extended = asRecord(msg.extendedTextMessage);
  if (msg.conversation || extended.text) {
    const contextInfo = asRecord(extended.contextInfo);
    return {
      id,
      from: cleanRemote,
      timestamp,
      type: 'text',
      text: { body: String(msg.conversation || extended.text) },
      context: contextInfo.stanzaId
        ? { id: String(contextInfo.stanzaId) }
        : undefined,
    };
  }
  for (const [type, field] of [
    ['image', 'imageMessage'],
    ['video', 'videoMessage'],
    ['audio', 'audioMessage'],
    ['document', 'documentMessage'],
  ] as const) {
    if (msg[field]) {
      const media = asRecord(msg[field]);
      const rootBase64 = msg.base64 ? String(msg.base64) : undefined;
      const rootMediaUrl = msg.mediaUrl ? String(msg.mediaUrl) : undefined;
      return {
        id,
        from: cleanRemote,
        timestamp,
        type,
        [type]: {
          id,
          mime_type: String(media.mimetype || 'application/octet-stream'),
          caption: media.caption ? String(media.caption) : undefined,
          filename: media.fileName ? String(media.fileName) : undefined,
          url: rootMediaUrl ?? (media.url ? String(media.url) : undefined),
          base64:
            rootBase64 ?? (media.base64 ? String(media.base64) : undefined),
          size_bytes: Number(media.fileLength || 0),
          duration_seconds: Number(media.seconds || 0),
        },
      };
    }
  }
  return {
    id,
    from: cleanRemote,
    timestamp,
    type: 'text',
    text: { body: '[unsupported message]' },
  };
}

async function handleStatusUpdate(
  status: {
    id: string;
    status: string;
    timestamp: string;
    recipient_id: string;
  },
  instance: string
) {
  if (!status.id) return;
  const { data: statusChanged, error: statusError } = await supabaseAdmin().rpc('advance_evolution_message_status', {
    transport_message_id: status.id,
    transport_instance: instance,
    incoming_status: status.status,
  });
  if (statusError) throw new Error(`Failed to advance message status: ${statusError.message}`);
  if (statusChanged !== true) return;
  const tsIso = new Date(Number(status.timestamp) * 1000).toISOString();
  const { data: msgRows, error: messageLookupError } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .eq('whatsapp_instance', instance)
    .limit(1);
  if (messageLookupError) throw new Error(`Failed to scope status update: ${messageLookupError.message}`);
  const msgRow = msgRows?.[0];
  const convRelation = msgRow?.conversations;
  const conv = Array.isArray(convRelation) ? convRelation[0] : convRelation;

  if (conv?.account_id) {
    const { data: recipient, error: recipientError } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status')
      .eq('whatsapp_message_id', status.id)
      .eq('whatsapp_instance', instance)
      .maybeSingle();
    if (recipientError) {
      throw new Error(`Failed to resolve broadcast recipient status: ${recipientError.message}`);
    }
    if (recipient && isValidStatusTransition(recipient.status, status.status)) {
      const update: Record<string, unknown> = { status: status.status };
      if (status.status === 'sent') update.sent_at = tsIso;
      if (status.status === 'delivered') update.delivered_at = tsIso;
      if (status.status === 'read') update.read_at = tsIso;
      const { error: recipientUpdateError } = await supabaseAdmin()
        .from('broadcast_recipients')
        .update(update)
        .eq('id', recipient.id);
      if (recipientUpdateError) {
        throw new Error(`Failed to update broadcast recipient status: ${recipientUpdateError.message}`);
      }
    }
  }
  if (msgRow && conv?.account_id)
    await dispatchWebhookEvent(
      supabaseAdmin(),
      conv.account_id,
      'message.status_updated',
      {
        whatsapp_message_id: status.id,
        conversation_id: msgRow.conversation_id,
        status: status.status,
      }
    );
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent';
  if (current === 'failed') return false;
  const ci = ladderLevel(current),
    ii = ladderLevel(incoming);
  if (ii < 0) return false;
  if (ci < 0) return true;
  return ii > ci;
}

const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;
function ladderLevel(s: string): number {
  return (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  const { data: recs } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status, broadcast_id, broadcasts!inner(account_id)')
    .eq('contact_id', contactId)
    .eq('broadcasts.account_id', accountId)
    .in('status', ['sent', 'delivered', 'read'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (recs?.[0])
    await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id);
}

async function lookupInternalIdByTransportId(
  id: string,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', id)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  return data?.id ?? null;
}

async function handleReaction(
  message: NormalizedEvolutionMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction;
  if (!reaction?.message_id) return;
  const targetInternalId = await lookupInternalIdByTransportId(
    reaction.message_id,
    conversationId
  );
  if (!targetInternalId) return;
  if (!reaction.emoji) {
    await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    return;
  }
  await supabaseAdmin().from('message_reactions').upsert(
    {
      message_id: targetInternalId,
      conversation_id: conversationId,
      actor_type: 'customer',
      actor_id: contactId,
      emoji: reaction.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' }
  );
}

type InboundEffectRetryPolicy = 'retry_safe' | 'at_most_once';

type EffectClaim = {
  effect_id: string;
  effect_status: 'claimed' | 'completed' | 'failed' | 'uncertain';
  effect_result: unknown;
  effect_claim_token: string;
  acquired: boolean;
};

async function runInboundEffect<T>(
  accountId: string,
  internalMessageId: string,
  effectName: string,
  run: () => Promise<T>,
  retryPolicy: InboundEffectRetryPolicy = 'at_most_once'
): Promise<T | undefined> {
  const admin = supabaseAdmin();
  const { data, error: claimError } = await admin.rpc(
    'claim_evolution_message_effect',
    {
      message_id_arg: internalMessageId,
      account_id_arg: accountId,
      effect_name_arg: effectName,
      retry_failed_arg: retryPolicy === 'retry_safe',
    }
  );
  if (claimError) {
    throw new Error(`Failed to claim inbound effect ${effectName}: ${claimError.message}`);
  }

  const claim = (Array.isArray(data) ? data[0] : data) as EffectClaim | null;
  if (!claim) throw new Error(`Inbound effect ${effectName} returned no claim state`);
  if (claim.effect_status === 'completed') return claim.effect_result as T;
  if (!claim.acquired) {
    throw new Error(
      `Inbound effect ${effectName} is ${claim.effect_status}; manual reconciliation is required`
    );
  }

  try {
    const result = await run();
    const { data: completed, error: completeError } = await admin.rpc(
      'finish_evolution_message_effect',
      {
        effect_id_arg: claim.effect_id,
        claim_token_arg: claim.effect_claim_token,
        status_arg: 'completed',
        result_arg: result === undefined ? null : result,
        error_arg: null,
      }
    );
    if (completeError) throw completeError;
    if (completed !== true) throw new Error(`Inbound effect ${effectName} lost its lease`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown inbound effect error';
    const terminalStatus = retryPolicy === 'retry_safe' ? 'failed' : 'uncertain';
    const { error: failureError } = await admin.rpc('finish_evolution_message_effect', {
      effect_id_arg: claim.effect_id,
      claim_token_arg: claim.effect_claim_token,
      status_arg: terminalStatus,
      result_arg: null,
      error_arg: message,
    });
    if (failureError) {
      console.error(
        `[webhook] failed to persist ${terminalStatus} effect state:`,
        effectName,
        failureError.message
      );
    }
    throw error;
  }
}

async function processMessage(
  message: NormalizedEvolutionMessage,
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  config: {
    id: string;
    instance: string | null;
    accountPhone: string | null;
    departmentId?: string | null;
  }
) {
  const senderPhone = normalizePhone(message.from);
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contact.profile.name
  );
  const contactRecord = contactOutcome.contact;
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  const conversation = convResult.conversation;
  if (convResult.created)
    await dispatchWebhookEvent(
      supabaseAdmin(),
      accountId,
      'conversation.created',
      { conversation_id: conversation.id, contact_id: contactRecord.id }
    );
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id);
    return;
  }
  const { contentText, mediaUrl, interactiveReplyId, contentData } =
    parseMessageContent(message);
  let replyToInternalId: string | null = null;
  if (message.context?.id)
    replyToInternalId = await lookupInternalIdByTransportId(
      message.context.id,
      conversation.id
    );
  const allowed = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'contact',
    'sticker',
    'poll',
    'template',
    'interactive',
  ]);
  const contentType = allowed.has(message.type) ? message.type : 'text';
  const { count } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (count ?? 0) === 0;
  const { data: insertedMessage, error: msgError } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      content_data: contentData,
      message_id: message.id,
      status: 'delivered',
      created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
      reply_to_message_id: replyToInternalId || undefined,
      interactive_reply_id: interactiveReplyId,
      whatsapp_config_id: config.id,
      whatsapp_provider: 'evolution',
      whatsapp_instance: config.instance,
      whatsapp_account_phone: config.accountPhone,
    })
    .select('id')
    .single();
  let internalMessageId = insertedMessage?.id as string | undefined;
  let messageWasInserted = Boolean(internalMessageId);
  if (msgError) {
    if (!isUniqueViolation(msgError)) {
      throw new Error(`Failed to persist inbound message: ${msgError.message}`);
    }
    const { data: existingMessage, error: existingMessageError } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .eq('message_id', message.id)
      .eq('whatsapp_instance', config.instance)
      .single();
    if (existingMessageError || !existingMessage) {
      throw new Error('Inbound message exists but could not be reloaded');
    }
    internalMessageId = existingMessage.id;
    messageWasInserted = false;
  }
  if (!internalMessageId) throw new Error('Inbound message id was not persisted');

  if (messageWasInserted && message.audio) {
    const transcriptionJob = buildInboundTranscriptionJob({
      accountId,
      messageId: internalMessageId,
      conversationId: conversation.id,
      whatsappConfigId: config.id,
      departmentId: config.departmentId ?? null,
      mediaReference: message.audio.url,
      mimeType: message.audio.mime_type,
      sizeBytes: message.audio.size_bytes,
      durationSeconds: message.audio.duration_seconds,
    });
    if (transcriptionJob) {
      const { error: transcriptionError } = await supabaseAdmin()
        .from('transcription_jobs')
        .upsert(transcriptionJob, {
          onConflict: 'account_id,message_id',
          ignoreDuplicates: true,
        });
      if (transcriptionError) {
        throw new Error(`Failed to enqueue transcription: ${transcriptionError.message}`);
      }
    }
  }

  if (messageWasInserted) {
    const { error: conversationUpdateError } = await supabaseAdmin().rpc(
      'increment_inbound_conversation',
      {
        conversation_id_arg: conversation.id,
        config_id_arg: config.id,
        provider_arg: 'evolution',
        instance_arg: config.instance,
        message_text_arg: contentText || `[${message.type}]`,
        message_at_arg: new Date().toISOString(),
      }
    );
    if (conversationUpdateError) {
      throw new Error(`Failed to update inbound conversation: ${conversationUpdateError.message}`);
    }
  }
  await runInboundEffect(
    accountId,
    internalMessageId,
    'broadcast_reply_flag',
    async () => {
      await flagBroadcastReplyIfAny(accountId, contactRecord.id);
      return { completed: true };
    },
    'retry_safe'
  );
  await runInboundEffect(accountId, internalMessageId, 'external_webhook_message_received', async () => {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      message_id: message.id,
      content_text: contentText,
      content_type: contentType,
    });
    return { completed: true };
  });
  const flowResult = await runInboundEffect(accountId, internalMessageId, 'flows', () =>
    dispatchInboundToFlows({
      accountId,
      userId: configOwnerUserId,
      contactId: contactRecord.id,
      conversationId: conversation.id,
      message: interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText || interactiveReplyId,
            meta_message_id: message.id,
          }
        : { kind: 'text', text: contentText || '', meta_message_id: message.id },
      isFirstInboundMessage,
    })
  );
  const triggers: Array<
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  > = [];
  if (contactOutcome.created) triggers.push('new_contact_created');
  if (isFirstInboundMessage) triggers.push('first_inbound_message');
  if (!flowResult?.consumed) {
    triggers.push('new_message_received');
    if (contentText) triggers.push('keyword_match');
  }
  for (const trigger of triggers) {
    await runInboundEffect(accountId, internalMessageId, `automation:${trigger}`, async () => {
      await runAutomationsForTrigger({
        accountId,
        triggerType: trigger,
        contactId: contactRecord.id,
        context: {
          message_text: contentText || undefined,
          conversation_id: conversation.id,
        },
      });
      return { completed: true };
    });
  }
  if (!flowResult?.consumed) {
    await runInboundEffect(accountId, internalMessageId, 'ai_auto_reply', async () => {
      await dispatchInboundToAiReply({
        accountId,
        contactId: contactRecord.id,
        conversationId: conversation.id,
        configOwnerUserId,
        whatsappConfigId: config.id,
        departmentId: config.departmentId ?? null,
      });
      return { completed: true };
    });
  }
}

function parseMessageContent(message: NormalizedEvolutionMessage): {
  contentText: string | null;
  mediaUrl: string | null;
  interactiveReplyId: string | null;
  contentData: JsonRecord | null;
} {
  if (message.text?.body)
    return {
      contentText: message.text.body,
      mediaUrl: null,
      interactiveReplyId: null,
      contentData: null,
    };
  if (message.interactive?.button_reply)
    return {
      contentText: message.interactive.button_reply.title,
      mediaUrl: null,
      interactiveReplyId: message.interactive.button_reply.id,
      contentData: null,
    };
  if (message.interactive?.list_reply)
    return {
      contentText: message.interactive.list_reply.title,
      mediaUrl: null,
      interactiveReplyId: message.interactive.list_reply.id,
      contentData: null,
    };
  if (message.location)
    return {
      contentText: message.location.name || message.location.address || 'Localização compartilhada',
      mediaUrl: null,
      interactiveReplyId: null,
      contentData: message.location,
    };
  if (message.contact)
    return {
      contentText: message.contact.displayName || 'Contato compartilhado',
      mediaUrl: null,
      interactiveReplyId: null,
      contentData: message.contact,
    };
  if (message.poll)
    return {
      contentText: message.poll.name,
      mediaUrl: null,
      interactiveReplyId: null,
      contentData: message.poll,
    };
  const media =
    message.image || message.video || message.audio || message.document || message.sticker;
  if (media)
    return {
      contentText: media.caption || media.filename || `[${message.type}]`,
      mediaUrl:
        media.url ||
        (media.base64
          ? `data:${media.mime_type};base64,${media.base64}`
          : null),
      interactiveReplyId: null,
      contentData: null,
    };
  return {
    contentText: `[${message.type}]`,
    mediaUrl: null,
    interactiveReplyId: null,
    contentData: null,
  };
}

async function findOrCreateContact(
  accountId: string,
  userId: string,
  phone: string,
  name: string
) {
  const existing = await findExistingContact(supabaseAdmin(), accountId, phone);
  if (existing) return { contact: existing, created: false };
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .insert({ account_id: accountId, user_id: userId, phone, name })
    .select()
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const retry = await findExistingContact(
        supabaseAdmin(),
        accountId,
        phone
      );
      if (retry) return { contact: retry, created: false };
    }
    throw new Error(`Failed to create contact: ${error.message}`);
  }
  return { contact: data, created: true };
}

async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string
) {
  const { data: existing, error: existingError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existingError) throw new Error(`Failed to find conversation: ${existingError.message}`);
  if (existing) return { conversation: existing, created: false };
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId })
    .select()
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: retry, error: retryError } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .single();
      if (!retryError && retry) return { conversation: retry, created: false };
    }
    throw new Error(`Failed to create conversation: ${error.message}`);
  }
  return { conversation: data, created: true };
}
