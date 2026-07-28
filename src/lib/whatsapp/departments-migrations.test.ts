import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');
}

describe('046 departments and multi-instance foundation contract', () => {
  it('creates departments, memberships and exactly one default department per account', () => {
    const sql = migration('046_departments_multi_instance_foundation.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS departments/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS department_memberships/i);
    expect(sql).toMatch(/departments_one_default_per_account/i);
    expect(sql).toMatch(/INSERT INTO departments[\s\S]*ORDER BY/i);
    expect(sql).toMatch(/ON CONFLICT/i);
  });

  it('adds department/config snapshots to runtime tables idempotently', () => {
    const sql = migration('046_departments_multi_instance_foundation.sql');
    for (const table of [
      'whatsapp_config',
      'conversations',
      'flow_runs',
      'automation_logs',
      'automation_pending_executions',
      'broadcast_recipients',
    ]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${table}[\\s\\S]*ADD COLUMN IF NOT EXISTS department_id`, 'i'));
    }
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS whatsapp_config_id/i);
    expect(sql).toMatch(/to_regclass\('public\.broadcast_jobs'\)/i);
  });

  it('maintains default membership for signup, redeem and member reset paths', () => {
    const sql = migration('046_departments_multi_instance_foundation.sql');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.ensure_default_department_membership/i);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF account_id ON profiles/i);
    expect(sql).toMatch(/OLD\.account_id IS DISTINCT FROM NEW\.account_id/i);
    expect(sql).toMatch(/ON CONFLICT \(department_id, user_id\) DO NOTHING/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.ensure_default_department_membership/i);
  });

  it('binds webhook identity to the config rather than an account-wide guess', () => {
    const sql = migration('046_departments_multi_instance_foundation.sql');
    expect(sql).toMatch(/webhook_identity UUID/i);
    expect(sql).toMatch(/webhook_secret_hash TEXT/i);
    expect(sql).toMatch(/whatsapp_config_webhook_identity_key/i);
  });
});

describe('047 multi-instance cutover contract', () => {
  it('removes account-wide uniqueness only after explicit ambiguity preflight', () => {
    const sql = migration('047_multi_instance_cutover.sql');
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key/i);
    expect(sql).toMatch(/DROP INDEX IF EXISTS whatsapp_config_one_active_per_account/i);
    expect(sql).toMatch(/ambiguous_config/i);
  });

  it('enforces one default and active origin-instance identity per account', () => {
    const sql = migration('047_multi_instance_cutover.sql');
    expect(sql).toMatch(/whatsapp_config_one_default_per_account/i);
    expect(sql).toMatch(/whatsapp_config_active_origin_instance_key/i);
    expect(sql).toMatch(/account_id, provider, evolution_base_url, evolution_instance/i);
  });

  it('applies department-aware RLS while keeping admin global access', () => {
    const sql = migration('047_multi_instance_cutover.sql');
    expect(sql).toMatch(/can_access_department/i);
    expect(sql).toMatch(/is_account_member\([^)]*'admin'/i);
    expect(sql).toMatch(/CREATE POLICY conversations_select_department/i);
    expect(sql).toMatch(/CREATE POLICY whatsapp_config_select_department/i);
  });
});
