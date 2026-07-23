-- Sequential broadcast queue. A campaign may release at most one recipient
-- per claim, and never more often than interval_minutes (minimum 5).

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check CHECK (
  status IN ('draft','scheduled','sending','paused','sent','failed','cancelled')
);

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS interval_minutes INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_start TIME,
  ADD COLUMN IF NOT EXISTS window_end TIME,
  ADD COLUMN IF NOT EXISTS schedule_timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN IF NOT EXISTS daily_limit INTEGER,
  ADD COLUMN IF NOT EXISTS message_variations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_interval_minimum;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_interval_minimum
  CHECK (interval_minutes >= 5 AND interval_minutes <= 1440);
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_daily_limit_positive;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_daily_limit_positive
  CHECK (daily_limit IS NULL OR daily_limit > 0);

ALTER TABLE broadcast_recipients DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE broadcast_recipients ADD CONSTRAINT broadcast_recipients_status_check CHECK (
  status IN ('pending','processing','sent','delivered','read','replied','failed','uncertain','cancelled')
);
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS send_params JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS variation_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_broadcasts_sequential_due
  ON broadcasts(next_send_at)
  WHERE status IN ('scheduled','sending');
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending_queue
  ON broadcast_recipients(broadcast_id, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS broadcast_dispatch_state (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  next_send_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE broadcast_dispatch_state ENABLE ROW LEVEL SECURITY;

-- Atomic claim: locks one due campaign and one pending recipient. The campaign's
-- next slot advances inside the same transaction, so overlapping workers cannot
-- release two recipients for the same interval.
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
  WHERE b.status IN ('scheduled','sending')
    AND COALESCE(b.next_send_at, b.scheduled_at, b.created_at) <= p_now
  ORDER BY COALESCE(b.next_send_at, b.scheduled_at, b.created_at), b.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO broadcast_dispatch_state (account_id, next_send_at)
  VALUES (v_b.account_id, p_now)
  ON CONFLICT (account_id) DO NOTHING;
  SELECT * INTO v_dispatch
  FROM broadcast_dispatch_state
  WHERE account_id = v_b.account_id
  FOR UPDATE;
  IF v_dispatch.next_send_at > p_now THEN RETURN; END IF;

  v_local_time := (p_now AT TIME ZONE v_b.schedule_timezone)::time;
  IF v_b.window_start IS NOT NULL AND v_b.window_end IS NOT NULL
     AND (v_local_time < v_b.window_start OR v_local_time >= v_b.window_end) THEN
    UPDATE broadcasts SET next_send_at =
      ((p_now AT TIME ZONE v_b.schedule_timezone)::date + 1 + v_b.window_start)
      AT TIME ZONE v_b.schedule_timezone
    WHERE id = v_b.id;
    RETURN;
  END IF;

  IF v_b.daily_limit IS NOT NULL THEN
    SELECT COUNT(*) INTO v_sent_today
    FROM broadcast_recipients br
    WHERE br.broadcast_id = v_b.id
      AND br.sent_at >= date_trunc('day', p_now AT TIME ZONE v_b.schedule_timezone)
          AT TIME ZONE v_b.schedule_timezone;
    IF v_sent_today >= v_b.daily_limit THEN
      UPDATE broadcasts SET next_send_at =
        ((p_now AT TIME ZONE v_b.schedule_timezone)::date + 1 + COALESCE(v_b.window_start, TIME '00:00'))
        AT TIME ZONE v_b.schedule_timezone
      WHERE id = v_b.id;
      RETURN;
    END IF;
  END IF;

  SELECT br.* INTO v_r
  FROM broadcast_recipients br
  WHERE br.broadcast_id = v_b.id AND br.status = 'pending'
  ORDER BY br.created_at, br.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    UPDATE broadcasts SET status = CASE WHEN sent_count > 0 THEN 'sent' ELSE 'failed' END,
      completed_at = p_now, next_send_at = NULL
    WHERE id = v_b.id;
    RETURN;
  END IF;

  UPDATE broadcast_recipients
  SET status = 'processing', processing_started_at = p_now,
      attempt_count = attempt_count + 1
  WHERE id = v_r.id;

  UPDATE broadcasts
  SET status = 'sending', started_at = COALESCE(started_at, p_now),
      next_send_at = p_now + make_interval(mins => interval_minutes)
  WHERE id = v_b.id;

  UPDATE broadcast_dispatch_state
  SET next_send_at = p_now + make_interval(mins => GREATEST(v_b.interval_minutes, 5)),
      updated_at = p_now
  WHERE account_id = v_b.account_id;

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
