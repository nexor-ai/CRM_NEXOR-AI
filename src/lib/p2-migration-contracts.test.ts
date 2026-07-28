import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');

describe('P2 migrations 048-050', () => {
  it('048 defines scoped agents, deterministic routing, atomic budget claim and fenced finalization', () => {
    const sql = migration('048_specialized_ai_agents.sql');
    for (const table of ['ai_agents', 'ai_agent_bindings', 'conversation_agent_state', 'ai_agent_runs', 'ai_agent_events']) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toMatch(/sticky[\s\S]*config_department[\s\S]*config[\s\S]*department[\s\S]*default/i);
    expect(sql).toContain('claim_ai_agent_budget');
    expect(sql).toMatch(/p_route_source text[\s\S]*INSERT INTO ai_agent_runs[\s\S]*p_route_source/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION finish_ai_agent_run\([\s\S]*p_account_id uuid[\s\S]*p_run_id uuid[\s\S]*p_expected_status text[\s\S]*p_status text/i);
    expect(sql).toMatch(/p_status NOT IN \('generated', 'sent', 'handoff', 'failed'\)/i);
    expect(sql).toMatch(/WHERE id = p_run_id[\s\S]*AND account_id = p_account_id[\s\S]*AND status = p_expected_status/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION finish_ai_agent_run[\s\S]*FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION finish_ai_agent_run[\s\S]*TO service_role/i);
    expect(sql).toContain('andersonmenttor@gmail.com');
    expect(sql).toContain('Agente de IA — Não configurado');
  });

  it('passes the resolved WhatsApp config id into the auto-reply dispatcher', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/whatsapp/webhook/route.ts'), 'utf8');
    expect(route).toMatch(/dispatchInboundToAiReply\(\{[\s\S]*whatsappConfigId:\s*config\.id[\s\S]*\}\)/);
  });

  it('049 defines a bounded SKIP LOCKED queue with stale recovery, retention and dead letters', () => {
    const sql = migration('049_async_transcription.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS transcription_jobs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS message_transcripts');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toMatch(/dead_letter/i);
    expect(sql).toMatch(/audio\/ogg/);
    expect(sql).toContain('consent_basis');
    expect(sql).toContain('retention_until');
    expect(sql).toContain('purge_expired_message_transcripts');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/i);
  });

  it('049 executes only tenant-scoped, audited, allowlisted recovery transitions', () => {
    const sql = migration('049_async_transcription.sql');
    expect(sql).toContain('execute_reliability_recovery_request');
    expect(sql).toContain("kind = 'transcription'");
    expect(sql).toContain("kind = 'external_operation'");
    expect(sql).toContain("kind = 'webhook_event'");
    expect(sql).toContain("kind = 'agent_run'");
    expect(sql).toContain("retry_policy = 'retry_safe'");
    expect(sql).toContain("status = 'dead_letter'");
    expect(sql).toContain("status IN ('claimed', 'generated', 'awaiting_approval')");
    expect(sql).toContain('processed_by');
    expect(sql).toContain('outcome');
    expect(sql).toMatch(/is_account_member\([^)]*admin/i);
  });

  it('050 keeps Channels manual-only with immutable hashed revisions and atomic human evidence', () => {
    const sql = migration('050_manual_assisted_channels.sql');
    for (const table of ['channels', 'channel_posts', 'channel_post_revisions', 'channel_post_approvals', 'channel_publish_evidence']) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql).toMatch(/provider[\s\S]*manual/i);
    expect(sql).toMatch(/digest|sha256/i);
    expect(sql).toMatch(/immutable|imutável/i);
    expect(sql).toMatch(/newsletter_target_forbidden|@newsletter/i);
    expect(sql).toContain('confirm_manual_channel_publish');
    expect(sql).toContain("p.status <> 'exported'");
    expect(sql).toContain('pkg.revision_id <> r.id');
    expect(sql).not.toMatch(/send(Text|Media)|@newsletter['"]\s*[,)]/i);
  });
});
