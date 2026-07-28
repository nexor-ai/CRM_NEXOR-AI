-- Stub do Supabase Storage: no projeto real esse schema é provido pelo serviço
-- de Storage, não pelo banco. Só o suficiente para a 044 exercitar suas policies.
CREATE SCHEMA IF NOT EXISTS storage;
-- Na imagem oficial o schema pertence a supabase_storage_admin.

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text NOT NULL,
  owner uuid
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/');
$$;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
-- O bucket criado lá na 023, que a 044 torna privado.
INSERT INTO storage.buckets(id, name, public)
VALUES ('chat-media', 'chat-media', true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE storage.buckets OWNER TO postgres;
ALTER TABLE storage.objects OWNER TO postgres;
GRANT CREATE, USAGE ON SCHEMA storage TO postgres;
