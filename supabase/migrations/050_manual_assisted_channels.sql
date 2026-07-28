-- P2-E: Channels is manual-assisted only. No Evolution/@newsletter/auto publish.
CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  department_id uuid, name text NOT NULL, target text NOT NULL,
  provider text NOT NULL DEFAULT 'manual' CHECK (provider='manual'),
  is_active boolean NOT NULL DEFAULT true, created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_target_forbidden CHECK (position('@newsletter' in lower(target))=0),
  UNIQUE(account_id,name), UNIQUE (account_id, id),
  FOREIGN KEY (account_id, department_id) REFERENCES departments(account_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS channel_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL, department_id uuid,
  title text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','approved','exported','confirmed','cancelled')),
  current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, channel_id) REFERENCES channels(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, department_id) REFERENCES departments(account_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS channel_post_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  post_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  title text NOT NULL, body text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'), created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(post_id,revision), UNIQUE(post_id,content_hash),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, post_id) REFERENCES channel_posts(account_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channel_post_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  post_id uuid NOT NULL, revision_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  decided_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT, note text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, post_id) REFERENCES channel_posts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, revision_id) REFERENCES channel_post_revisions(account_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS channel_manual_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  post_id uuid NOT NULL, revision_id uuid NOT NULL,
  package_hash text NOT NULL CHECK(package_hash~'^[0-9a-f]{64}$'), package_payload jsonb NOT NULL,
  exported_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT, exported_at timestamptz NOT NULL DEFAULT now(), UNIQUE(post_id,revision_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, post_id) REFERENCES channel_posts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, revision_id) REFERENCES channel_post_revisions(account_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS channel_publish_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  post_id uuid NOT NULL, package_id uuid NOT NULL,
  confirmation text NOT NULL, external_reference text, evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT, confirmed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(post_id),
  FOREIGN KEY (account_id, post_id) REFERENCES channel_posts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, package_id) REFERENCES channel_manual_packages(account_id, id) ON DELETE RESTRICT
);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['channels','channel_posts','channel_post_revisions','channel_post_approvals','channel_manual_packages','channel_publish_evidence'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_read',t); EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (is_account_member(account_id))',t||'_read',t); EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_write',t); EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (is_account_member(account_id,''admin'')) WITH CHECK (is_account_member(account_id,''admin''))',t||'_write',t); END LOOP; END $$;

-- Revisions and decisions are immutable audit evidence.
CREATE OR REPLACE FUNCTION forbid_channel_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'channel_audit_rows_are_immutable'; END $$;
DROP TRIGGER IF EXISTS channel_revisions_immutable ON channel_post_revisions;
CREATE TRIGGER channel_revisions_immutable BEFORE UPDATE OR DELETE ON channel_post_revisions FOR EACH ROW EXECUTE FUNCTION forbid_channel_audit_mutation();
DROP TRIGGER IF EXISTS channel_approvals_immutable ON channel_post_approvals;
CREATE TRIGGER channel_approvals_immutable BEFORE UPDATE OR DELETE ON channel_post_approvals FOR EACH ROW EXECUTE FUNCTION forbid_channel_audit_mutation();
DROP TRIGGER IF EXISTS channel_packages_immutable ON channel_manual_packages;
CREATE TRIGGER channel_packages_immutable BEFORE UPDATE OR DELETE ON channel_manual_packages FOR EACH ROW EXECUTE FUNCTION forbid_channel_audit_mutation();
DROP TRIGGER IF EXISTS channel_evidence_immutable ON channel_publish_evidence;
CREATE TRIGGER channel_evidence_immutable BEFORE UPDATE OR DELETE ON channel_publish_evidence FOR EACH ROW EXECUTE FUNCTION forbid_channel_audit_mutation();

