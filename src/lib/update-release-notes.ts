export interface RemoteUpdate {
  version: string;
  tag: string;
  name: string;
  changelog: string;
  publishedAt: string;
  url: string;
}

export interface ReleaseNote {
  version: string;
  date: string;
  changes: string[];
  breaking?: boolean;
}

/** Espelha o payload de /api/updates: comparação por commit, não por release. */
export interface UpdateStatus {
  updateAvailable: boolean;
  behindBy: number;
  localCommit: string;
  remoteCommit: string;
  changes: string[];
  publishedAt: string;
  url: string;
}

/** Limite de itens listados no modal, para o diálogo não virar um `git log`. */
const MAX_LISTED_CHANGES = 8;

export function buildCommitUpdateNote(status: UpdateStatus): ReleaseNote {
  const plural = status.behindBy === 1 ? 'atualização' : 'atualizações';
  const listed = status.changes.slice(0, MAX_LISTED_CHANGES);
  const remaining = status.changes.length - listed.length;
  const changes = listed.length
    ? [...listed, ...(remaining > 0 ? [`… e mais ${remaining}.`] : [])]
    : [`${status.behindBy} ${plural} disponíveis no repositório.`];

  return {
    version: `${status.behindBy} ${plural} pendentes`,
    date: status.publishedAt.slice(0, 10),
    changes,
    breaking: false,
  };
}


export function formatReleaseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

export function buildGenericReleaseNote(remote: RemoteUpdate): ReleaseNote {
  const changes = parseChangelogToBullets(remote.changelog);
  return {
    version: remote.version,
    date: remote.publishedAt.slice(0, 10),
    changes: changes.length
      ? changes
      : [`Nova versão ${remote.version} disponível.`],
    breaking: false,
  };
}

function parseChangelogToBullets(changelog: string): string[] {
  if (!changelog.trim()) return [];
  const lines = changelog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bullets: string[] = [];
  for (const line of lines) {
    const normalized = line.replace(/^[-*\s]+/, '').trim();
    if (!normalized) continue;
    if (normalized.length <= 180) {
      bullets.push(normalized);
    } else {
      bullets.push(normalized.slice(0, 177) + '...');
    }
    if (bullets.length >= 12) break;
  }
  return bullets.slice(0, 8);
}
