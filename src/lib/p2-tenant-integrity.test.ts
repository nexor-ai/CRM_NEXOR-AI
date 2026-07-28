import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
    .replace(/\s+/g, ' ')
    .toLowerCase();

// Recorta o corpo de um CREATE TABLE para que cada asserção valha para a tabela
// certa: sem isso um `unique (account_id, id)` de outra tabela satisfaz o teste.
const tableBody = (sql: string, table: string) => {
  const start = new RegExp(`create table (if not exists )?(public\\.)?${table}\\s*\\(`).exec(sql);
  expect(start, `tabela ${table} nao encontrada`).not.toBeNull();
  const from = start!.index;
  const end = sql.indexOf(';', from);
  return sql.slice(from, end === -1 ? undefined : end);
};

const expectAll = (body: string, fragments: string[]) => {
  for (const fragment of fragments) expect(body).toContain(fragment);
};

describe('P2 tenant-integrity contracts', () => {
  it('045 escopa o outbox por conta e protege o ALTER com lock_timeout', () => {
    const sql = migration('045_external_operations_outbox.sql');
    expect(sql).toContain("set lock_timeout = '5s'");
    expect(sql).toContain('alter table public.%i add constraint %i unique (account_id, id)');
    expectAll(tableBody(sql, 'external_operations'), [
      'foreign key (account_id, whatsapp_config_id) references public.whatsapp_config(account_id, id) on delete set null (whatsapp_config_id)',
      'foreign key (account_id, conversation_id) references public.conversations(account_id, id) on delete set null (conversation_id)',
      // messages nao tem account_id: FK simples e o maximo possivel.
      'message_id uuid references public.messages(id) on delete set null',
    ]);
  });

  it('048 binds agents, WhatsApp configs and departments inside one account', () => {
    const sql = migration('048_specialized_ai_agents.sql');

    // Protecao contra apagao: o ALTER em conversations/whatsapp_config falha
    // rapido em vez de empilhar a fila de locks da tabela mais quente do CRM.
    expect(sql).toContain("set lock_timeout = '5s'");
    expect(sql).toContain('alter table public.%i add constraint %i unique (account_id, id)');
    expect(sql).toContain("('whatsapp_config', 'whatsapp_config_account_id_id_key')");
    expect(sql).toContain("('conversations', 'conversations_account_id_id_key')");
    expect(sql).toContain("('public.' || item.table_name)::regclass");

    expectAll(tableBody(sql, 'ai_agents'), ['unique (account_id, id)']);

    expectAll(tableBody(sql, 'ai_agent_bindings'), [
      'unique (account_id, id)',
      'foreign key (account_id, agent_id) references ai_agents(account_id, id) on delete cascade',
      'foreign key (account_id, whatsapp_config_id) references whatsapp_config(account_id, id) on delete cascade',
      'foreign key (account_id, department_id) references departments(account_id, id) on delete restrict',
    ]);

    expectAll(tableBody(sql, 'conversation_agent_state'), [
      'foreign key (account_id, conversation_id) references conversations(account_id, id) on delete cascade',
      'foreign key (account_id, sticky_agent_id) references ai_agents(account_id, id) on delete set null (sticky_agent_id)',
    ]);

    expectAll(tableBody(sql, 'ai_agent_runs'), [
      'unique (account_id, id)',
      'foreign key (account_id, agent_id) references ai_agents(account_id, id) on delete restrict',
      'foreign key (account_id, conversation_id) references conversations(account_id, id) on delete set null (conversation_id)',
      'foreign key (account_id, binding_id) references ai_agent_bindings(account_id, id) on delete set null (binding_id)',
    ]);

    expectAll(tableBody(sql, 'ai_agent_events'), [
      'foreign key (account_id, run_id) references ai_agent_runs(account_id, id) on delete cascade',
      'foreign key (account_id, agent_id) references ai_agents(account_id, id) on delete set null (agent_id)',
      'foreign key (account_id, conversation_id) references conversations(account_id, id) on delete set null (conversation_id)',
    ]);
  });

  it('049 impede que um job de transcricao atravesse contas', () => {
    const sql = migration('049_async_transcription.sql');

    expectAll(tableBody(sql, 'transcription_jobs'), [
      'unique (account_id, id)',
      'foreign key (account_id, conversation_id) references conversations(account_id, id) on delete cascade',
      'foreign key (account_id, whatsapp_config_id) references whatsapp_config(account_id, id) on delete set null (whatsapp_config_id)',
      'foreign key (account_id, department_id) references departments(account_id, id) on delete restrict',
      // messages nao tem account_id: FK simples e o maximo possivel.
      'message_id uuid not null references messages(id) on delete cascade',
    ]);

    expectAll(tableBody(sql, 'message_transcripts'), [
      'foreign key (account_id, job_id) references transcription_jobs(account_id, id) on delete cascade',
      'message_id uuid not null unique references messages(id) on delete cascade',
    ]);
  });

  it('050 keeps every Channels parent/child reference account-scoped', () => {
    const sql = migration('050_manual_assisted_channels.sql');

    expectAll(tableBody(sql, 'channels'), [
      'unique (account_id, id)',
      'foreign key (account_id, department_id) references departments(account_id, id) on delete restrict',
    ]);

    expectAll(tableBody(sql, 'channel_posts'), [
      'unique (account_id, id)',
      'foreign key (account_id, channel_id) references channels(account_id, id) on delete restrict',
      'foreign key (account_id, department_id) references departments(account_id, id) on delete restrict',
    ]);

    expectAll(tableBody(sql, 'channel_post_revisions'), [
      'unique (account_id, id)',
      'foreign key (account_id, post_id) references channel_posts(account_id, id) on delete cascade',
    ]);

    expectAll(tableBody(sql, 'channel_post_approvals'), [
      'foreign key (account_id, post_id) references channel_posts(account_id, id) on delete cascade',
      'foreign key (account_id, revision_id) references channel_post_revisions(account_id, id) on delete restrict',
    ]);

    expectAll(tableBody(sql, 'channel_manual_packages'), [
      'unique (account_id, id)',
      'foreign key (account_id, post_id) references channel_posts(account_id, id) on delete cascade',
      'foreign key (account_id, revision_id) references channel_post_revisions(account_id, id) on delete restrict',
    ]);

    expectAll(tableBody(sql, 'channel_publish_evidence'), [
      'foreign key (account_id, post_id) references channel_posts(account_id, id) on delete cascade',
      'foreign key (account_id, package_id) references channel_manual_packages(account_id, id) on delete restrict',
    ]);
  });
});
