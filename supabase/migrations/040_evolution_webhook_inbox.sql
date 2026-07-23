-- Durable Evolution webhook inbox. The public route authenticates and persists
-- the event before acknowledging it; the internal worker claims and processes
-- events with SKIP LOCKED. This avoids relying on in-process `after()` work.

CREATE TABLE IF NOT EXISTS evolution_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  instance TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS evolution_webhook_events_claim_idx
  ON evolution_webhook_events (status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE evolution_webhook_events ENABLE ROW LEVEL SECURITY;

-- No client policies: only the service-role webhook and internal worker may
-- access raw transport payloads.
REVOKE ALL ON evolution_webhook_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION claim_evolution_webhook_events(worker_limit INTEGER DEFAULT 20)
RETURNS SETOF evolution_webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM evolution_webhook_events
    WHERE (
      (
        status IN ('pending', 'failed') AND available_at <= NOW()
      ) OR (
        status = 'processing' AND claimed_at < NOW() - INTERVAL '10 minutes'
      )
    ) AND attempts < 8
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(worker_limit, 100))
  ), claimed AS (
    UPDATE evolution_webhook_events AS event
    SET status = 'processing',
        attempts = event.attempts + 1,
        claimed_at = NOW(),
        updated_at = NOW()
    FROM candidates
    WHERE event.id = candidates.id
    RETURNING event.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION claim_evolution_webhook_events(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_evolution_webhook_events(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION advance_evolution_message_status(
  transport_message_id TEXT,
  transport_instance TEXT,
  incoming_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed_count INTEGER;
BEGIN
  UPDATE messages
  SET status = incoming_status
  WHERE message_id = transport_message_id
    AND whatsapp_instance = transport_instance
    AND (
      (incoming_status = 'failed' AND status IN ('sending', 'sent'))
      OR (
        incoming_status <> 'failed'
        AND status <> 'failed'
        AND CASE incoming_status
          WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3
          ELSE -1 END
          > CASE status
          WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3
          ELSE -1 END
      )
    );
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION advance_evolution_message_status(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION advance_evolution_message_status(TEXT, TEXT, TEXT) TO service_role;

-- Fail closed before enforcing the canonical conversation identity. Automatic
-- merging is intentionally forbidden here because choosing one row would lose
-- operational state (assignment, unread/archive state and transport metadata).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce canonical conversation identity: duplicate (account_id, contact_id) rows require explicit audited consolidation';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_contact_unique
  ON conversations (account_id, contact_id);

CREATE OR REPLACE FUNCTION increment_inbound_conversation(
  conversation_id_arg UUID,
  config_id_arg UUID,
  provider_arg TEXT,
  instance_arg TEXT,
  message_text_arg TEXT,
  message_at_arg TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations
  SET last_message_text = message_text_arg,
      last_message_at = message_at_arg,
      unread_count = COALESCE(unread_count, 0) + 1,
      updated_at = NOW(),
      whatsapp_config_id = config_id_arg,
      whatsapp_provider = provider_arg,
      whatsapp_instance = instance_arg
  WHERE id = conversation_id_arg;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION increment_inbound_conversation(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_inbound_conversation(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)
  TO service_role;

CREATE OR REPLACE FUNCTION mark_conversation_read_through(
  conversation_id_arg UUID,
  account_id_arg UUID,
  read_count_arg INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE remaining INTEGER;
BEGIN
  UPDATE conversations
  SET unread_count = GREATEST(COALESCE(unread_count, 0) - GREATEST(read_count_arg, 0), 0),
      updated_at = NOW()
  WHERE id = conversation_id_arg AND account_id = account_id_arg
  RETURNING unread_count INTO remaining;
  IF remaining IS NULL THEN RAISE EXCEPTION 'Conversation not found'; END IF;
  RETURN remaining;
END;
$$;

REVOKE ALL ON FUNCTION mark_conversation_read_through(UUID, UUID, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_conversation_read_through(UUID, UUID, INTEGER)
  TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS evolution_message_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  effect_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'completed', 'failed', 'uncertain')),
  result JSONB,
  last_error TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, effect_name)
);

ALTER TABLE evolution_message_effects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON evolution_message_effects FROM anon, authenticated;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM broadcast_recipients AS recipient
    JOIN messages AS message ON message.message_id = recipient.whatsapp_message_id
    WHERE recipient.whatsapp_instance IS NULL
      AND message.whatsapp_instance IS NOT NULL
    GROUP BY recipient.id
    HAVING COUNT(DISTINCT message.whatsapp_instance) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot backfill broadcast instance: ambiguous transport ids exist';
  END IF;
END $$;

UPDATE broadcast_recipients AS recipient
SET whatsapp_instance = (
  SELECT MIN(message.whatsapp_instance)
  FROM messages AS message
  WHERE message.message_id = recipient.whatsapp_message_id
    AND message.whatsapp_instance IS NOT NULL
)
WHERE recipient.whatsapp_instance IS NULL
  AND recipient.whatsapp_message_id IS NOT NULL;

DROP INDEX IF EXISTS idx_broadcast_recipients_wamid;
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_recipients_transport_unique
  ON broadcast_recipients (whatsapp_message_id, whatsapp_instance)
  WHERE whatsapp_message_id IS NOT NULL
    AND whatsapp_instance IS NOT NULL;
