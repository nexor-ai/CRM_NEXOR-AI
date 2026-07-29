-- Stub do Supabase Storage: no projeto real esse schema é provido pelo serviço
-- de Storage, não pelo banco.
--
-- As colunas espelham o schema real do Supabase, não o mínimo para uma
-- migration específica. A versão anterior tinha só o necessário para a 044 —
-- o suficiente enquanto o harness só aplicava 044..050 sobre um dump do 043,
-- mas insuficiente para provar uma INSTALAÇÃO LIMPA (001..050), que é o que
-- todo cliente novo executa. A 008 usa file_size_limit e allowed_mime_types;
-- sem elas o teste de instalação limpa parava na oitava migration.
CREATE SCHEMA IF NOT EXISTS storage;
-- Na imagem oficial o schema pertence a supabase_storage_admin.

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean NOT NULL DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text NOT NULL,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb,
  path_tokens text[],
  version text,
  owner_id text
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
