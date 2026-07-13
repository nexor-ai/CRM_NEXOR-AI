/**
 * Evolution API WhatsApp transport.
 *
 * EVOLUTION: this replaces the old official WABA/Cloud transport. There is no
 * WABA, phone_number_id, registration PIN, Meta template approval or 24h API
 * window here. Credentials are: base URL + instance + `apikey` header.
 */
import type { MessageTemplate } from '@/types'

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

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

export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface InteractiveButton { id: string; title: string }
export interface InteractiveListRow { id: string; title: string; description?: string }
export interface InteractiveListSection { title?: string; rows: InteractiveListRow[] }

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

async function evolutionFetch(creds: EvolutionCredentials, path: string, init?: RequestInit): Promise<Response> {
  return fetch(endpoint(creds, path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKeyValue(creds),
      ...(init?.headers ?? {}),
    },
  })
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

export async function setInstanceWebhook(args: EvolutionCredentials & { url: string }): Promise<void> {
  // The `?token=` query param on `args.url` is the primary check. This header
  // is a fallback in case a proxy/CDN in front of Evolution strips query
  // strings — verifyEvolutionWebhookToken() already accepts either.
  const webhookToken = process.env.WHATSAPP_WEBHOOK_TOKEN
  const headers = webhookToken ? { 'x-evolution-webhook-token': webhookToken } : undefined
  const res = await evolutionFetch(args, `/webhook/set/${encodeURIComponent(instanceName(args))}`, {
    method: 'POST',
    body: JSON.stringify({ webhook: { enabled: true, url: args.url, headers, webhookByEvents: false, webhookBase64: true, events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','SEND_MESSAGE','CONNECTION_UPDATE','CONTACTS_UPSERT','QRCODE_UPDATED'] } }),
  })
  if (!res.ok) await throwEvolutionError(res, `Evolution webhook set failed: ${res.status}`)
}

export async function logoutInstance(args: EvolutionCredentials): Promise<void> {
  const res = await evolutionFetch(args, `/instance/logout/${encodeURIComponent(instanceName(args))}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) await throwEvolutionError(res, `Evolution logout failed: ${res.status}`)
}

export async function deleteInstance(args: EvolutionCredentials): Promise<void> {
  const res = await evolutionFetch(args, `/instance/delete/${encodeURIComponent(instanceName(args))}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) await throwEvolutionError(res, `Evolution delete failed: ${res.status}`)
}

export async function sendTextMessage(args: EvolutionCredentials & { to: string; text: string; contextMessageId?: string }): Promise<EvolutionSendResult> {
  const res = await evolutionFetch(args, `/message/sendText/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), text: args.text }) })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendText failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

export async function sendMediaMessage(args: EvolutionCredentials & { to: string; kind: MediaKind; link: string; caption?: string; filename?: string; mimetype?: string; contextMessageId?: string }): Promise<EvolutionSendResult> {
  if (!args.link) throw new Error('sendMediaMessage requires a link.')
  if (args.kind === 'audio') {
    const res = await evolutionFetch(args, `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), audio: args.link }) })
    if (!res.ok) await throwEvolutionError(res, `Evolution sendWhatsAppAudio failed: ${res.status}`)
    return { messageId: extractMessageId(await res.json()) }
  }
  const res = await evolutionFetch(args, `/message/sendMedia/${encodeURIComponent(instanceName(args))}`, { method: 'POST', body: JSON.stringify({ number: numberForEvolution(args.to), mediatype: args.kind, mimetype: args.mimetype ?? 'application/octet-stream', media: args.link, caption: args.caption, fileName: args.filename }) })
  if (!res.ok) await throwEvolutionError(res, `Evolution sendMedia failed: ${res.status}`)
  return { messageId: extractMessageId(await res.json()) }
}

function renderTemplateText(templateName: string, template?: MessageTemplate, params?: string[]): string {
  let text = template?.body_text || templateName
  ;(params ?? []).forEach((v, i) => { text = text.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v) })
  if (template?.footer_text) text += `\n\n${template.footer_text}`
  return text
}

export async function sendTemplateMessage(args: EvolutionCredentials & { to: string; templateName: string; language?: string; params?: string[]; template?: MessageTemplate; messageParams?: { body?: string[] }; contextMessageId?: string }): Promise<EvolutionSendResult> {
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

export async function sendInteractiveButtons(args: EvolutionCredentials & { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: InteractiveButton[]; contextMessageId?: string }): Promise<EvolutionSendResult> {
  // EVOLUTION: Baileys button support varies by build; text fallback is deterministic and flow-safe.
  return sendTextMessage({ ...args, text: fallbackButtonsText(args.bodyText, args.buttons, args.headerText, args.footerText) })
}

export async function sendInteractiveList(args: EvolutionCredentials & { to: string; bodyText: string; buttonLabel: string; headerText?: string; footerText?: string; sections: InteractiveListSection[]; contextMessageId?: string }): Promise<EvolutionSendResult> {
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
