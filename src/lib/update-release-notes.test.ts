import { describe, expect, it } from 'vitest';
import {
  formatReleaseDate,
  buildGenericReleaseNote,
  type RemoteUpdate,
} from './update-release-notes';

const remote: RemoteUpdate = {
  version: '0.9.0',
  tag: 'v0.9.0',
  name: 'NEXOR CRM v0.9.0',
  changelog: '- Canais manuais\n- Transcrição assíncrona\n',
  publishedAt: '2026-07-28',
  url: 'https://github.com/nexor-ai/CRM_NEXOR-AI/releases/tag/v0.9.0',
};

describe('formatReleaseDate', () => {
  it('formata como data de calendário, sem virada de dia por UTC', () => {
    expect(formatReleaseDate('2026-07-25')).toBe('25/07/2026');
  });
});

describe('buildGenericReleaseNote', () => {
  it('converte o corpo da release em bullets', () => {
    const note = buildGenericReleaseNote(remote);
    expect(note.version).toBe('0.9.0');
    expect(note.date).toBe('2026-07-28');
    expect(note.changes).toEqual([
      'Canais manuais',
      'Transcrição assíncrona',
    ]);
  });

  it('cai num texto padrão quando a release não tem corpo', () => {
    const note = buildGenericReleaseNote({ ...remote, changelog: '' });
    expect(note.changes).toHaveLength(1);
    expect(note.changes[0]).toContain('0.9.0');
  });
});
