-- Phase 1 final hardening: tenant-scoped inbox/effects, fenced leases and
-- explicit dead-letter lifecycle. Local-only; apply after migrations 039-041.

ALTER TABLE evolution_webhook_events
  ADD COLUMN IF NOT EXISTS dead_letter_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS claim_token UUID;

UPDATE evolution_webhook_events AS event
SET account_id = config.account_id,
    whatsapp_config_id = config.id
FROM whatsapp_config AS config
WHERE event.account_id IS NULL
  AND config.evolution_instance = event.instance
  AND config.disabled_at IS NULL;

ALTER TABLE evolution_webhook_events
  DROP CONSTRAINT IF EXISTS evolution_webhook_events_status_check;
ALTER TABLE evolution_webhook_events
  ADD CONSTRAINT evolution_webhook_events_status_check
  CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter'));

CREATE INDEX IF NOT EXISTS evolution_webhook_events_account_status_idx
  ON evolution_webhook_events (account_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION claim_evolution_webhook_events(worker_limit INTEGER DEFAULT 1)
RETURNS SETOF evolution_webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE evolution_webhook_events
  SET status = 'dead_letter',
      dead_letter_at = COALESCE(dead_letter_at, NOW()),
      claim_token = NULL,
      updated_at = NOW()
  WHERE attempts >= 8
    AND (
      status = 'failed'
      OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '10 minutes')
    );

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM evolution_webhook_events
    WHERE (
      (status IN ('pending', 'failed') AND available_at <= NOW())
      OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '10 minutes')
    )
      AND attempts < 8
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(worker_limit, 5))
  ), claimed AS (
    UPDATE evolution_webhook_events AS event
    SET status = 'processing',
        attempts = event.attempts + 1,
        claim_token = gen_random_uuid(),
        claimed_at = NOW(),
        updated_at = NOW()
    FROM candidates
    WHERE event.id = candidates.id
    RETURNING event.*
  )
  SELECT * FROM claimed;
