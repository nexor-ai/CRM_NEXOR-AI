import { chatMediaPathFromReference } from '@/lib/whatsapp/chat-media';
import { validateTranscriptionMedia } from './policy';

type Input = {
  accountId: string;
  messageId: string;
  conversationId: string;
  whatsappConfigId: string | null;
  departmentId: string | null;
  mediaReference: string | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
  durationSeconds: number | null | undefined;
};

export type TranscriptionJobInsert = {
  account_id: string;
  message_id: string;
  conversation_id: string;
  whatsapp_config_id: string | null;
  department_id: string | null;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number;
  status: 'pending';
};

export function buildInboundTranscriptionJob(input: Input): TranscriptionJobInsert | null {
  const storageKey = input.mediaReference
    ? chatMediaPathFromReference(input.mediaReference)
    : null;
  const mimeType = String(input.mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const sizeBytes = Number(input.sizeBytes);
  const durationSeconds = Number(input.durationSeconds);

  if (!storageKey || !Number.isFinite(sizeBytes) || !Number.isFinite(durationSeconds)) {
    return null;
  }
  const validation = validateTranscriptionMedia({ mime: mimeType, sizeBytes, durationSeconds });
  if (!validation.ok) return null;

  return {
    account_id: input.accountId,
    message_id: input.messageId,
    conversation_id: input.conversationId,
    whatsapp_config_id: input.whatsappConfigId,
    department_id: input.departmentId,
    storage_key: storageKey,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    duration_seconds: durationSeconds,
    status: 'pending',
  };
}
