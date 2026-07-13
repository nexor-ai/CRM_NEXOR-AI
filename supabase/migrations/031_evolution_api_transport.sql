-- ============================================================
-- Evolution API transport migration
-- Idempotent: moves WhatsApp runtime config from Meta Cloud API fields to
-- Evolution API instance credentials while preserving legacy columns.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_base_url TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance TEXT,
  ADD COLUMN IF NOT EXISTS evolution_api_key TEXT,
  ADD COLUMN IF NOT EXISTS connection_state TEXT DEFAULT 'close';

-- EVOLUTION: legacy Meta fields become nullable because they no longer exist
-- in the Baileys/QR instance model. Keep columns for non-destructive upgrades.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'whatsapp_config'::regclass
      AND conname = 'whatsapp_config_phone_number_id_key'
  ) THEN
    ALTER TABLE whatsapp_config DROP CONSTRAINT whatsapp_config_phone_number_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_evolution_instance_key
  ON whatsapp_config (evolution_instance)
  WHERE evolution_instance IS NOT NULL;

COMMENT ON COLUMN whatsapp_config.evolution_base_url IS 'Evolution API server base URL for this account.';
COMMENT ON COLUMN whatsapp_config.evolution_instance IS 'Evolution API WhatsApp instance name connected by QR Code.';
COMMENT ON COLUMN whatsapp_config.evolution_api_key IS 'Encrypted Evolution API apikey for this account.';
COMMENT ON COLUMN whatsapp_config.connection_state IS 'Evolution connection state: open, connecting, close, or provider-specific value.';

-- Local presets: Meta review metadata is now optional legacy data.
ALTER TABLE message_templates
  ALTER COLUMN category DROP NOT NULL;
