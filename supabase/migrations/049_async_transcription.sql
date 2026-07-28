-- P2-C: transcrição assíncrona durável. O webhook apenas grava uma linha leve;
-- o trabalho CPU/int8 fica em scripts/transcription_worker.py.
CREATE TABLE IF NOT EXISTS transcription_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- messages não tem account_id, então esta FK não pode ser composta.
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  whatsapp_config_id uuid,
  department_id uuid,
  storage_key text NOT NULL,
  mime_type text NOT NULL
    CHECK (mime_type IN ('audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  duration_seconds numeric NOT NULL CHECK (duration_seconds BETWEEN 0 AND 1800),
  consent_basis text NOT NULL DEFAULT 'inbound_customer_audio'
    CHECK (consent_basis IN ('inbound_customer_audio')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'completed', 'dead_letter', 'rejected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  lease_token uuid,
  completed_at timestamptz,
  dead_letter_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, message_id),
  UNIQUE (account_id, id),
  CHECK (attempts <= max_attempts),
  -- Sem estas FKs compostas, um job da conta A poderia apontar para uma conversa
  -- da conta B e gravar o áudio transcrito de um cliente sob outro.
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id)
    ON DELETE CASCADE,
  -- PostgreSQL 15+ aceita lista de colunas em SET NULL: mantém a semântica de
  -- 046 (whatsapp_config_id ON DELETE SET NULL) sem anular account_id (NOT NULL)
  -- e sem apagar a trilha de transcrição ao remover uma instância.
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id)
    ON DELETE SET NULL (whatsapp_config_id),
  -- RESTRICT segue a convenção de departamentos da 046.
  FOREIGN KEY (account_id, department_id) REFERENCES departments(account_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS transcription_jobs_claim_idx
  ON transcription_jobs(status, available_at, created_at)
  WHERE status IN ('pending', 'retry', 'processing');

CREATE TABLE IF NOT EXISTS message_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- messages não tem account_id, então esta FK não pode ser composta.
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE,
  transcript text NOT NULL CHECK (length(trim(transcript)) > 0),
  language text,
  confidence numeric CHECK (confidence BETWEEN 0 AND 1),
  enrichment jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_name text NOT NULL,
  processing_ms integer CHECK (processing_ms >= 0),
  consent_basis text NOT NULL CHECK (consent_basis IN ('inbound_customer_audio')),
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, job_id) REFERENCES transcription_jobs(account_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reliability_recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('transcription', 'external_operation', 'webhook_event', 'agent_run')),
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('requeue', 'retry_safe', 'mark_resolved', 'cancel')),
  reason text NOT NULL CHECK (length(trim(reason)) >= 5),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'claimed', 'completed', 'rejected')),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  processed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  outcome jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS reliability_recovery_account_idx
  ON reliability_recovery_requests(account_id, created_at DESC);

ALTER TABLE transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reliability_recovery_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reliability_recovery_requests_read ON reliability_recovery_requests;
CREATE POLICY reliability_recovery_requests_read ON reliability_recovery_requests
  FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS reliability_recovery_requests_insert ON reliability_recovery_requests;
CREATE POLICY reliability_recovery_requests_insert ON reliability_recovery_requests
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'admin') AND requested_by = auth.uid()
  );
DROP POLICY IF EXISTS transcription_jobs_read ON transcription_jobs;
CREATE POLICY transcription_jobs_read ON transcription_jobs
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS message_transcripts_read ON message_transcripts;
CREATE POLICY message_transcripts_read ON message_transcripts
  FOR SELECT USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON transcription_jobs, message_transcripts
  FROM anon, authenticated;

