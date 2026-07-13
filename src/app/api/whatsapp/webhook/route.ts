import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyEvolutionWebhookToken } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

export const maxDuration = 60

let _adminClient: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
function supabaseAdmin() {
  if (!_adminClient) _adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return _adminClient
}

type EvolutionWebhookBody = { event?: string; instance?: string; data?: any; apikey?: string; date_time?: string } // eslint-disable-line @typescript-eslint/no-explicit-any

export async function GET() {
  // EVOLUTION: no hub.verify_token handshake; this is just a health-check endpoint.
  return NextResponse.json({ ok: true, provider: 'evolution' })
}

export async function POST(request: Request) {
  if (!verifyEvolutionWebhookToken(request)) {
    console.warn('[webhook] rejected Evolution request with invalid token')
    return NextResponse.json({ error: 'Invalid webhook token' }, { status: 401 })
  }
  let body: EvolutionWebhookBody
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  after(async () => {
    try { await processEvolutionWebhook(body) }
    catch (error) { console.error('Error processing Evolution webhook:', error) }
  })
  return NextResponse.json({ status: 'received' })
}

async function processEvolutionWebhook(body: EvolutionWebhookBody) {
  const event = String(body.event || '').toLowerCase()
  const instance = body.instance || body.data?.instance
  if (!instance) return

  const { data: configRows, error } = await supabaseAdmin().from('whatsapp_config').select('*').eq('evolution_instance', instance)
  if (error || !configRows?.length) {
    console.error('[webhook] no config for evolution_instance:', instance, error)
    return
  }
  const config = configRows[0]

  if (event.includes('connection.update')) {
    const state = body.data?.state ?? body.data?.instance?.state ?? body.data?.connection ?? 'connecting'
    await supabaseAdmin().from('whatsapp_config').update({ connection_state: state, status: state === 'open' ? 'connected' : 'disconnected', updated_at: new Date().toISOString() }).eq('id', config.id)
    return
  }

  if (event.includes('messages.update') || event.includes('send.message')) {
    const rows = Array.isArray(body.data) ? body.data : [body.data]
    for (const row of rows) {
      try {
        await handleStatusUpdate({
          id: row?.key?.id ?? row?.id,
          status: normalizeEvolutionStatus(row?.status ?? row?.update?.status),
          timestamp: String(row?.messageTimestamp ?? Math.floor(Date.now() / 1000)),
          recipient_id: row?.key?.remoteJid ?? '',
        })
      } catch (err) {
        console.error('[webhook] status update failed for', row?.key?.id, err)
      }
    }
    return
  }

  if (!event.includes('messages.upsert')) return

  const data = body.data
  if (!data?.key?.id) return
  if (data.key.fromMe) return
  const normalized = normalizeEvolutionMessage(data)
  if (!normalized) return
  await processMessage(normalized, { profile: { name: data.pushName || normalized.from }, wa_id: normalized.from }, config.account_id, config.user_id)
}

function normalizeEvolutionStatus(status: unknown): string {
  const s = String(status ?? '').toLowerCase()
  if (['read', 'delivered', 'failed', 'sent'].includes(s)) return s
  if (s === 'server_ack' || s === 'delivery_ack') return 'delivered'
  if (s === 'read_ack') return 'read'
  return 'sent'
}

function normalizeEvolutionMessage(data: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const msg = data.message || {}
  const key = data.key || {}
  const remote = String(key.remoteJid || '')
  // Only process messages from actual WhatsApp users (not groups or lite IDs)
  if (!remote.endsWith('@s.whatsapp.net')) {
    return null
  }
  const cleanRemote = remote.replace(/@.*/, '')
  const timestamp = String(data.messageTimestamp ?? Math.floor(Date.now()/1000))
  if (msg.reactionMessage) return { id: key.id, from: cleanRemote, timestamp, type: 'reaction', reaction: { message_id: msg.reactionMessage.key?.id, emoji: msg.reactionMessage.text || '' } }
  if (msg.buttonsResponseMessage) return { id: key.id, from: cleanRemote, timestamp, type: 'interactive', text: { body: msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId }, interactive: { type: 'button_reply', button_reply: { id: msg.buttonsResponseMessage.selectedButtonId, title: msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId } } }
  if (msg.listResponseMessage) return { id: key.id, from: cleanRemote, timestamp, type: 'interactive', text: { body: msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply?.selectedRowId }, interactive: { type: 'list_reply', list_reply: { id: msg.listResponseMessage.singleSelectReply?.selectedRowId, title: msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply?.selectedRowId } } }
  if (msg.conversation || msg.extendedTextMessage?.text) return { id: key.id, from: cleanRemote, timestamp, type: 'text', text: { body: msg.conversation || msg.extendedTextMessage.text }, context: msg.extendedTextMessage?.contextInfo?.stanzaId ? { id: msg.extendedTextMessage.contextInfo.stanzaId } : undefined }
  for (const [type, field] of [['image','imageMessage'], ['video','videoMessage'], ['audio','audioMessage'], ['document','documentMessage']] as const) {
    if (msg[field]) return { id: key.id, from: cleanRemote, timestamp, type, [type]: { id: key.id, mime_type: msg[field].mimetype || 'application/octet-stream', caption: msg[field].caption, filename: msg[field].fileName, url: msg[field].url, base64: msg[field].base64 } }
  }
  return { id: key.id, from: cleanRemote, timestamp, type: 'text', text: { body: '[unsupported message]' } }
}

