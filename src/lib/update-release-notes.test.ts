import { describe, expect, it } from 'vitest';
import {
  formatReleaseDate,
  getReleaseNote,
  getUpdatePromptMode,
} from './update-release-notes';

describe('release note lookup', () => {
  it('returns the mapped release note for a known build', () => {
    expect(getReleaseNote('0.8.0')).toMatchObject({
      version: '0.8.0',
      date: '2026-07-25',
    });
  });

  it('selects the generic prompt when a build has no mapped release note', () => {
    expect(getReleaseNote('build-without-release-notes')).toBeNull();
    expect(getUpdatePromptMode('build-without-release-notes')).toBe('generic');
  });

  it('formats release dates as calendar dates without UTC day rollover', () => {
    expect(formatReleaseDate('2026-07-25')).toBe('25/07/2026');
  });

  it('selects release notes for a mapped build', () => {
    expect(getUpdatePromptMode('0.8.0')).toBe(
      'release-notes'
    );
  });
});