-- Uma solicitação de recuperação só pode apontar para alvo da própria conta.
CREATE OR REPLACE FUNCTION validate_reliability_recovery_target()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owned boolean;
BEGIN
  CASE NEW.kind
    WHEN 'transcription' THEN
      SELECT EXISTS(SELECT 1 FROM transcription_jobs WHERE id = NEW.target_id AND account_id = NEW.account_id) INTO owned;
    WHEN 'external_operation' THEN
      SELECT EXISTS(SELECT 1 FROM external_operations WHERE id = NEW.target_id AND account_id = NEW.account_id) INTO owned;
    WHEN 'webhook_event' THEN
      SELECT EXISTS(SELECT 1 FROM evolution_webhook_events WHERE id = NEW.target_id AND account_id = NEW.account_id) INTO owned;
    WHEN 'agent_run' THEN
      SELECT EXISTS(SELECT 1 FROM ai_agent_runs WHERE id = NEW.target_id AND account_id = NEW.account_id) INTO owned;
    ELSE owned := false;
  END CASE;
  IF NOT owned THEN RAISE EXCEPTION 'recovery_target_not_owned'; END IF;
  IF NEW.kind <> 'external_operation' AND NEW.action = 'retry_safe' THEN
    RAISE EXCEPTION 'retry_safe_external_operation_only';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reliability_recovery_target_scope ON reliability_recovery_requests;
CREATE TRIGGER reliability_recovery_target_scope
  BEFORE INSERT ON reliability_recovery_requests
  FOR EACH ROW EXECUTE FUNCTION validate_reliability_recovery_target();

-- Recupera leases vencidos para retry com backoff; tentativas esgotadas vão para
-- dead-letter. Depois reclama apenas itens disponíveis, usando fencing token novo.
CREATE OR REPLACE FUNCTION claim_transcription_jobs(p_worker_limit integer DEFAULT 1)
RETURNS SETOF transcription_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE transcription_jobs SET
    status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
    dead_letter_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
    available_at = CASE WHEN attempts >= max_attempts THEN available_at
      ELSE now() + make_interval(secs => LEAST(3600, 30 * power(2, GREATEST(0, attempts - 1))::integer)) END,
    error_code = CASE WHEN attempts >= max_attempts THEN 'stale_attempts_exhausted' ELSE 'stale_lease' END,
    error_message = 'Lease de transcrição expirou antes da conclusão',
    claimed_at = NULL,
    lease_token = NULL,
    updated_at = now()
  WHERE status = 'processing' AND claimed_at < now() - interval '15 minutes';

  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM transcription_jobs
    WHERE status IN ('pending', 'retry') AND available_at <= now() AND attempts < max_attempts
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_worker_limit, 5))
  ), claimed AS (
    UPDATE transcription_jobs job SET
      status = 'processing',
      attempts = job.attempts + 1,
      claimed_at = now(),
      lease_token = gen_random_uuid(),
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    FROM candidates candidate WHERE job.id = candidate.id
    RETURNING job.*
  ) SELECT * FROM claimed;
END $$;
REVOKE ALL ON FUNCTION claim_transcription_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_transcription_jobs(integer) TO service_role;

CREATE OR REPLACE FUNCTION finish_transcription_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_transcript text,
  p_language text,
  p_model_name text,
  p_processing_ms integer,
  p_enrichment jsonb DEFAULT '{}'::jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE job transcription_jobs;