async function handleStatusUpdate(status: { id: string; status: string; timestamp: string; recipient_id: string }) {
  if (!status.id) return
  await supabaseAdmin().from('messages').update({ status: status.status }).eq('message_id', status.id)
  const tsIso = new Date(Number(status.timestamp) * 1000).toISOString()
  const { data: recipient } = await supabaseAdmin().from('broadcast_recipients').select('id, status').eq('whatsapp_message_id', status.id).maybeSingle()
  if (recipient && isValidStatusTransition(recipient.status, status.status)) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent') update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso
    await supabaseAdmin().from('broadcast_recipients').update(update).eq('id', recipient.id)
  }
  const { data: msgRow } = await supabaseAdmin().from('messages').select('conversation_id, conversations(account_id)').eq('message_id', status.id).limit(1).maybeSingle()
  const conv = msgRow?.conversations as { account_id: string } | null
  if (msgRow && conv?.account_id) await dispatchWebhookEvent(supabaseAdmin(), conv.account_id, 'message.status_updated', { whatsapp_message_id: status.id, conversation_id: msgRow.conversation_id, status: status.status })
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent'
  if (current === 'failed') return false
  const ci = ladderLevel(current), ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const
function ladderLevel(s: string): number { return (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s) }

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  const { data: recs } = await supabaseAdmin().from('broadcast_recipients').select('id, status, broadcast_id, broadcasts!inner(account_id)').eq('contact_id', contactId).eq('broadcasts.account_id', accountId).in('status', ['sent', 'delivered', 'read']).order('created_at', { ascending: false }).limit(1)
  if (recs?.[0]) await supabaseAdmin().from('broadcast_recipients').update({ status: 'replied', replied_at: new Date().toISOString() }).eq('id', recs[0].id)
}

async function lookupInternalIdByTransportId(id: string, conversationId: string): Promise<string | null> {
  const { data } = await supabaseAdmin().from('messages').select('id').eq('message_id', id).eq('conversation_id', conversationId).maybeSingle()
  return data?.id ?? null
}

async function handleReaction(message: any, conversationId: string, contactId: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const reaction = message.reaction
  if (!reaction?.message_id) return
  const targetInternalId = await lookupInternalIdByTransportId(reaction.message_id, conversationId)
  if (!targetInternalId) return
  if (!reaction.emoji) {
    await supabaseAdmin().from('message_reactions').delete().eq('message_id', targetInternalId).eq('actor_type', 'customer').eq('actor_id', contactId)
    return
  }
  await supabaseAdmin().from('message_reactions').upsert({ message_id: targetInternalId, conversation_id: conversationId, actor_type: 'customer', actor_id: contactId, emoji: reaction.emoji }, { onConflict: 'message_id,actor_type,actor_id' })
}

