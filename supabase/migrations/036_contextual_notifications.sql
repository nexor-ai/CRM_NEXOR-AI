-- Contextual notification contract for operationally relevant CRM events.
-- Keeps legacy columns during transition while adding generic destinations,
-- severity, deduplication and per-user reads.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS event_key TEXT NOT NULL DEFAULT 'inbox.conversation_assigned',
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'inbox',
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS target_url TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id UUID,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS occurrence_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_scope_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_scope_check
  CHECK (scope IN ('user','account'));
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('inbox','pipeline','broadcast','automation','flow','ai','integration','system'));
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_severity_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_severity_check
  CHECK (severity IN ('info','warning','error','critical'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(account_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_contextual_feed
  ON notifications(account_id, last_occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_reads_select ON notification_reads;
CREATE POLICY notification_reads_select ON notification_reads FOR SELECT
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS notification_reads_insert ON notification_reads;
CREATE POLICY notification_reads_insert ON notification_reads FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION create_contextual_notification(
  p_account_id UUID,
  p_user_id UUID,
  p_event_key TEXT,
  p_category TEXT,
  p_severity TEXT,
  p_title TEXT,
  p_body TEXT DEFAULT NULL,
  p_target_url TEXT DEFAULT NULL,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_dedupe_key TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO notifications (
    account_id, user_id, type, event_key, scope, category, severity,
    title, body, target_url, entity_type, entity_id, dedupe_key, metadata,
    last_occurred_at
  ) VALUES (
    p_account_id, p_user_id, 'conversation_assigned', p_event_key, 'user',
    p_category, p_severity, p_title, p_body, p_target_url, p_entity_type,
    p_entity_id, p_dedupe_key, COALESCE(p_metadata, '{}'::jsonb), NOW()
  )
  ON CONFLICT (account_id, dedupe_key) WHERE dedupe_key IS NOT NULL
  DO UPDATE SET
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    severity = EXCLUDED.severity,
    target_url = EXCLUDED.target_url,
    metadata = EXCLUDED.metadata,
    occurrence_count = notifications.occurrence_count + 1,
    last_occurred_at = NOW(),
    read_at = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'contextual notification failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION list_current_notifications(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  id UUID, account_id UUID, user_id UUID, event_key TEXT, category TEXT,
  severity TEXT, title TEXT, body TEXT, target_url TEXT, entity_type TEXT,
  entity_id UUID, metadata JSONB, occurrence_count INTEGER,
  last_occurred_at TIMESTAMPTZ, is_read BOOLEAN, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT n.id, n.account_id, n.user_id, n.event_key, n.category, n.severity,
    n.title, n.body, n.target_url, n.entity_type, n.entity_id, n.metadata,
    n.occurrence_count, n.last_occurred_at,
    (n.read_at IS NOT NULL OR nr.read_at IS NOT NULL) AS is_read, n.created_at
  FROM notifications n
  LEFT JOIN notification_reads nr
    ON nr.notification_id = n.id AND nr.user_id = auth.uid()
  WHERE n.user_id = auth.uid()
  ORDER BY n.last_occurred_at DESC, n.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

CREATE OR REPLACE FUNCTION mark_notification_read(p_notification_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.id = p_notification_id AND n.user_id = auth.uid()
  ) THEN RETURN FALSE; END IF;
  INSERT INTO notification_reads(notification_id, user_id)
  VALUES (p_notification_id, auth.uid())
  ON CONFLICT (notification_id, user_id)
  DO UPDATE SET read_at = EXCLUDED.read_at;
  UPDATE notifications SET read_at = COALESCE(read_at, NOW())
  WHERE id = p_notification_id AND user_id = auth.uid();
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION create_contextual_notification(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_contextual_notification(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,JSONB) TO service_role;
REVOKE ALL ON FUNCTION list_current_notifications(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_current_notifications(INTEGER) TO authenticated, service_role;
REVOKE ALL ON FUNCTION mark_notification_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_notification_read(UUID) TO authenticated, service_role;
