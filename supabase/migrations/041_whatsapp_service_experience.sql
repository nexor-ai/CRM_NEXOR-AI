-- Phase 2: atendimento rico e auditoria local de ações Evolution.
-- Local-only nesta fase; aplicar remotamente antes de promover o código.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_push_name TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_profile_status TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_profile_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_number_exists BOOLEAN,
  ADD COLUMN IF NOT EXISTS whatsapp_number_jid TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_number_validated_at TIMESTAMPTZ;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_data JSONB,
  ADD COLUMN IF NOT EXISTS original_content_text TEXT,
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video', 'location',
    'template', 'interactive', 'contact', 'sticker', 'poll'
  ));

CREATE INDEX IF NOT EXISTS idx_conversations_account_archived
  ON conversations(account_id, archived_at, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_validation_cache
  ON contacts(account_id, whatsapp_number_validated_at);
