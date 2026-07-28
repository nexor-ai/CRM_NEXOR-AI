import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function readGitRevision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');
const version = `${readGitRevision()}-${timestamp}`;
const release = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

console.log(`[build] NEXOR CRM version ${version}`);

const result = spawnSync('next', ['build'], {
  env: {
    ...process.env,
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_APP_RELEASE: release,
  },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
