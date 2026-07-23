/**
 * Evolution API WhatsApp transport.
 *
 * EVOLUTION: this replaces the old official WABA/Cloud transport. There is no
 * WABA, phone_number_id, registration PIN, Meta template approval or 24h API
 * window here. Credentials are: base URL + instance + `apikey` header.
 */
import type { MessageTemplate } from '@/types'
import { isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'
import { resolveSafeEvolutionTarget } from './evolution-url-safety'
import { evolutionWebhookTokenForScope } from './webhook-signature'
import {
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from './evolution-contracts'

export {
  INTERACTIVE_LIMITS,
  type InteractiveButton,
  type InteractiveListRow,
  type InteractiveListSection,
  type MediaKind,
} from './evolution-contracts'

export interface EvolutionCredentials {
  baseUrl?: string
  instance?: string
  instanceName?: string
  evolutionInstance?: string
  apiKey?: string
  /** Legacy Meta args accepted temporarily to preserve internal signatures during migration. */
  phoneNumberId?: string
  accessToken?: string
}

export interface EvolutionSendResult { messageId: string }
export interface EvolutionConnectionState { state: 'open' | 'connecting' | 'close' | string }
export type EvolutionPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused'

export interface EvolutionWebhookConfig {
  enabled?: boolean
  url?: string
  headers?: unknown
  byEvents?: boolean
  base64?: boolean
  events?: string[]
}

export interface EvolutionHealth {
  healthy: boolean
  instanceOpen: boolean
  webhookOperational: boolean
  connectionState: string
  checks: {
    webhookEnabled: boolean
    webhookUrl: boolean
    webhookEvents: boolean
    webhookBase64: boolean
  }
}

export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'SEND_MESSAGE',
  'CONNECTION_UPDATE',
  'CONTACTS_UPSERT',
  'QRCODE_UPDATED',
] as const

export interface EvolutionMessageKey { id: string; remoteJid: string; fromMe: boolean; participant?: string }
export interface EvolutionLastMessage { key: EvolutionMessageKey; messageTimestamp?: number }

function cleanBaseUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || process.env.EVOLUTION_API_URL || 'http://localhost:8080').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Evolution base URL must start with http:// or https://')
  return trimmed
}

function instanceName(creds: EvolutionCredentials): string {
  return creds.instance || creds.instanceName || creds.evolutionInstance || creds.phoneNumberId || 'default'
}

function apiKeyValue(creds: EvolutionCredentials): string {
  return creds.apiKey || creds.accessToken || process.env.EVOLUTION_API_KEY || ''
}

function endpoint(creds: EvolutionCredentials, path: string): string {
  return `${cleanBaseUrl(creds.baseUrl)}${path}`
}

async function evolutionFetch(
  creds: EvolutionCredentials,
  path: string,
  init?: RequestInit,
  options: { retrySafe?: boolean } = {}
): Promise<Response> {
  const requestedBaseUrl = cleanBaseUrl(creds.baseUrl)
  const safeTarget = process.env.VITEST
    ? { origin: requestedBaseUrl, addresses: ['127.0.0.1'] }
    : await resolveSafeEvolutionTarget(requestedBaseUrl)
  const method = (init?.method || 'GET').toUpperCase()
  const maxAttempts = method === 'GET' || options.retrySafe ? 2 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeoutMs = Number(process.env.EVOLUTION_API_TIMEOUT_MS || 15_000)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abortFromCaller = () => controller.abort()
    init?.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      const requestedFamily = lookupOptions.family || 0
      const candidates = safeTarget.addresses
        .map((address) => ({ address, family: isIP(address) }))
        .filter((candidate) => candidate.family === 4 || candidate.family === 6)
        .filter((candidate) => !requestedFamily || candidate.family === requestedFamily)
      if (candidates.length === 0) {
        callback(Object.assign(new Error('No validated Evolution address matches the requested family'), { code: 'ENOTFOUND' }), '', 0)
        return
      }
      if (lookupOptions.all) callback(null, candidates)
      else callback(null, candidates[0].address, candidates[0].family)
    }
    const dispatcher = new Agent({
      connect: { lookup },
      maxResponseSize: 10 * 1024 * 1024,
    })
    try {
      const liveResponse = await fetch(endpoint({ ...creds, baseUrl: safeTarget.origin }, path), {
        ...init,
        redirect: 'error',
        dispatcher,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          apikey: apiKeyValue(creds),
          ...(init?.headers ?? {}),
        },
      } as RequestInit & { dispatcher: Agent })
      if (process.env.VITEST) {
        if (attempt < maxAttempts && (liveResponse.status === 429 || liveResponse.status >= 500)) continue
        return liveResponse
      }
      const response = new Response(await liveResponse.arrayBuffer(), {
        status: liveResponse.status,
        statusText: liveResponse.statusText,
        headers: liveResponse.headers,
      })
      if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) continue
      return response
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) throw error
    } finally {
      await dispatcher.close()
      clearTimeout(timer)
      init?.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Evolution request failed')
}