CREATE OR REPLACE FUNCTION create_channel_revision(p_post_id uuid,p_title text,p_body text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS channel_post_revisions LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE p channel_posts; r channel_post_revisions; next_revision integer; canonical text;
BEGIN
  SELECT * INTO p FROM channel_posts WHERE id=p_post_id AND is_account_member(account_id,'admin') FOR UPDATE;
  IF NOT FOUND OR p.status IN ('confirmed','cancelled') THEN RAISE EXCEPTION 'post_not_editable'; END IF;
  next_revision:=p.current_revision+1;
  canonical:=jsonb_build_object('title',p_title,'body',p_body,'metadata',COALESCE(p_metadata,'{}'::jsonb),'revision',next_revision)::text;
  INSERT INTO channel_post_revisions(account_id,post_id,revision,title,body,metadata,content_hash,created_by)
  VALUES(p.account_id,p.id,next_revision,p_title,p_body,COALESCE(p_metadata,'{}'::jsonb),encode(digest(canonical,'sha256'),'hex'),auth.uid()) RETURNING * INTO r;
  UPDATE channel_posts SET current_revision=next_revision,status='in_review',updated_at=now() WHERE id=p.id; RETURN r;
END $$;
REVOKE ALL ON FUNCTION create_channel_revision(uuid,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION create_channel_revision(uuid,text,text,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION decide_channel_revision(p_post_id uuid,p_revision_id uuid,p_decision text,p_note text DEFAULT NULL)
RETURNS channel_post_approvals LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE p channel_posts; r channel_post_revisions; outrow channel_post_approvals;
BEGIN
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'invalid_channel_decision'; END IF;
  SELECT * INTO p FROM channel_posts WHERE id=p_post_id AND is_account_member(account_id,'admin') FOR UPDATE;
  SELECT * INTO r FROM channel_post_revisions WHERE id=p_revision_id AND post_id=p.id;
  IF p.id IS NULL OR p.status <> 'in_review' OR r.id IS NULL OR r.revision <> p.current_revision
    THEN RAISE EXCEPTION 'current_review_required'; END IF;
  INSERT INTO channel_post_approvals(account_id,post_id,revision_id,decision,decided_by,note)
  VALUES(p.account_id,p.id,r.id,p_decision,auth.uid(),nullif(trim(p_note),'')) RETURNING * INTO outrow;
  UPDATE channel_posts SET status=CASE WHEN p_decision='approved' THEN 'approved' ELSE 'in_review' END,updated_at=now() WHERE id=p.id;
  RETURN outrow;
END $$;
REVOKE ALL ON FUNCTION decide_channel_revision(uuid,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION decide_channel_revision(uuid,uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION export_manual_channel_package(p_post_id uuid,p_revision_id uuid)
RETURNS channel_manual_packages LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE p channel_posts; r channel_post_revisions; c channels; pkg jsonb; outrow channel_manual_packages;
BEGIN
  SELECT * INTO p FROM channel_posts WHERE id=p_post_id AND is_account_member(account_id,'admin') FOR UPDATE;
  SELECT * INTO r FROM channel_post_revisions WHERE id=p_revision_id AND post_id=p_post_id;
  SELECT * INTO c FROM channels WHERE id=p.channel_id AND account_id=p.account_id;
  IF p.id IS NULL OR c.id IS NULL OR p.status <> 'approved' THEN RAISE EXCEPTION 'approved_post_required'; END IF;
  IF r.id IS NULL OR r.revision <> p.current_revision THEN RAISE EXCEPTION 'current_revision_required'; END IF;
  IF c.provider<>'manual' THEN RAISE EXCEPTION 'manual_provider_only'; END IF;
  IF position('@newsletter' in lower(c.target))>0 THEN RAISE EXCEPTION 'newsletter_target_forbidden'; END IF;
  IF NOT EXISTS(SELECT 1 FROM channel_post_approvals a WHERE a.post_id=p.id AND a.revision_id=r.id AND a.decision='approved') THEN RAISE EXCEPTION 'approval_required'; END IF;
  pkg:=jsonb_build_object('provider','manual','channel',c.name,'target',c.target,'post_id',p.id,'revision',r.revision,'content_hash',r.content_hash,'title',r.title,'body',r.body,'metadata',r.metadata);
  INSERT INTO channel_manual_packages(account_id,post_id,revision_id,package_hash,package_payload,exported_by)
  VALUES(p.account_id,p.id,r.id,encode(digest(pkg::text,'sha256'),'hex'),pkg,auth.uid()) RETURNING * INTO outrow;
  UPDATE channel_posts SET status='exported',updated_at=now() WHERE id=p.id; RETURN outrow;
END $$;
REVOKE ALL ON FUNCTION export_manual_channel_package(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION export_manual_channel_package(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION confirm_manual_channel_publish(
  p_post_id uuid,p_package_id uuid,p_confirmation text,p_external_reference text DEFAULT NULL,p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS channel_publish_evidence LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE p channel_posts; r channel_post_revisions; pkg channel_manual_packages; outrow channel_publish_evidence;
BEGIN
  SELECT * INTO p FROM channel_posts WHERE id=p_post_id AND is_account_member(account_id,'admin') FOR UPDATE;
  IF NOT FOUND OR p.status <> 'exported' THEN RAISE EXCEPTION 'exported_post_required'; END IF;
  IF length(trim(COALESCE(p_confirmation,''))) < 5 THEN RAISE EXCEPTION 'human_confirmation_required'; END IF;
  SELECT * INTO r FROM channel_post_revisions WHERE post_id=p.id AND revision=p.current_revision;
  SELECT * INTO pkg FROM channel_manual_packages WHERE id=p_package_id AND post_id=p.id AND account_id=p.account_id;
  IF pkg.id IS NULL OR r.id IS NULL OR pkg.revision_id <> r.id THEN RAISE EXCEPTION 'current_export_package_required'; END IF;
  IF pkg.package_payload ->> 'provider' <> 'manual' OR position('@newsletter' in lower(COALESCE(pkg.package_payload ->> 'target','')))>0
    THEN RAISE EXCEPTION 'manual_package_required'; END IF;
  INSERT INTO channel_publish_evidence(account_id,post_id,package_id,confirmation,external_reference,evidence,confirmed_by)
  VALUES(p.account_id,p.id,pkg.id,trim(p_confirmation),nullif(trim(p_external_reference),''),COALESCE(p_evidence,'{}'::jsonb),auth.uid())
  RETURNING * INTO outrow;
  UPDATE channel_posts SET status='confirmed',updated_at=now() WHERE id=p.id;
  RETURN outrow;
END $$;
REVOKE ALL ON FUNCTION confirm_manual_channel_publish(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION confirm_manual_channel_publish(uuid,uuid,text,text,jsonb) TO authenticated;
