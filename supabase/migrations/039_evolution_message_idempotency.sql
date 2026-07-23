-- Evolution may retry MESSAGES_UPSERT deliveries. The application checks for
-- an existing transport id before processing; this partial unique index closes
-- the concurrent-delivery race at the database layer.
--
-- Legacy rows without whatsapp_instance remain untouched because their
-- transport identity is ambiguous. Traced Evolution messages are unique by
-- (message_id, whatsapp_instance), not message_id globally.

DO $$
DECLARE
  duplicate_key RECORD;
BEGIN
  SELECT message_id, whatsapp_instance, COUNT(*) AS row_count
  INTO duplicate_key
  FROM messages
  WHERE message_id IS NOT NULL
    AND whatsapp_instance IS NOT NULL
  GROUP BY message_id, whatsapp_instance
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF duplicate_key IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce Evolution message idempotency: message_id % on instance % has % rows. Resolve the duplicates explicitly, then re-run this migration.',
      duplicate_key.message_id,
      duplicate_key.whatsapp_instance,
      duplicate_key.row_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS messages_evolution_transport_unique
  ON messages (message_id, whatsapp_instance)
  WHERE message_id IS NOT NULL
    AND whatsapp_instance IS NOT NULL;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_error TEXT;