export async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = await response.json() as { message?: unknown; error?: unknown; response?: { message?: unknown } }
    // `response.message` carries the specific reason (e.g. "name already in
    // use"); `error`/`message` at the top level are often just the generic
    // HTTP reason phrase ("Forbidden") and would mask it if checked first.
    const raw = data.response?.message ?? data.message ?? data.error
    if (Array.isArray(raw)) message = raw.join('; ')
    else if (raw) message = String(raw)
  } catch { /* keep fallback */ }
  throw new Error(message)
}

function extractMessageId(data: unknown): string {
  const d = data as Record<string, unknown>
  const key = d.key as Record<string, unknown> | undefined
  const message = d.message as Record<string, unknown> | undefined
  const messageKey = message?.key as Record<string, unknown> | undefined
  return String(key?.id ?? messageKey?.id ?? d.id ?? d.messageId ?? crypto.randomUUID())
}

function numberForEvolution(to: string): string { return to.replace(/\D/g, '') }

type EvolutionReplyContext = {
  contextMessageId?: string
  contextFromMe?: boolean
}

function quotedPayload(to: string, context: EvolutionReplyContext) {
  if (!context.contextMessageId) return {}
  const number = numberForEvolution(to)
  return {
    quoted: {
      key: {
        remoteJid: `${number}@s.whatsapp.net`,
        fromMe: context.contextFromMe ?? false,
        id: context.contextMessageId,
      },
    },
  }
}

