import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
    .replace(/\s+/g, ' ')
    .toLowerCase();

describe('P2 tenant-integrity contracts', () => {
  it('048 binds agents, WhatsApp configs and departments inside one account', () => {
    const sql = migration('048_specialized_ai_agents.sql');
    expect(sql).toContain('unique (account_id, id)');
    expect(sql).toContain(
      'foreign key (account_id, whatsapp_config_id) references whatsapp_config(account_id, id)',
    );
    expect(sql).toContain(
      'foreign key (account_id, department_id) references departments(account_id, id)',
    );
  });

  it('050 keeps every Channels parent/child reference account-scoped', () => {
    const sql = migration('050_manual_assisted_channels.sql');
    for (const relationship of [
      'foreign key (account_id, department_id) references departments(account_id, id)',
      'foreign key (account_id, channel_id) references channels(account_id, id)',
      'foreign key (account_id, post_id) references channel_posts(account_id, id)',
      'foreign key (account_id, revision_id) references channel_post_revisions(account_id, id)',
      'foreign key (account_id, package_id) references channel_manual_packages(account_id, id)',
    ]) {
      expect(sql).toContain(relationship);
    }
  });
});
