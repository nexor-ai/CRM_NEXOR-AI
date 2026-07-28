-- Durable outbox for externally visible, non-transactional effects.
-- Raw payloads are service-role only; clients receive aggregate reliability data.

CREATE TABLE public.external_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  whatsapp_config_id UUID REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL CHECK (length(operation_type) BETWEEN 1 AND 80),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'uncertain', 'cancelled')),
  retry_policy TEXT NOT NULL DEFAULT 'at_most_once'
    CHECK (retry_policy IN ('retry_safe', 'at_most_once')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  fencing_token UUID,
  transport_id TEXT,
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  last_error TEXT,
  requested_by UUID,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, operation_type, idempotency_key)
);

CREATE INDEX external_operations_claim_idx
  ON public.external_operations (status, available_at, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX external_operations_reliability_idx
  ON public.external_operations (account_id, status, updated_at DESC);

ALTER TABLE public.external_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.external_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.external_operations TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_external_operation(
  account_id_arg UUID,
  operation_type_arg TEXT,
  idempotency_key_arg TEXT,
  payload_arg JSONB,
  whatsapp_config_id_arg UUID DEFAULT NULL,
  conversation_id_arg UUID DEFAULT NULL,
  message_id_arg UUID DEFAULT NULL,
  retry_policy_arg TEXT DEFAULT 'at_most_once',
  max_attempts_arg INTEGER DEFAULT 1,
  requested_by_arg UUID DEFAULT NULL
)
RETURNS public.external_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE operation public.external_operations%ROWTYPE;
BEGIN
  IF account_id_arg IS NULL OR operation_type_arg IS NULL OR idempotency_key_arg IS NULL THEN
    RAISE EXCEPTION 'External operation identity is required';
  END IF;
  IF retry_policy_arg NOT IN ('retry_safe', 'at_most_once') THEN
    RAISE EXCEPTION 'Invalid retry policy';
  END IF;
  IF payload_arg IS NULL OR jsonb_typeof(payload_arg) <> 'object' THEN
    RAISE EXCEPTION 'External operation payload must be an object';
  END IF;
  IF payload_arg ?| ARRAY['apiKey','api_key','authorization','cookie','password','secret','token','credential'] THEN
    RAISE EXCEPTION 'External operation payload contains a forbidden secret field';
  END IF;
  IF whatsapp_config_id_arg IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.whatsapp_config
    WHERE id = whatsapp_config_id_arg AND account_id = account_id_arg
  ) THEN
    RAISE EXCEPTION 'External operation WhatsApp configuration is outside the account';
  END IF;
  IF conversation_id_arg IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = conversation_id_arg AND account_id = account_id_arg
  ) THEN
    RAISE EXCEPTION 'External operation conversation is outside the account';
  END IF;
  IF message_id_arg IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.messages AS message
    JOIN public.conversations AS conversation ON conversation.id = message.conversation_id
    WHERE message.id = message_id_arg
      AND conversation.account_id = account_id_arg
      AND (conversation_id_arg IS NULL OR message.conversation_id = conversation_id_arg)
  ) THEN
    RAISE EXCEPTION 'External operation message is outside the account or conversation';
  END IF;

  INSERT INTO public.external_operations (
    account_id, whatsapp_config_id, conversation_id, message_id,
    operation_type, idempotency_key, payload, retry_policy, max_attempts, requested_by
  ) VALUES (
    account_id_arg, whatsapp_config_id_arg, conversation_id_arg, message_id_arg,
    LEFT(operation_type_arg, 80), LEFT(idempotency_key_arg, 200), payload_arg,
    retry_policy_arg, GREATEST(1, LEAST(max_attempts_arg, 20)), requested_by_arg
  )
  ON CONFLICT (account_id, operation_type, idempotency_key) DO NOTHING
  RETURNING * INTO operation;

  IF operation.id IS NULL THEN
    SELECT * INTO operation
    FROM public.external_operations
    WHERE account_id = account_id_arg
      AND operation_type = operation_type_arg
      AND idempotency_key = idempotency_key_arg;
  END IF;
  RETURN operation;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_external_operation(UUID, TEXT, TEXT, JSONB, UUID, UUID, UUID, TEXT, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_external_operation(UUID, TEXT, TEXT, JSONB, UUID, UUID, UUID, TEXT, INTEGER, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_external_operations(
  worker_limit INTEGER DEFAULT 1,
  operation_id_arg UUID DEFAULT NULL
)
RETURNS SETOF public.external_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Expired at-most-once leases have an unknown provider outcome. Safe work may
  -- return to pending, but only while its bounded attempt budget remains.
  UPDATE public.external_operations
  SET status = CASE
        WHEN retry_policy = 'at_most_once' THEN 'uncertain'
        WHEN attempts >= max_attempts THEN 'failed'
        ELSE 'pending'
      END,
      available_at = CASE WHEN retry_policy = 'retry_safe' AND attempts < max_attempts THEN NOW() ELSE available_at END,
      last_error = LEFT(COALESCE(last_error, 'Worker lease expired before finalization'), 1000),
      fencing_token = NULL,
      lease_expires_at = NULL,
      updated_at = NOW()
  WHERE status = 'processing' AND lease_expires_at <= NOW();

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.external_operations
    WHERE status = 'pending'
      AND available_at <= NOW()
      AND attempts < max_attempts
      AND (operation_id_arg IS NULL OR id = operation_id_arg)
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(worker_limit, 20))
  ), claimed AS (
    UPDATE public.external_operations AS operation
    SET status = 'processing',
        attempts = operation.attempts + 1,
        claimed_at = NOW(),
        lease_expires_at = NOW() + INTERVAL '2 minutes',
        fencing_token = gen_random_uuid(),
        updated_at = NOW()
    FROM candidates
    WHERE operation.id = candidates.id
    RETURNING operation.*
  )
  SELECT * FROM claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_external_operations(INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_external_operations(INTEGER, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_external_operation(
  operation_id_arg UUID,
  fencing_token_arg UUID,
  status_arg TEXT,
  result_arg JSONB DEFAULT NULL,
  error_arg TEXT DEFAULT NULL,
  transport_id_arg TEXT DEFAULT NULL
)
RETURNS public.external_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE operation public.external_operations%ROWTYPE;
BEGIN
  IF status_arg NOT IN ('succeeded', 'failed', 'uncertain', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid terminal external operation status';
  END IF;
  UPDATE public.external_operations
  SET status = status_arg,
      result = CASE WHEN status_arg = 'succeeded' THEN COALESCE(result_arg, '{}'::JSONB) ELSE NULL END,
      transport_id = CASE WHEN status_arg = 'succeeded' THEN LEFT(transport_id_arg, 512) ELSE NULL END,
      last_error = CASE WHEN status_arg = 'succeeded' THEN NULL ELSE LEFT(COALESCE(error_arg, 'External operation failed'), 1000) END,
      completed_at = NOW(),
      fencing_token = NULL,
      lease_expires_at = NULL,
      updated_at = NOW()
  WHERE id = operation_id_arg
    AND status = 'processing'
    AND fencing_token = fencing_token_arg
  RETURNING * INTO operation;
  IF operation.id IS NULL THEN RAISE EXCEPTION 'External operation lease is stale or missing'; END IF;
  RETURN operation;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_external_operation(UUID, UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_external_operation(UUID, UUID, TEXT, JSONB, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_external_operation(
  operation_id_arg UUID,
  account_id_arg UUID,
  requested_by_arg UUID
)
RETURNS public.external_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE operation public.external_operations%ROWTYPE;
BEGIN
  UPDATE public.external_operations
  SET status = 'pending', available_at = NOW(), last_error = NULL,
      requested_by = requested_by_arg, completed_at = NULL, updated_at = NOW()
  WHERE id = operation_id_arg
    AND account_id = account_id_arg
    AND retry_policy = 'retry_safe'
    AND status IN ('failed', 'uncertain')
    AND attempts < max_attempts
  RETURNING * INTO operation;
  IF operation.id IS NULL THEN RAISE EXCEPTION 'Safe retryable external operation not found'; END IF;
  RETURN operation;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_external_operation(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_external_operation(UUID, UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.external_operations_reliability_counts(account_id_arg UUID)
RETURNS TABLE (pending BIGINT, processing BIGINT, failed BIGINT, uncertain BIGINT, dead_letter BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'processing'),
    COUNT(*) FILTER (WHERE status = 'failed' AND attempts < max_attempts),
    COUNT(*) FILTER (WHERE status = 'uncertain'),
    COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= max_attempts)
  FROM public.external_operations
  WHERE account_id = account_id_arg;
$$;
REVOKE ALL ON FUNCTION public.external_operations_reliability_counts(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.external_operations_reliability_counts(UUID) TO service_role;
