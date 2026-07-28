import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function readGitRevision(args) {
  try {
    return execFileSync('git', ['rev-parse', ...args], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');
const version = `${readGitRevision(['--short=12', 'HEAD']) || 'unknown'}-${timestamp}`;
const release = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
// SHA completo do código que está sendo compilado. É o que /api/updates compara
// com o HEAD do repositório para saber se ESTA instalação está atrasada — e é
// por isso que o aviso some sozinho depois do update.sh, sem estado nenhum.
const commit = readGitRevision(['HEAD']);

console.log(`[build] NEXOR CRM version ${version} (commit ${commit || 'desconhecido'})`);

const result = spawnSync('next', ['build'], {
  env: {
    ...process.env,
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_APP_RELEASE: release,
    ...(commit ? { NEXT_PUBLIC_APP_COMMIT: commit } : {}),
  },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
