import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = (name: string) =>
  readFileSync(join(root, 'supabase/migrations', name), 'utf8');

describe('upstream hardening P0/P1', () => {
  it('pins production dependency floors for disclosed vulnerabilities', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(packageJson.dependencies.undici).toBe('^7.29.0');
    expect(packageJson.overrides.nanoid).toBe('^3.3.18');
  });

  it('quarantines stale broadcast claims instead of retrying an uncertain send', () => {
    const sql = migration('051_broadcast_stale_claim_recovery.sql');
    expect(sql).toContain("status = 'processing'");
    expect(sql).toContain("status = 'uncertain'");
    expect(sql).toContain("processing_started_at < p_now - INTERVAL '30 minutes'");
    // Recovery quarantines uncertainty; the next claim remains pending-only.
    expect(sql).toContain("WHERE br.broadcast_id = v_b.id AND br.status = 'pending'");
    expect(sql).not.toContain("br.status IN ('pending', 'uncertain')");
    expect(sql).toContain('WHERE br.id = v_r.id');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION claim_next_broadcast_recipient[\s\S]*FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION claim_next_broadcast_recipient[\s\S]*TO service_role/i);
  });
});
