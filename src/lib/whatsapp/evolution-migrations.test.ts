import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function migration(name: string) {
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');
}

describe('Evolution Phase 1 migration contracts', () => {
  it('fails closed on duplicate conversations before enforcing the canonical key', () => {
    const sql = migration('040_evolution_webhook_inbox.sql');
    expect(sql.indexOf('IF EXISTS (')).toBeGreaterThan(-1);
    expect(sql.indexOf('IF EXISTS (')).toBeLessThan(
      sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_contact_unique')
    );
    expect(sql).toContain('duplicate (account_id, contact_id) rows require explicit audited consolidation');
    expect(sql).not.toContain('conversation_merge_map');
    expect(sql).not.toContain('DELETE FROM conversations');
    expect(sql).not.toContain('flow_sessions');
  });

  it('keeps one checkpoint table and grants effect claims only to service_role', () => {
    const sql = migration('042_evolution_hardening_consistency.sql');
    expect(sql).toContain('claim_evolution_message_effect');
    expect(sql).toContain('evolution_message_effects');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS evolution_webhook_effects');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION claim_evolution_message_effect\(UUID, UUID, TEXT, BOOLEAN\)[\s\S]*FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION claim_evolution_message_effect\(UUID, UUID, TEXT, BOOLEAN\)[\s\S]*TO service_role;/
    );
  });

  it('defines dead-letter as a terminal state and no authenticated SECURITY DEFINER read RPC', () => {
    const sql = migration('042_evolution_hardening_consistency.sql');
    expect(sql).toContain("'dead_letter'");
    expect(sql).toContain('finish_evolution_webhook_event');
    expect(sql).toContain('finish_evolution_message_effect');
    expect(sql).toContain('claim_token');
    expect(sql).toContain('account_id');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION mark_conversation_read_through');
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]{0,200}TO authenticated/);
  });
});
