-- ============================================================
-- Evolution multi-instance traceability and active-config hardening
-- Additive and idempotent. Does not disable, delete, or rewrite config rows.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_provider TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS whatsapp_provider TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_account_phone TEXT;

CREATE INDEX IF NOT EXISTS whatsapp_config_account_active_idx
  ON whatsapp_config (account_id, updated_at DESC)
  WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS messages_transport_instance_idx
  ON messages (message_id, whatsapp_instance)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversations_whatsapp_config_idx
  ON conversations (whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

DO $$
DECLARE
  duplicate_account UUID;
BEGIN
  SELECT account_id INTO duplicate_account
  FROM whatsapp_config
  WHERE disabled_at IS NULL
  GROUP BY account_id
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF duplicate_account IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one active WhatsApp configuration per account: account % has multiple active rows. Disable the obsolete rows explicitly, then re-run this migration.',
      duplicate_account;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_active_per_account
  ON whatsapp_config (account_id)
  WHERE disabled_at IS NULL;