async function processMessage(message: any, contact: { profile: { name: string }; wa_id: string }, accountId: string, configOwnerUserId: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const senderPhone = normalizePhone(message.from)
  const contactOutcome = await findOrCreateContact(accountId, configOwnerUserId, senderPhone, contact.profile.name)
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact
  const convResult = await findOrCreateConversation(accountId, configOwnerUserId, contactRecord.id)
  if (!convResult) return
  const conversation = convResult.conversation
  if (convResult.created) await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', { conversation_id: conversation.id, contact_id: contactRecord.id })
  if (message.type === 'reaction') { await handleReaction(message, conversation.id, contactRecord.id); return }
  const { contentText, mediaUrl, interactiveReplyId } = parseMessageContent(message)
  let replyToInternalId: string | null = null
  if (message.context?.id) replyToInternalId = await lookupInternalIdByTransportId(message.context.id, conversation.id)
  const allowed = new Set(['text','image','document','audio','video','location','template','interactive'])
  const contentType = allowed.has(message.type) ? message.type : 'text'
  const { count } = await supabaseAdmin().from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', conversation.id).eq('sender_type', 'customer')
  const isFirstInboundMessage = (count ?? 0) === 0
  const { error: msgError } = await supabaseAdmin().from('messages').insert({ conversation_id: conversation.id, sender_type: 'customer', content_type: contentType, content_text: contentText, media_url: mediaUrl, message_id: message.id, status: 'delivered', created_at: new Date(Number(message.timestamp) * 1000).toISOString(), reply_to_message_id: replyToInternalId || undefined, interactive_reply_id: interactiveReplyId })
  if (msgError) { console.error('Error inserting message:', msgError); return }
  await supabaseAdmin().from('conversations').update({ last_message_text: contentText || `[${message.type}]`, last_message_at: new Date().toISOString(), unread_count: (conversation.unread_count || 0) + 1, updated_at: new Date().toISOString() }).eq('id', conversation.id)
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', { conversation_id: conversation.id, contact_id: contactRecord.id, message_id: message.id, content_text: contentText, content_type: contentType })
  const flowResult = await dispatchInboundToFlows({ accountId, userId: configOwnerUserId, contactId: contactRecord.id, conversationId: conversation.id, message: interactiveReplyId ? { kind: 'interactive_reply', reply_id: interactiveReplyId, reply_title: contentText || interactiveReplyId, meta_message_id: message.id } : { kind: 'text', text: contentText || '', meta_message_id: message.id }, isFirstInboundMessage })
  const triggers: Array<'new_contact_created'|'first_inbound_message'|'new_message_received'|'keyword_match'> = []
  if (contactOutcome.created) triggers.push('new_contact_created')
  if (isFirstInboundMessage) triggers.push('first_inbound_message')
  if (!flowResult?.consumed) { triggers.push('new_message_received'); if (contentText) triggers.push('keyword_match') }
  for (const trigger of triggers) await runAutomationsForTrigger({ accountId, triggerType: trigger, contactId: contactRecord.id, context: { message_text: contentText || undefined, conversation_id: conversation.id } })
  await dispatchInboundToAiReply({ accountId, contactId: contactRecord.id, conversationId: conversation.id, configOwnerUserId })
}

function parseMessageContent(message: any): { contentText: string | null; mediaUrl: string | null; interactiveReplyId: string | null } { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (message.text?.body) return { contentText: message.text.body, mediaUrl: null, interactiveReplyId: null }
  if (message.interactive?.button_reply) return { contentText: message.interactive.button_reply.title, mediaUrl: null, interactiveReplyId: message.interactive.button_reply.id }
  if (message.interactive?.list_reply) return { contentText: message.interactive.list_reply.title, mediaUrl: null, interactiveReplyId: message.interactive.list_reply.id }
  const media = message.image || message.video || message.audio || message.document
  if (media) return { contentText: media.caption || media.filename || `[${message.type}]`, mediaUrl: media.url || (media.base64 ? `data:${media.mime_type};base64,${media.base64}` : null), interactiveReplyId: null }
  return { contentText: `[${message.type}]`, mediaUrl: null, interactiveReplyId: null }
}

async function findOrCreateContact(accountId: string, userId: string, phone: string, name: string) {
  const existing = await findExistingContact(supabaseAdmin(), accountId, phone)
  if (existing) return { contact: existing, created: false }
  const { data, error } = await supabaseAdmin().from('contacts').insert({ account_id: accountId, user_id: userId, phone, name }).select().single()
  if (error) {
    if (isUniqueViolation(error)) {
      const retry = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (retry) return { contact: retry, created: false }
    }
    console.error('Error creating contact:', error); return null
  }
  return { contact: data, created: true }
}

async function findOrCreateConversation(accountId: string, userId: string, contactId: string) {
  const { data: existing } = await supabaseAdmin().from('conversations').select('*').eq('account_id', accountId).eq('contact_id', contactId).maybeSingle()
  if (existing) return { conversation: existing, created: false }
  const { data, error } = await supabaseAdmin().from('conversations').insert({ account_id: accountId, user_id: userId, contact_id: contactId }).select().single()
  if (error) { console.error('Error creating conversation:', error); return null }
  return { conversation: data, created: true }
}