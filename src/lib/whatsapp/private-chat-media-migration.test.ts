import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  process.cwd(),
  'supabase',
  'migrations',
  '044_private_chat_media.sql'
);

function migration(): string {
  return readFileSync(migrationPath, 'utf8');
}

describe('private chat-media migration contract', () => {
  it('makes the existing bucket private without replacing migration 023', () => {
    const sql = migration();

    expect(sql).toMatch(
      /UPDATE\s+storage\.buckets[\s\S]*SET\s+public\s*=\s*FALSE[\s\S]*WHERE\s+id\s*=\s*'chat-media'/i
    );
    expect(sql).not.toMatch(/INSERT\s+INTO\s+storage\.buckets/i);
  });

  it('removes the public read policy and scopes authenticated CRUD to account paths', () => {
    const sql = migration();

    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects'
    );
    expect(sql).not.toMatch(
      /CREATE\s+POLICY\s+"Chat media is publicly readable"/i
    );
    expect(sql.match(/TO authenticated/gi)).toHaveLength(4);
    expect(sql.match(/auth\.uid\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(
      sql.match(
        /\('account-' \|\| p\.account_id::text\) = \(storage\.foldername\(name\)\)\[1\]/g
      )?.length
    ).toBeGreaterThanOrEqual(4);
  });

  it('does not revoke or constrain service_role storage access', () => {
    const sql = migration();

    expect(sql).not.toMatch(/REVOKE[\s\S]*service_role/i);
    expect(sql).not.toMatch(/TO\s+service_role/i);
  });
});
