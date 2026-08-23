-- 052_global_evolution_remote_identity.sql
-- A physical Evolution instance may belong to only one active CRM tenant.
-- This prevents cross-tenant outbound traffic and webhook ownership collisions.

DO $$
DECLARE duplicate_identity TEXT;
BEGIN
  SELECT concat(provider, ':', evolution_base_url, ':', evolution_instance)
  INTO duplicate_identity
  FROM whatsapp_config
  WHERE disabled_at IS NULL
    AND provider = 'evolution'
    AND evolution_base_url IS NOT NULL
    AND evolution_instance IS NOT NULL
  GROUP BY provider, evolution_base_url, evolution_instance
  HAVING count(*) > 1
  LIMIT 1;
  IF duplicate_identity IS NOT NULL THEN
    RAISE EXCEPTION 'global Evolution identity collision: %', duplicate_identity;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_global_evolution_identity_key
  ON whatsapp_config(provider, evolution_base_url, evolution_instance)
  WHERE disabled_at IS NULL
    AND provider = 'evolution'
    AND evolution_base_url IS NOT NULL
    AND evolution_instance IS NOT NULL;
