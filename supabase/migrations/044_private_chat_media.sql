-- ============================================================
-- 044_private_chat_media.sql
--
-- Security hardening for migration 023's chat-media bucket.
-- Existing object paths are account-scoped as:
--   account-<account_id>/...
--
-- This additive migration makes the bucket private and replaces the
-- public/global read policy with authenticated account-scoped CRUD.
-- service_role is intentionally not named or constrained here; Supabase's
-- service role continues to bypass Storage RLS for trusted webhook workers.
-- ============================================================

UPDATE storage.buckets
SET public = FALSE
WHERE id = 'chat-media';

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;

DROP POLICY IF EXISTS "Account members can read chat media" ON storage.objects;
CREATE POLICY "Account members can read chat media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Account members can upload chat media" ON storage.objects;
CREATE POLICY "Account members can upload chat media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Account members can update chat media" ON storage.objects;
CREATE POLICY "Account members can update chat media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  )
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Account members can delete chat media" ON storage.objects;
CREATE POLICY "Account members can delete chat media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