BEGIN
  IF length(trim(COALESCE(p_transcript, ''))) = 0 THEN RAISE EXCEPTION 'empty_transcript'; END IF;
  UPDATE transcription_jobs SET
    status = 'completed', completed_at = now(), claimed_at = NULL, lease_token = NULL,
    error_code = NULL, error_message = NULL, updated_at = now()
  WHERE id = p_job_id AND status = 'processing' AND lease_token = p_lease_token
  RETURNING * INTO job;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO message_transcripts(
    account_id, message_id, job_id, transcript, language, enrichment, model_name, processing_ms,
    consent_basis, retention_until
  ) VALUES (
    job.account_id, job.message_id, job.id, trim(p_transcript), p_language,
    COALESCE(p_enrichment, '{}'::jsonb), p_model_name, p_processing_ms,
    job.consent_basis, now() + interval '30 days'
  ) ON CONFLICT (message_id) DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION finish_transcription_job(uuid, uuid, text, text, text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finish_transcription_job(uuid, uuid, text, text, text, integer, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION fail_transcription_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_error_message text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  UPDATE transcription_jobs SET
    status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry' END,
    dead_letter_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
    available_at = CASE WHEN attempts >= max_attempts THEN available_at
      ELSE now() + make_interval(secs => LEAST(3600, 30 * power(2, GREATEST(0, attempts - 1))::integer)) END,
    claimed_at = NULL,
    lease_token = NULL,
    error_code = left(COALESCE(p_error_code, 'worker_error'), 80),
    error_message = left(regexp_replace(COALESCE(p_error_message, ''), 'https?://[^ ]+', '[url redacted]', 'gi'), 240),
    updated_at = now()
  WHERE id = p_job_id AND status = 'processing' AND lease_token = p_lease_token;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;
REVOKE ALL ON FUNCTION fail_transcription_job(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fail_transcription_job(uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION purge_expired_message_transcripts(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  WITH expired AS (
    SELECT id FROM message_transcripts
    WHERE retention_until <= now()
    ORDER BY retention_until
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
  )
  DELETE FROM message_transcripts transcript USING expired
  WHERE transcript.id = expired.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION purge_expired_message_transcripts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_expired_message_transcripts(integer) TO service_role;

-- Executor síncrono e atômico das solicitações administrativas. A allowlist é
-- deliberadamente estreita: nenhuma transição reexecuta efeito at-most-once.
CREATE OR REPLACE FUNCTION execute_reliability_recovery_request(p_request_id uuid)
RETURNS reliability_recovery_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  req reliability_recovery_requests;
  actor uuid := auth.uid();
  changed integer := 0;
BEGIN
  SELECT * INTO req FROM reliability_recovery_requests
  WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recovery_request_not_found'; END IF;
  IF actor IS NULL OR req.requested_by <> actor OR NOT is_account_member(req.account_id, 'admin') THEN
    RAISE EXCEPTION 'recovery_request_forbidden';
  END IF;
  IF req.status <> 'requested' THEN RETURN req; END IF;

  UPDATE reliability_recovery_requests
  SET status = 'claimed', processed_by = actor
  WHERE id = req.id;

  IF req.kind = 'transcription' AND req.action = 'requeue' THEN
    UPDATE transcription_jobs SET status = 'pending', attempts = 0, available_at = now(),
      claimed_at = NULL, lease_token = NULL, completed_at = NULL, dead_letter_at = NULL,
      error_code = NULL, error_message = NULL, updated_at = now()
    WHERE id = req.target_id AND account_id = req.account_id AND status = 'dead_letter';
    GET DIAGNOSTICS changed = ROW_COUNT;
  ELSIF req.kind = 'external_operation' AND req.action = 'retry_safe' THEN
    UPDATE external_operations SET status = 'pending', available_at = now(), last_error = NULL,
      requested_by = actor, completed_at = NULL, updated_at = now()
    WHERE id = req.target_id AND account_id = req.account_id
      AND retry_policy = 'retry_safe' AND status IN ('failed', 'uncertain')
      AND attempts < max_attempts;
    GET DIAGNOSTICS changed = ROW_COUNT;
  ELSIF req.kind = 'webhook_event' AND req.action = 'requeue' THEN
    UPDATE evolution_webhook_events SET status = 'pending', attempts = 0, available_at = now(),
      claimed_at = NULL, claim_token = NULL, processed_at = NULL, dead_letter_at = NULL,
      last_error = NULL, updated_at = now()
    WHERE id = req.target_id AND account_id = req.account_id AND status = 'dead_letter';
    GET DIAGNOSTICS changed = ROW_COUNT;
  ELSIF req.kind = 'agent_run' AND req.action = 'cancel' THEN
    UPDATE ai_agent_runs SET status = 'blocked', finished_at = now(),
      error_code = 'cancelled_by_admin', error_message = left(req.reason, 240)
    WHERE id = req.target_id AND account_id = req.account_id
      AND status IN ('claimed', 'generated', 'awaiting_approval');
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 1 THEN
      INSERT INTO ai_agent_events(account_id, run_id, agent_id, conversation_id, event_type, detail, actor_user_id)
      SELECT account_id, id, agent_id, conversation_id, 'recovery_cancelled',
        jsonb_build_object('reason', req.reason, 'recovery_request_id', req.id), actor
      FROM ai_agent_runs WHERE id = req.target_id AND account_id = req.account_id;
    END IF;
  END IF;

  IF changed <> 1 THEN
    UPDATE reliability_recovery_requests SET status = 'rejected', completed_at = now(),
      error_code = 'recovery_state_or_action_forbidden',
      outcome = jsonb_build_object('changed', 0, 'kind', req.kind, 'action', req.action)
    WHERE id = req.id RETURNING * INTO req;
    RETURN req;
  END IF;

  UPDATE reliability_recovery_requests SET status = 'completed', completed_at = now(),
    error_code = NULL,
    outcome = jsonb_build_object('changed', 1, 'kind', req.kind, 'action', req.action)
  WHERE id = req.id RETURNING * INTO req;
  RETURN req;
END $$;
REVOKE ALL ON FUNCTION execute_reliability_recovery_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION execute_reliability_recovery_request(uuid) TO authenticated;

-- Enqueue estritamente para mensagens de áudio. O webhook fornece storage_key,
-- MIME, tamanho e duração em content_data depois de persistir a mídia privada.
CREATE OR REPLACE FUNCTION enqueue_audio_transcription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  conversation_row conversations;
  metadata jsonb;
  normalized_mime text;
  media_size bigint;
  media_duration numeric;
  stored_key text;
  rejection_code text;
BEGIN
  IF NEW.content_type <> 'audio' THEN RETURN NEW; END IF;
  SELECT * INTO conversation_row FROM conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  metadata := COALESCE(to_jsonb(NEW) -> 'content_data', '{}'::jsonb);
  normalized_mime := lower(split_part(COALESCE(metadata ->> 'mime_type', metadata ->> 'mimetype', ''), ';', 1));
  stored_key := COALESCE(metadata ->> 'storage_key', '');
  BEGIN
    media_size := COALESCE((metadata ->> 'size_bytes')::bigint, 0);
    media_duration := COALESCE((metadata ->> 'duration_seconds')::numeric, 0);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    media_size := 0; media_duration := 0; rejection_code := 'invalid_metadata';
  END;

  IF rejection_code IS NULL AND normalized_mime NOT IN (
    'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'
  ) THEN rejection_code := 'unsupported_mime'; END IF;
  IF rejection_code IS NULL AND (stored_key = '' OR stored_key !~ ('^account-' || conversation_row.account_id::text || '/'))
    THEN rejection_code := 'missing_private_storage'; END IF;
  IF rejection_code IS NULL AND (media_size <= 0 OR media_size > 26214400)
    THEN rejection_code := 'file_too_large'; END IF;
  IF rejection_code IS NULL AND (media_duration < 0 OR media_duration > 1800)
    THEN rejection_code := 'duration_exceeded'; END IF;

  INSERT INTO transcription_jobs(
    account_id, message_id, conversation_id, whatsapp_config_id, department_id,
    storage_key, mime_type, size_bytes, duration_seconds, status, error_code, error_message
  ) VALUES (
    conversation_row.account_id, NEW.id, NEW.conversation_id,
    (to_jsonb(NEW) ->> 'whatsapp_config_id')::uuid,
    (to_jsonb(conversation_row) ->> 'department_id')::uuid,
    CASE WHEN stored_key = '' THEN 'unavailable' ELSE stored_key END,
    CASE WHEN normalized_mime IN (
      'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'
    ) THEN normalized_mime ELSE 'audio/ogg' END,
    LEAST(GREATEST(media_size, 0), 26214400),
    LEAST(GREATEST(media_duration, 0), 1800),
    CASE WHEN rejection_code IS NULL THEN 'pending' ELSE 'rejected' END,
    rejection_code,
    CASE WHEN rejection_code IS NULL THEN NULL ELSE 'Áudio rejeitado pelos limites de transcrição' END
  ) ON CONFLICT (account_id, message_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_enqueue_audio_transcription ON messages;
CREATE TRIGGER messages_enqueue_audio_transcription
  AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION enqueue_audio_transcription();
