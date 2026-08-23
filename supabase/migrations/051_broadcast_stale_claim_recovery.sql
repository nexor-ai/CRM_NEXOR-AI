-- 051_broadcast_stale_claim_recovery.sql
--
-- The broadcast worker claims one recipient before invoking Evolution. If the
-- process dies after the claim, the result is unknowable: Evolution may have
-- accepted the message even though this database never received a message ID.
--
-- A stale `processing` row must therefore become `uncertain`, not `pending`.
-- Retrying it automatically could duplicate a WhatsApp message. The campaign
-- can still complete from other pending recipients; uncertain rows remain
-- visible for explicit human review.

CREATE OR REPLACE FUNCTION claim_next_broadcast_recipient(p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS TABLE (
  recipient_id UUID,
  broadcast_id UUID,
  account_id UUID,
  contact_id UUID,
  template_name TEXT,
  template_language TEXT,
  variation_text TEXT,
  send_params JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b broadcasts%ROWTYPE;
  v_r broadcast_recipients%ROWTYPE;
  v_local_time TIME;
  v_sent_today INTEGER;
  v_variations JSONB;
  v_dispatch broadcast_dispatch_state%ROWTYPE;
BEGIN
  SELECT b.* INTO v_b
  FROM broadcasts b
  WHERE b.status IN ('scheduled', 'sending')
    AND COALESCE(b.next_send_at, b.scheduled_at, b.created_at) <= p_now
  ORDER BY COALESCE(b.next_send_at, b.scheduled_at, b.created_at), b.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO broadcast_dispatch_state (account_id, next_send_at)
  VALUES (v_b.account_id, p_now)
  ON CONFLICT ON CONSTRAINT broadcast_dispatch_state_pkey DO NOTHING;
  SELECT bds.* INTO v_dispatch
  FROM broadcast_dispatch_state bds
  WHERE bds.account_id = v_b.account_id
  FOR UPDATE;
  IF v_dispatch.next_send_at > p_now THEN RETURN; END IF;

  v_local_time := (p_now AT TIME ZONE v_b.schedule_timezone)::time;
  IF v_b.window_start IS NOT NULL AND v_b.window_end IS NOT NULL
     AND (v_local_time < v_b.window_start OR v_local_time >= v_b.window_end) THEN
    UPDATE broadcasts b SET next_send_at =
      ((p_now AT TIME ZONE v_b.schedule_timezone)::date + 1 + v_b.window_start)
      AT TIME ZONE v_b.schedule_timezone
    WHERE b.id = v_b.id;
    RETURN;
  END IF;

  IF v_b.daily_limit IS NOT NULL THEN
    SELECT COUNT(*) INTO v_sent_today
    FROM broadcast_recipients br
    WHERE br.broadcast_id = v_b.id
      AND br.sent_at >= date_trunc('day', p_now AT TIME ZONE v_b.schedule_timezone)
          AT TIME ZONE v_b.schedule_timezone;
    IF v_sent_today >= v_b.daily_limit THEN
      UPDATE broadcasts b SET next_send_at =
        ((p_now AT TIME ZONE v_b.schedule_timezone)::date + 1 + COALESCE(v_b.window_start, TIME '00:00'))
        AT TIME ZONE v_b.schedule_timezone
      WHERE b.id = v_b.id;
      RETURN;
    END IF;
  END IF;

  -- A worker crash leaves the external send outcome unknowable. Quarantine
  -- stale claims; never turn them back into pending automatically.
  UPDATE broadcast_recipients br
  SET status = 'uncertain',
      processing_started_at = NULL,
      error_message = COALESCE(
        br.error_message,
        'Delivery outcome uncertain: worker claim exceeded 30 minutes; manual review required.'
      )
  WHERE br.broadcast_id = v_b.id
    AND br.status = 'processing'
    AND br.processing_started_at < p_now - INTERVAL '30 minutes';

  SELECT br.* INTO v_r
  FROM broadcast_recipients br
  WHERE br.broadcast_id = v_b.id AND br.status = 'pending'
  ORDER BY br.created_at, br.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    UPDATE broadcasts b SET status = CASE WHEN b.sent_count > 0 THEN 'sent' ELSE 'failed' END,
      completed_at = p_now, next_send_at = NULL
    WHERE b.id = v_b.id;
    RETURN;
  END IF;

  UPDATE broadcast_recipients br
  SET status = 'processing', processing_started_at = p_now,
      attempt_count = br.attempt_count + 1
  WHERE br.id = v_r.id;

  UPDATE broadcasts b
  SET status = 'sending', started_at = COALESCE(b.started_at, p_now),
      next_send_at = p_now + make_interval(mins => b.interval_minutes)
  WHERE b.id = v_b.id;

  UPDATE broadcast_dispatch_state bds
  SET next_send_at = p_now + make_interval(mins => GREATEST(v_b.interval_minutes, 5)),
      updated_at = p_now
  WHERE bds.account_id = v_b.account_id;

  v_variations := CASE
    WHEN jsonb_typeof(v_b.message_variations) = 'array' THEN v_b.message_variations
    ELSE '[]'::jsonb
  END;

  RETURN QUERY SELECT
    v_r.id, v_b.id, v_b.account_id, v_r.contact_id,
    v_b.template_name, v_b.template_language,
    CASE WHEN jsonb_array_length(v_variations) > 0
      THEN v_variations ->> (v_r.variation_index % jsonb_array_length(v_variations))
      ELSE NULL END,
    v_r.send_params;
END;
$$;

REVOKE ALL ON FUNCTION claim_next_broadcast_recipient(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_next_broadcast_recipient(TIMESTAMPTZ) TO service_role;