END;
$$;
REVOKE ALL ON FUNCTION claim_evolution_webhook_events(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_evolution_webhook_events(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION finish_evolution_webhook_event(
  event_id_arg UUID,
  claim_token_arg UUID,
  succeeded_arg BOOLEAN,
  error_arg TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE final_status TEXT;
BEGIN
  UPDATE evolution_webhook_events
  SET status = CASE
        WHEN succeeded_arg THEN 'processed'
        WHEN attempts >= 8 THEN 'dead_letter'
        ELSE 'failed'
      END,
      processed_at = CASE WHEN succeeded_arg THEN NOW() ELSE processed_at END,
      available_at = CASE
        WHEN succeeded_arg OR attempts >= 8 THEN available_at
        ELSE NOW() + make_interval(
          secs => LEAST(3600, 30 * (2 ^ GREATEST(0, attempts - 1))::INTEGER)
        )
      END,
      dead_letter_at = CASE WHEN NOT succeeded_arg AND attempts >= 8 THEN NOW() ELSE NULL END,
      last_error = CASE
        WHEN succeeded_arg THEN NULL
        ELSE LEFT(COALESCE(error_arg, 'Unknown webhook processing error'), 1000)
      END,
      claim_token = NULL,
      updated_at = NOW()
  WHERE id = event_id_arg
    AND status = 'processing'
    AND claim_token = claim_token_arg
  RETURNING status INTO final_status;

  IF final_status IS NULL THEN
    RAISE EXCEPTION 'Webhook event lease is stale or missing';
  END IF;
  RETURN final_status;
END;
$$;
REVOKE ALL ON FUNCTION finish_evolution_webhook_event(UUID, UUID, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finish_evolution_webhook_event(UUID, UUID, BOOLEAN, TEXT)
  TO service_role;

ALTER TABLE evolution_message_effects
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_policy TEXT NOT NULL DEFAULT 'at_most_once'
    CHECK (retry_policy IN ('retry_safe', 'at_most_once')),
  ADD COLUMN IF NOT EXISTS manual_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS claim_token UUID;

UPDATE evolution_message_effects AS effect
SET account_id = conversation.account_id
FROM messages AS message
JOIN conversations AS conversation ON conversation.id = message.conversation_id
WHERE effect.message_id = message.id
  AND effect.account_id IS NULL;

UPDATE evolution_message_effects
SET lease_expires_at = claimed_at + INTERVAL '10 minutes',
    claim_token = COALESCE(claim_token, gen_random_uuid())
WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS evolution_message_effects_account_status_idx
  ON evolution_message_effects (account_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION claim_evolution_message_effect(
  message_id_arg UUID,
  account_id_arg UUID,
  effect_name_arg TEXT,
  retry_failed_arg BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  effect_id UUID,
  effect_status TEXT,
  effect_result JSONB,
  effect_claim_token UUID,
  acquired BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_id UUID;
  current_effect evolution_message_effects%ROWTYPE;
BEGIN
  INSERT INTO evolution_message_effects AS effect (
    message_id, account_id, effect_name, status, attempts, claimed_at,
    lease_expires_at, retry_policy, claim_token
  ) VALUES (
    message_id_arg, account_id_arg, effect_name_arg, 'claimed', 1, NOW(),
    NOW() + INTERVAL '10 minutes',
    CASE WHEN retry_failed_arg THEN 'retry_safe' ELSE 'at_most_once' END,
    gen_random_uuid()
  )
  ON CONFLICT (message_id, effect_name) DO NOTHING
  RETURNING effect.id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN QUERY
    SELECT effect.id, effect.status, effect.result, effect.claim_token, TRUE
    FROM evolution_message_effects AS effect WHERE effect.id = inserted_id;
    RETURN;
  END IF;

  SELECT * INTO current_effect
  FROM evolution_message_effects
  WHERE message_id = message_id_arg
    AND account_id = account_id_arg
    AND effect_name = effect_name_arg
  FOR UPDATE;

  IF current_effect.id IS NULL THEN
    RAISE EXCEPTION 'Effect exists outside the requested account';
  END IF;
  IF current_effect.status = 'completed' THEN
    RETURN QUERY SELECT current_effect.id, current_effect.status,
      current_effect.result, current_effect.claim_token, FALSE;
    RETURN;
  END IF;

  IF current_effect.status = 'failed'
     AND (retry_failed_arg OR current_effect.manual_retry_at IS NOT NULL) THEN
    UPDATE evolution_message_effects AS effect
    SET status = 'claimed',
        attempts = effect.attempts + 1,
        claimed_at = NOW(),
        claim_token = gen_random_uuid(),
        lease_expires_at = NOW() + INTERVAL '10 minutes',
        manual_retry_at = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE effect.id = current_effect.id
    RETURNING effect.* INTO current_effect;
    RETURN QUERY SELECT current_effect.id, current_effect.status,
      current_effect.result, current_effect.claim_token, TRUE;
    RETURN;
  END IF;

  IF current_effect.status = 'claimed'
     AND current_effect.lease_expires_at <= NOW() THEN
    IF retry_failed_arg THEN
      UPDATE evolution_message_effects AS effect
      SET attempts = effect.attempts + 1,
          claimed_at = NOW(),
          claim_token = gen_random_uuid(),
          lease_expires_at = NOW() + INTERVAL '10 minutes',
          last_error = NULL,
          updated_at = NOW()
      WHERE effect.id = current_effect.id
      RETURNING effect.* INTO current_effect;
      RETURN QUERY SELECT current_effect.id, current_effect.status,
        current_effect.result, current_effect.claim_token, TRUE;
    ELSE
      UPDATE evolution_message_effects
      SET status = 'uncertain',
          last_error = COALESCE(last_error, 'Effect lease expired before completion'),
          claim_token = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE id = current_effect.id;
      RETURN QUERY SELECT current_effect.id, 'uncertain'::TEXT, NULL::JSONB,
        NULL::UUID, FALSE;
    END IF;
    RETURN;
  END IF;

  RETURN QUERY SELECT current_effect.id, current_effect.status,
    current_effect.result, current_effect.claim_token, FALSE;
END;
$$;
REVOKE ALL ON FUNCTION claim_evolution_message_effect(UUID, UUID, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_evolution_message_effect(UUID, UUID, TEXT, BOOLEAN)
  TO service_role;

CREATE OR REPLACE FUNCTION finish_evolution_message_effect(
  effect_id_arg UUID,
  claim_token_arg UUID,
  status_arg TEXT,
  result_arg JSONB DEFAULT NULL,
  error_arg TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE changed_count INTEGER;
BEGIN
  IF status_arg NOT IN ('completed', 'failed', 'uncertain') THEN
    RAISE EXCEPTION 'Invalid effect terminal status';
  END IF;
  UPDATE evolution_message_effects
  SET status = status_arg,
      result = CASE WHEN status_arg = 'completed' THEN result_arg ELSE result END,
      completed_at = CASE WHEN status_arg = 'completed' THEN NOW() ELSE completed_at END,
      last_error = CASE WHEN status_arg = 'completed' THEN NULL ELSE LEFT(error_arg, 1000) END,
      claim_token = NULL,
      lease_expires_at = NULL,
      updated_at = NOW()
  WHERE id = effect_id_arg
    AND status = 'claimed'
    AND claim_token = claim_token_arg;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END;
$$;
REVOKE ALL ON FUNCTION finish_evolution_message_effect(UUID, UUID, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finish_evolution_message_effect(UUID, UUID, TEXT, JSONB, TEXT)
  TO service_role;

-- The active application uses mark_conversation_read_through(UUID, UUID,
-- INTEGER) from migration 040 as SECURITY INVOKER. No alternate overload or
-- parallel effect table is created here.