export async function createInstance(args: EvolutionCredentials): Promise<{ qrcode?: { base64?: string; code?: string; pairingCode?: string } }> {
  const res = await evolutionFetch(args, '/instance/create', {
    method: 'POST',
    body: JSON.stringify({ instanceName: instanceName(args), integration: 'WHATSAPP-BAILEYS', qrcode: true }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution instance create failed: ${res.status}`)
  return res.json()
}

export async function connectInstance(args: EvolutionCredentials): Promise<{ base64?: string; code?: string; pairingCode?: string }> {
  const res = await evolutionFetch(args, `/instance/connect/${encodeURIComponent(instanceName(args))}`)
  if (!res.ok) await throwEvolutionError(res, `Evolution instance connect failed: ${res.status}`)
  const data = await res.json() as { qrcode?: { base64?: string; code?: string; pairingCode?: string }; base64?: string; code?: string; pairingCode?: string }
  return data.qrcode ?? data
}

export async function getConnectionState(args: EvolutionCredentials): Promise<EvolutionConnectionState> {
  const res = await evolutionFetch(args, `/instance/connectionState/${encodeURIComponent(instanceName(args))}`)
  if (!res.ok) await throwEvolutionError(res, `Evolution connection state failed: ${res.status}`)
  const data = await res.json() as { instance?: { state?: string; connectionStatus?: string }; state?: string }
  return { state: data.instance?.state ?? data.state ?? data.instance?.connectionStatus ?? 'close' }
}

export async function getInstanceWebhook(args: EvolutionCredentials): Promise<EvolutionWebhookConfig> {
  const res = await evolutionFetch(args, `/webhook/find/${encodeURIComponent(instanceName(args))}`)
  if (!res.ok) await throwEvolutionError(res, `Evolution webhook lookup failed: ${res.status}`)
  const data = await res.json() as EvolutionWebhookConfig & { webhook?: EvolutionWebhookConfig }
  return data.webhook ?? data
}

export async function checkEvolutionHealth(args: EvolutionCredentials & {
  expectedWebhookUrl: string
  expectedEvents: string[]
  requireBase64?: boolean
}): Promise<EvolutionHealth> {
  const [connection, webhook] = await Promise.all([
    getConnectionState(args),
    getInstanceWebhook(args),
  ])
  const actualEvents = new Set((webhook.events ?? []).map(event => event.toUpperCase()))
  const checks = {
    webhookEnabled: webhook.enabled === true,
    webhookUrl: webhook.url === args.expectedWebhookUrl,
    webhookEvents: args.expectedEvents.every(event => actualEvents.has(event.toUpperCase())),
    webhookBase64: !args.requireBase64 || webhook.base64 === true,
  }
  const instanceOpen = connection.state === 'open'
  const webhookOperational = Object.values(checks).every(Boolean)
  return {
    healthy: instanceOpen && webhookOperational,
    instanceOpen,
    webhookOperational,
    connectionState: connection.state,
    checks,
  }
}

export async function markMessagesAsRead(args: EvolutionCredentials & {
  messages: Array<{ id: string; remoteJid: string; fromMe: boolean }>
}): Promise<void> {
  if (args.messages.length === 0) return
  const res = await evolutionFetch(args, `/chat/markMessageAsRead/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST',
    body: JSON.stringify({ readMessages: args.messages }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution read receipt failed: ${res.status}`)
}

export async function sendChatPresence(args: EvolutionCredentials & {
  to: string
  presence: EvolutionPresence
  delay?: number
}): Promise<void> {
  const res = await evolutionFetch(args, `/chat/sendPresence/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST',
    body: JSON.stringify({
      number: numberForEvolution(args.to),
      presence: args.presence,
      delay: args.delay ?? 0,
    }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution presence failed: ${res.status}`)
}

export async function findMessages(args: EvolutionCredentials & {
  remoteJid?: string
  where?: Record<string, unknown>
  limit?: number
  page?: number
}): Promise<unknown> {
  const key = args.where ?? (args.remoteJid ? { remoteJid: args.remoteJid } : {})
  const res = await evolutionFetch(args, `/chat/findMessages/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST',
    body: JSON.stringify({
      where: { key },
      offset: Math.max(1, Math.min(args.limit ?? 50, 200)),
      page: Math.max(1, args.page ?? 1),
    }),
  }, { retrySafe: true })
  if (!res.ok) await throwEvolutionError(res, `Evolution message reconciliation failed: ${res.status}`)
  return res.json()
}

export async function setInstanceWebhook(args: EvolutionCredentials & {
  url: string
  webhookScopeId: string
}): Promise<void> {
  // Keep the shared secret out of callback URLs, access logs, analytics and
  // browser history. Evolution sends this custom header with each callback.
  const webhookToken = evolutionWebhookTokenForScope(args.webhookScopeId)
  const headers = webhookToken ? {
    'x-evolution-webhook-token': webhookToken,
    'x-wacrm-webhook-scope': args.webhookScopeId,
  } : undefined
  const res = await evolutionFetch(args, `/webhook/set/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST',
    body: JSON.stringify({ webhook: { enabled: true, url: args.url, headers, byEvents: false, base64: true, events: [...EVOLUTION_WEBHOOK_EVENTS] } }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution webhook set failed: ${res.status}`)
}

export async function fetchInstanceWebhook(args: EvolutionCredentials): Promise<EvolutionWebhookConfig> {
  return getInstanceWebhook(args)
}

export async function logoutInstance(args: EvolutionCredentials): Promise<void> {
  const res = await evolutionFetch(args, `/instance/logout/${encodeURIComponent(instanceName(args))}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) await throwEvolutionError(res, `Evolution logout failed: ${res.status}`)
}

export async function deleteInstance(args: EvolutionCredentials): Promise<void> {
  const res = await evolutionFetch(args, `/instance/delete/${encodeURIComponent(instanceName(args))}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) await throwEvolutionError(res, `Evolution delete failed: ${res.status}`)
}

export async function sendTextMessage(args: EvolutionCredentials & { to: string; text: string } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  const res = await evolutionFetch(args, `/message/sendText/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), text: args.text, ...quotedPayload(args.to, args) }) })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendText failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export async function sendMediaMessage(args: EvolutionCredentials & { to: string; kind: MediaKind; link: string; caption?: string; filename?: string; mimetype?: string } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  if (!args.link) throw new Error('sendMediaMessage requires a link.')
  if (args.kind === 'audio') {
    const res = await evolutionFetch(args, `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), audio: args.link, ...quotedPayload(args.to, args) }) })
    if (!res.ok) await throwEvolutionError(res, `Evolution sendWhatsAppAudio failed: ${res.status}`)
    return { messageId: extractMessageId(await res.json()) }
  }
  const res = await evolutionFetch(args, `/message/sendMedia/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), mediatype: args.kind, mimetype: args.mimetype ?? 'application/octet-stream', media: args.link, caption: args.caption, fileName: args.filename, ...quotedPayload(args.to, args) }) })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendMedia failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

function renderTemplateText(templateName: string, template?: MessageTemplate, params?: string[]): string {
  let text = template?.body_text || templateName
  ;(params ?? []).forEach((v, i) => { text = text.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v) })
  if (template?.footer_text) text += `\n\n${template.footer_text}`
  return text
}

export async function sendTemplateMessage(args: EvolutionCredentials & { to: string; templateName: string; language?: string; params?: string[]; template?: MessageTemplate; messageParams?: { body?: string[] } } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  // EVOLUTION: templates are local presets only; no remote approval/submission.
  const bodyParams = args.messageParams?.body ?? args.params ?? []
  const text = renderTemplateText(args.templateName, args.template, bodyParams)
  if (args.template?.header_type && args.template.header_type !== 'text' && args.template.header_media_url) {
    return sendMediaMessage({ ...args, kind: args.template.header_type, link: args.template.header_media_url, caption: text })
  }
  return sendTextMessage({ ...args, text })
}

function fallbackButtonsText(bodyText: string, buttons: InteractiveButton[], headerText?: string, footerText?: string): string {
  return [headerText, bodyText, buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n'), footerText].filter(Boolean).join('\n\n')
}

export async function sendInteractiveButtons(args: EvolutionCredentials & { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: InteractiveButton[]; native?: boolean } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  // Evolution 2.3.7 exposes sendButtons, but Baileys/client support varies.
  // Native use is explicit; deterministic text remains the safe default.
  if (args.native) {
    const res = await evolutionFetch(args, `/message/sendButtons/${encodeURIComponent(instanceName(args))}`, {
      method: 'POST',
      body: JSON.stringify({
        number: numberForEvolution(args.to),
        title: args.headerText ?? '',
        description: args.bodyText,
        footer: args.footerText,
        buttons: args.buttons.map(button => ({ type: 'reply', id: button.id, displayText: button.title })),
        ...quotedPayload(args.to, args),
      }),
    })
    if (!res.ok) await throwEvolutionError(res, `Evolution sendButtons failed: ${res.status}`)
    return { messageId: extractMessageId(await res.json()) }
  }
  return sendTextMessage({ ...args, text: fallbackButtonsText(args.bodyText, args.buttons, args.headerText, args.footerText) })
}

export async function sendInteractiveList(args: EvolutionCredentials & { to: string; bodyText: string; buttonLabel: string; headerText?: string; footerText?: string; sections: InteractiveListSection[]; native?: boolean } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  if (args.native) {
    const res = await evolutionFetch(args, `/message/sendList/${encodeURIComponent(instanceName(args))}`, {
      method: 'POST',
      body: JSON.stringify({
        number: numberForEvolution(args.to),
        title: args.headerText ?? '',
        description: args.bodyText,
        footerText: args.footerText,
        buttonText: args.buttonLabel,
        sections: args.sections.map(section => ({
          title: section.title ?? '',
          rows: section.rows.map(row => ({ rowId: row.id, title: row.title, description: row.description ?? '' })),
        })),
        ...quotedPayload(args.to, args),
      }),
    })
    if (!res.ok) await throwEvolutionError(res, `Evolution sendList failed: ${res.status}`)
    return { messageId: extractMessageId(await res.json()) }
  }
  const rows = args.sections.flatMap(s => s.rows)
  return sendTextMessage({ ...args, text: fallbackButtonsText(args.bodyText, rows, args.headerText, args.footerText) })
}

export async function sendReactionMessage(args: EvolutionCredentials & { to: string; targetMessageId: string; emoji: string; remoteJid?: string; fromMe?: boolean }): Promise<EvolutionSendResult> {
  const remoteJid = args.remoteJid ?? `${numberForEvolution(args.to)}@s.whatsapp.net`
  const res = await evolutionFetch(args, `/message/sendReaction/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ key: { remoteJid, fromMe: args.fromMe ?? false, id: args.targetMessageId }, reaction: args.emoji }) })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendReaction failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export async function getBase64FromMediaMessage(args: EvolutionCredentials & { message: unknown }): Promise<{ base64: string; mimetype?: string }> {
  const res = await evolutionFetch(args, `/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ message: args.message }) })
  if (!res.ok) await throwEvolutionError(res, `Evolution media download failed: ${res.status}`)
  return res.json()
}

export async function sendPresence(args: EvolutionCredentials & { to: string; presence: EvolutionPresence; delay?: number }): Promise<void> {
  return sendChatPresence({
    ...args,
    delay: Math.max(0, Math.min(args.delay ?? 1_000, 10_000)),
  })
}

export async function validateWhatsAppNumbers(args: EvolutionCredentials & { numbers: string[] }): Promise<unknown> {
  const numbers = [...new Set(args.numbers.map(numberForEvolution).filter(Boolean))]
  const res = await evolutionFetch(args, `/chat/whatsappNumbers/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ numbers }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution whatsappNumbers failed: ${res.status}`)
  return res.json()
}

export async function fetchProfilePicture(args: EvolutionCredentials & { to: string }): Promise<unknown> {
  const res = await evolutionFetch(args, `/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to) }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution fetchProfilePictureUrl failed: ${res.status}`)
  return res.json()
}

export async function fetchProfile(args: EvolutionCredentials & { to: string }): Promise<unknown> {
  const res = await evolutionFetch(args, `/chat/fetchProfile/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to) }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution fetchProfile failed: ${res.status}`)
  return res.json()
}

export async function archiveChat(args: EvolutionCredentials & { remoteJid: string; archive: boolean; lastMessage?: EvolutionLastMessage }): Promise<void> {
  const res = await evolutionFetch(args, `/chat/archiveChat/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ chat: args.remoteJid, archive: args.archive, ...(args.lastMessage ? { lastMessage: args.lastMessage } : {}) }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution archiveChat failed: ${res.status}`)
}

export async function markChatUnread(args: EvolutionCredentials & { remoteJid: string; lastMessage: EvolutionLastMessage }): Promise<void> {
  const res = await evolutionFetch(args, `/chat/markChatUnread/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ chat: args.remoteJid, lastMessage: args.lastMessage }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution markChatUnread failed: ${res.status}`)
}

export async function sendLocationMessage(args: EvolutionCredentials & { to: string; latitude: number; longitude: number; name?: string; address?: string } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  const res = await evolutionFetch(args, `/message/sendLocation/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST',
    body: JSON.stringify({ number: numberForEvolution(args.to), latitude: args.latitude, longitude: args.longitude, name: args.name, address: args.address, ...quotedPayload(args.to, args) }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendLocation failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export interface EvolutionContactCard {
  fullName: string
  phoneNumber: string
  wuid?: string
  organization?: string
  email?: string
  url?: string
}

export async function sendContactMessage(args: EvolutionCredentials & { to: string; contacts: EvolutionContactCard[] } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  const contact = args.contacts.map((item) => ({ ...item, wuid: item.wuid ?? `${numberForEvolution(item.phoneNumber)}@s.whatsapp.net` }))
  const res = await evolutionFetch(args, `/message/sendContact/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), contact, ...quotedPayload(args.to, args) }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendContact failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export async function sendStickerMessage(args: EvolutionCredentials & { to: string; sticker: string } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  const res = await evolutionFetch(args, `/message/sendSticker/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), sticker: args.sticker, ...quotedPayload(args.to, args) }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendSticker failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export async function sendPollMessage(args: EvolutionCredentials & { to: string; name: string; selectableCount: number; values: string[] } & EvolutionReplyContext): Promise<EvolutionSendResult> {
  const res = await evolutionFetch(args, `/message/sendPoll/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({
      number: numberForEvolution(args.to), name: args.name,
      selectableCount: args.selectableCount, values: args.values,
      ...quotedPayload(args.to, args),
    }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendPoll failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export async function editMessage(args: EvolutionCredentials & { to: string; key: EvolutionMessageKey; text: string }): Promise<void> {
  const res = await evolutionFetch(args, `/chat/updateMessage/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), key: args.key, text: args.text }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution updateMessage failed: ${res.status}`)
}

export async function deleteMessageForEveryone(args: EvolutionCredentials & { key: EvolutionMessageKey }): Promise<void> {
  const res = await evolutionFetch(args, `/chat/deleteMessageForEveryone/${encodeURIComponent(instanceName(args))}`, {
    method: 'DELETE', body: JSON.stringify(args.key),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution deleteMessageForEveryone failed: ${res.status}`)
}

