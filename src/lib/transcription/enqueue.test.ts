import { describe, expect, it } from 'vitest';
import { chatMediaReference } from '@/lib/whatsapp/chat-media';
import { buildInboundTranscriptionJob } from './enqueue';

const BASE = {
  accountId: 'account-1',
  messageId: 'message-1',
  conversationId: 'conversation-1',
  whatsappConfigId: 'config-1',
  departmentId: 'department-1',
  mediaReference: chatMediaReference('account-account-1/inbound/audio.ogg'),
  mimeType: 'audio/ogg',
  sizeBytes: 2048,
  durationSeconds: 12,
};

describe('buildInboundTranscriptionJob', () => {
  it('builds an idempotent private-storage job for valid inbound audio', () => {
    expect(buildInboundTranscriptionJob(BASE)).toEqual({
      account_id: 'account-1',
      message_id: 'message-1',
      conversation_id: 'conversation-1',
      whatsapp_config_id: 'config-1',
      department_id: 'department-1',
      storage_key: 'account-account-1/inbound/audio.ogg',
      mime_type: 'audio/ogg',
      size_bytes: 2048,
      duration_seconds: 12,
      status: 'pending',
    });
  });

  it('fails closed for external URLs, unsupported MIME and oversized audio', () => {
    expect(buildInboundTranscriptionJob({ ...BASE, mediaReference: 'https://example.com/audio.ogg' })).toBeNull();
    expect(buildInboundTranscriptionJob({ ...BASE, mimeType: 'video/mp4' })).toBeNull();
    expect(buildInboundTranscriptionJob({ ...BASE, sizeBytes: 30 * 1024 * 1024 })).toBeNull();
  });
});
