export interface RemoteUpdate {
  version: string;
  release: string;
  name: string;
  changelog: string;
  publishedAt: string | null;
  url: string;
}

export interface ReleaseNote {
  version: string;
  date: string;
  changes: string[];
  breaking?: boolean;
}

const RELEASE_NOTES: Readonly<Record<string, ReleaseNote>> = {
  '0.8.0': {
    version: '0.8.0',
    date: '2026-07-25',
    changes: [
      '🔒 Corrigido: Envio de mensagens exige role "agent" (segurança)',
      '🔗 Adicionado: Fallback header x-evolution-webhook-token',
      '📍 Corrigido: Filtragem de mensagens @lid e @g.us no webhook',
      '✅ Botões Save/Test Connection funcionais no WhatsApp Config',
      '🚫 Removido: Gate de 24h bloqueando o composer',
      '📝 Atualizado: Template Manager - remove referências Meta',
      '🔔 Novo: Sistema de notificação de atualizações com Release Notes',
      '📋 Detalhes das correções e melhorias desta versão',
    ],
  },
  '0.8.0-beta': {
    version: '0.8.0-beta',
    date: '2026-07-24',
    changes: [
      '🔒 Corrigido: Envio de mensagens exige role "agent" (segurança)',
      '🔗 Adicionado: Fallback header x-evolution-webhook-token',
      '📍 Corrigido: Filtragem de mensagens @lid e @g.us no webhook',
      '✅ Botões Save/Test Connection funcionais no WhatsApp Config',
      '🚫 Removido: Gate de 24h bloqueando o composer',
      '📝 Atualizado: Template Manager - remove referências Meta',
    ],
  },
  '0.7.5': {
    version: '0.7.5',
    date: '2026-07-23',
    changes: ['Versão anterior - baseline Evolution API'],
  },
};

export function getReleaseNote(version: string): ReleaseNote | null {
  return RELEASE_NOTES[version] ?? null;
}

export function getUpdatePromptMode(
  version: string
): 'release-notes' | 'generic' {
  return getReleaseNote(version) ? 'release-notes' : 'generic';
}

export function formatReleaseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

export function buildGenericReleaseNote(
  remote: RemoteUpdate
): ReleaseNote {
  const changes = parseChangelogToBullets(remote.changelog);
  return {
    version: remote.version,
    date: remote.publishedAt ? remote.publishedAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
    changes: changes.length
      ? changes
      : [`Nova versão ${remote.version} disponível em ${remote.name}`],
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