export async function uploadResumableMedia(..._args: unknown[]): Promise<{ handle: string }> {
  // EVOLUTION: no remote upload session for template headers; local presets use public URL/base64 at send time.
  throw new Error('Evolution API does not support remote template media-handle uploads; use header_media_url/local media URL.')
}

export async function submitMessageTemplate(..._args: unknown[]): Promise<{ id: string; status: string }> {
  // EVOLUTION: no external template submission/approval.
  return { id: `local_${Date.now()}`, status: 'APPROVED' }
}

export async function editMessageTemplate(..._args: unknown[]): Promise<{ success: boolean }> { return { success: true } }
export async function deleteMessageTemplate(..._args: unknown[]): Promise<void> { /* EVOLUTION: local DB delete only. */ }

export async function registerPhoneNumber(..._args: unknown[]): Promise<{ success: boolean }> {
  // EVOLUTION: no PIN-based phone registration exists. QR pairing owns connectivity.
  return { success: true }
}

export async function subscribeWabaToApp(..._args: unknown[]): Promise<{ success: boolean }> {
  // EVOLUTION: webhooks are per instance via setInstanceWebhook.
  return { success: true }
}

export async function getSubscribedApps(..._args: unknown[]): Promise<Array<Record<string, any>>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  // EVOLUTION: no WABA subscribed apps concept.
  return []
}

export async function getMediaUrl(_args: unknown): Promise<{ url: string; mime_type?: string }> {
  throw new Error('Evolution webhooks carry media URL/base64 directly; Graph media lookup is not available.')
}

export async function downloadMedia(_args: unknown): Promise<Blob> {
  throw new Error('Evolution webhooks carry media URL/base64 directly; Graph media download is not available.')
}
