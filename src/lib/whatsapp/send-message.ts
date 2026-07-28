// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Evolution (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of WhatsApp transport plumbing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendContactMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendLocationMessage,
  sendPollMessage,
  sendStickerMessage,
  INTERACTIVE_LIMITS,
  type MediaKind,
} from '@/lib/whatsapp/evolution-api';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  chatMediaPathFromReference,
  isChatMediaPathForAccount,
} from '@/lib/whatsapp/chat-media';
import {
  resolveActiveWhatsAppConfig,
  whatsappTrace,
} from '@/lib/whatsapp/resolve-config';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  ...MEDIA_KINDS,
  'location',
  'contact',
  'sticker',
  'poll',
  'interactive_buttons',
  'interactive_list',
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  replyToMessageId?: string | null;
  contentData?: Record<string, unknown> | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Evolution/Baileys `key.id` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  contentData?: Record<string, unknown> | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, contentData } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  if (
    messageType === 'location' &&
    (typeof contentData?.latitude !== 'number' ||
      typeof contentData?.longitude !== 'number' ||
      !Number.isFinite(contentData.latitude) ||
      !Number.isFinite(contentData.longitude) ||
      contentData.latitude < -90 ||
      contentData.latitude > 90 ||
      contentData.longitude < -180 ||
      contentData.longitude > 180 ||
      typeof contentData.name !== 'string' ||
      !contentData.name.trim() ||
      typeof contentData.address !== 'string' ||
      !contentData.address.trim())
  ) {
    throw new SendMessageError(
      'bad_request',
      'valid latitude, longitude, name and address are required for location messages',
      400
    );
  }
  if (
    messageType === 'contact' &&
    (!Array.isArray(contentData?.contacts) ||
      contentData.contacts.length === 0 ||
      contentData.contacts.some((contact) => {
        if (!contact || typeof contact !== 'object') return true;
        const row = contact as Record<string, unknown>;
        return (
          typeof row.fullName !== 'string' ||
          !row.fullName.trim() ||
          typeof row.phoneNumber !== 'string' ||
          row.phoneNumber.replace(/\D/g, '').length < 10
        );
      }))
  ) {
    throw new SendMessageError(
      'bad_request',
      'contacts are required for contact messages',
      400
    );
  }
  if (messageType === 'sticker' && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      'media_url is required for sticker messages',
      400
    );
  }
  if (
    messageType === 'poll' &&
    (typeof contentData?.name !== 'string' ||
      !contentData.name.trim() ||
      !Array.isArray(contentData?.values) ||
      contentData.values.length < 2 ||
      contentData.values.length > 10 ||
      contentData.values.some((value) => typeof value !== 'string' || !value.trim()) ||
      new Set(contentData.values).size !== contentData.values.length ||
      typeof contentData.selectableCount !== 'number' ||
      !Number.isInteger(contentData.selectableCount) ||
      contentData.selectableCount < 0 ||
      contentData.selectableCount > 10)
  ) {
    throw new SendMessageError(
      'bad_request',
      'name and values are required for poll messages',
      400
    );
  }
  if (messageType === 'interactive_buttons') {
    const buttons = contentData?.buttons;
    if (
      !contentText ||
      !Array.isArray(buttons) ||
      buttons.length === 0 ||
      buttons.length > INTERACTIVE_LIMITS.maxButtons
    ) {
      throw new SendMessageError(
        'bad_request',
        `interactive_buttons requires text and 1 to ${INTERACTIVE_LIMITS.maxButtons} buttons`,
        400
      );
    }
    const invalidButton = buttons.some((button) => {
      if (!button || typeof button !== 'object') return true;
      const row = button as Record<string, unknown>;
      return (
        typeof row.id !== 'string' ||
        !row.id.trim() ||
        typeof row.title !== 'string' ||
        !row.title.trim() ||
        row.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength
      );
    });
    if (invalidButton) {
      throw new SendMessageError(
        'bad_request',
        `button titles must contain 1 to ${INTERACTIVE_LIMITS.buttonTitleMaxLength} characters`,
        400
      );
    }
  }
  if (messageType === 'interactive_list') {
    const sections = contentData?.sections;
    const rows = Array.isArray(sections)
      ? sections.flatMap((section) => {
          if (!section || typeof section !== 'object') return [];
          const sectionRows = (section as Record<string, unknown>).rows;
          return Array.isArray(sectionRows) ? sectionRows : [];
        })
      : [];
    if (
      !contentText ||
      !Array.isArray(sections) ||
      sections.length === 0 ||
      sections.length > INTERACTIVE_LIMITS.maxListSections ||
      rows.length === 0 ||
      rows.length > INTERACTIVE_LIMITS.maxListRowsTotal
    ) {
      throw new SendMessageError(
        'bad_request',
        `interactive_list requires text and 1 to ${INTERACTIVE_LIMITS.maxListRowsTotal} rows`,
        400
      );
    }
    const invalidRow = rows.some((row) => {
      if (!row || typeof row !== 'object') return true;
      const item = row as Record<string, unknown>;
      return (
        typeof item.id !== 'string' ||
        !item.id.trim() ||
        typeof item.title !== 'string' ||
        !item.title.trim() ||
        item.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength ||
        (typeof item.description === 'string' &&
          item.description.length >
            INTERACTIVE_LIMITS.listRowDescriptionMaxLength)
      );
    });
    if (invalidRow) {
      throw new SendMessageError(
        'bad_request',
        `list row titles must contain 1 to ${INTERACTIVE_LIMITS.listRowTitleMaxLength} characters`,
        400
      );
    }
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    replyToMessageId,
    contentData,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    contentData,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400
    );
  }

  // Prefer the configuration that received this conversation. Legacy rows
  // without a stamp fall back to the account's active configuration.
  const config = await resolveActiveWhatsAppConfig(db, accountId, {
    preferConfigId: conversation.whatsapp_config_id ?? null,
    departmentId: conversation.department_id ?? null,
  });

  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  if (
    !config.evolution_base_url ||
    !config.evolution_instance ||
    !config.evolution_api_key
  ) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'Evolution API is not configured for this account.',
      400
    );
  }
  const apiKey = decrypt(config.evolution_api_key);
  const transport = {
    baseUrl: config.evolution_base_url,
    instance: config.evolution_instance,
    apiKey,
  };
  const trace = whatsappTrace(config);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.evolution_api_key)) {
    void db
      .from('whatsapp_config')
      .update({ evolution_api_key: encrypt(apiKey) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error)
          console.warn(
            '[send-message] evolution_api_key GCM upgrade failed:',
            error.message
          );
      });
  }

  // Resolve the reply target to its WhatsApp transport message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  let contextFromMe: boolean | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id, sender_type')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no WhatsApp transport message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
      contextFromMe = parent.sender_type !== 'customer';
    }
  }

  // Template rows are local presets, not remote provider templates. Resolve them
  // fail-closed: a missing/inactive/incompatible preset must never reach
  // sendTemplateMessage, whose low-level compatibility fallback can render the
  // technical template name as text. Interactive-message fallbacks are a
  // separate, explicitly approved contract and remain unchanged.
  let templateRow: MessageTemplate | null = null;
  if (messageType === 'template' && templateName) {
    const requestedLanguage = templateLanguage || 'en_US';
    const { data, error } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', requestedLanguage)
      .maybeSingle();
    if (error) {
      throw new SendMessageError(
        'template_lookup_failed',
        'Could not verify the local template preset',
        500
      );
    }
    if (!data) {
      throw new SendMessageError(
        'template_not_found',
        'Template preset not found',
        404
      );
    }
    if (!isMessageTemplate(data)) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "review the local preset" in Settings to repair it.',
        500
      );
    }
    if (data.name !== templateName || data.language !== requestedLanguage) {
      throw new SendMessageError(
        'template_incompatible',
        'Template preset does not match the requested name and language',
        409
      );
    }
    if (data.status !== 'APPROVED') {
      throw new SendMessageError(
        'template_inactive',
        'Template preset is not active',
        409
      );
    }
    templateRow = data;
  }

  let transportMediaUrl = mediaUrl || null;
  if (transportMediaUrl) {
    const privatePath = chatMediaPathFromReference(transportMediaUrl);
    if (privatePath) {
      if (!isChatMediaPathForAccount(privatePath, accountId)) {
        throw new SendMessageError('not_found', 'Media not found', 404);
      }
      const { data, error } = await db.storage
        .from('chat-media')
        .createSignedUrl(privatePath, 60);
      if (error || !data?.signedUrl) {
        throw new SendMessageError(
          'media_unavailable',
          'Private media could not be prepared for delivery',
          502
        );
      }
      transportMediaUrl = data.signedUrl;
    }
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        ...transport,
        to: phone,
        templateName: templateName!,
        language: templateLanguage || 'en_US',
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        ...transport,
        to: phone,
        kind: messageType as MediaKind,
        link: transportMediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (messageType === 'location') {
      const result = await sendLocationMessage({
        ...transport,
        to: phone,
        latitude: contentData!.latitude as number,
        longitude: contentData!.longitude as number,
        name:
          typeof contentData!.name === 'string' ? contentData!.name : undefined,
        address:
          typeof contentData!.address === 'string'
            ? contentData!.address
            : undefined,
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (messageType === 'contact') {
      const result = await sendContactMessage({
        ...transport,
        to: phone,
        contacts: contentData!.contacts as Array<{
          fullName: string;
          phoneNumber: string;
          organization?: string;
          email?: string;
          url?: string;
        }>,
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (messageType === 'sticker') {
      const result = await sendStickerMessage({
        ...transport,
        to: phone,
        sticker: mediaUrl!,
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (messageType === 'poll') {
      const result = await sendPollMessage({
        ...transport,
        to: phone,
        name: contentData!.name as string,
        selectableCount:
          typeof contentData!.selectableCount === 'number'
            ? contentData!.selectableCount
            : 1,
        values: contentData!.values as string[],
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (messageType === 'interactive_buttons') {
      const result = await sendInteractiveButtons({
        ...transport,
        to: phone,
        bodyText: contentText || '',
        headerText:
          typeof contentData!.headerText === 'string'
            ? contentData!.headerText
            : undefined,
        footerText:
          typeof contentData!.footerText === 'string'
            ? contentData!.footerText
            : undefined,
        buttons: contentData!.buttons as Array<{ id: string; title: string }>,
        native: contentData!.native === true,
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    if (messageType === 'interactive_list') {
      const result = await sendInteractiveList({
        ...transport,
        to: phone,
        bodyText: contentText || '',
        buttonLabel: String(contentData!.buttonLabel || 'Abrir'),
        headerText:
          typeof contentData!.headerText === 'string'
            ? contentData!.headerText
            : undefined,
        footerText:
          typeof contentData!.footerText === 'string'
            ? contentData!.footerText
            : undefined,
        sections: contentData!.sections as Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>;
        }>,
        native: contentData!.native === true,
        contextMessageId,
        contextFromMe,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      ...transport,
      to: phone,
      text: contentText!,
      contextMessageId,
      contextFromMe,
    });
    return result.messageId;
  };

  // Send via Evolution — retry across phone-number variants if the gateway rejects
  // an invalid/inexistent WhatsApp number; persist a working variant
  // back to the contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants = phoneVariants(sanitizedPhone);
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by Evolution, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Evolution API error';
    console.error(
      '[send-message] Evolution send failed for all variants:',
      message
    );
    throw new SendMessageError(
      'evolution_error',
      `Evolution API error: ${message}`,
      502
    );
  }

  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType.startsWith('interactive_')
        ? 'interactive'
        : messageType,
      content_text: contentText || null,
      media_url: mediaUrl || null,
      content_data: contentData || null,
      template_name: templateName || null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
      ...trace,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Evolution but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...trace,
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
