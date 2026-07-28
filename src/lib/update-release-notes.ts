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
