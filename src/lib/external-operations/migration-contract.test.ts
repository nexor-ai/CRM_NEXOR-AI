import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../../supabase/migrations/045_external_operations_outbox.sql', import.meta.url), 'utf8');

describe('045 external operations outbox migration contract', () => {
  it('defines tenant-scoped idempotency, statuses, leases and sanitized audit fields', () => {
    expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? public\.external_operations/i);
    expect(sql).toMatch(/UNIQUE\s*\(account_id,\s*operation_type,\s*idempotency_key\)/i);
    for (const status of ['pending', 'processing', 'succeeded', 'failed', 'uncertain', 'cancelled']) {
      expect(sql).toContain(`'${status}'`);
    }
    for (const field of ['attempts', 'max_attempts', 'fencing_token', 'transport_id', 'last_error', 'requested_by']) {
      expect(sql).toMatch(new RegExp(`\\b${field}\\b`, 'i'));
    }
  });

  it('uses fenced SKIP LOCKED service-role RPCs with fixed search_path and minimum grants', () => {
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    for (const fn of ['enqueue_external_operation', 'claim_external_operations', 'finalize_external_operation', 'retry_external_operation']) {
      expect(sql).toMatch(new RegExp(`SECURITY DEFINER[\\s\\S]*?SET search_path = public, pg_temp[\\s\\S]*?${fn}|${fn}[\\s\\S]*?SECURITY DEFINER[\\s\\S]*?SET search_path = public, pg_temp`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]*?FROM PUBLIC, anon, authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?TO service_role`, 'i'));
    }
    expect(sql).toMatch(/status = 'processing'[\s\S]*fencing_token/i);
  });

  it('rejects cross-account references and scopes manual retry to the account', () => {
    expect(sql).toMatch(/whatsapp_config_id_arg[\s\S]*?whatsapp_config[\s\S]*?account_id = account_id_arg/i);
    expect(sql).toMatch(/conversation_id_arg[\s\S]*?conversations[\s\S]*?account_id = account_id_arg/i);
    expect(sql).toMatch(/message_id_arg[\s\S]*?messages[\s\S]*?conversations[\s\S]*?account_id = account_id_arg/i);
    expect(sql).toMatch(/retry_external_operation[\s\S]*?WHERE id = operation_id_arg[\s\S]*?AND account_id = account_id_arg/i);
  });

  it('keeps raw payload inaccessible to normal users and provides aggregate-only reliability RPC', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.external_operations FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/external_operations_reliability_counts/i);
    expect(sql).not.toMatch(/GRANT SELECT ON TABLE public\.external_operations TO authenticated/i);
  });
});
