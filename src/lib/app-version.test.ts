import { describe, expect, it } from 'vitest';
import {
  shouldPromptForUpdate,
  normalizeVersion,
  compareSemver,
  shouldPromptForRelease,
} from './app-version';

describe('shouldPromptForUpdate', () => {
  it('prompts when the deployed build differs from the browser build', () => {
    expect(shouldPromptForUpdate('build-a', 'build-b', null)).toBe(true);
  });

  it('does not prompt for the same or dismissed build', () => {
    expect(shouldPromptForUpdate('build-a', 'build-a', null)).toBe(false);
    expect(shouldPromptForUpdate('build-a', 'build-b', 'build-b')).toBe(false);
  });

  it('stays silent in development', () => {
    expect(shouldPromptForUpdate('development', 'build-b', null)).toBe(false);
    expect(shouldPromptForUpdate('build-a', 'development', null)).toBe(false);
  });
});

describe('normalizeVersion', () => {
  it('remove o prefixo v das tags do GitHub', () => {
    expect(normalizeVersion('v0.9.0')).toBe('0.9.0');
    expect(normalizeVersion('0.9.0')).toBe('0.9.0');
    expect(normalizeVersion('  v1.2.3  ')).toBe('1.2.3');
  });
});

describe('compareSemver', () => {
  it('ordena por major, minor e patch', () => {
    expect(compareSemver('0.9.0', '0.8.0')).toBe(1);
    expect(compareSemver('0.8.0', '0.9.0')).toBe(-1);
    expect(compareSemver('0.9.0', '0.9.0')).toBe(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.9.10', '0.9.9')).toBe(1);
  });

  it('trata o prefixo v de forma transparente', () => {
    expect(compareSemver('v0.9.0', '0.9.0')).toBe(0);
  });

  it('coloca pre-release abaixo do estável', () => {
    expect(compareSemver('0.9.0-beta', '0.9.0')).toBe(-1);
    expect(compareSemver('0.9.0', '0.9.0-beta')).toBe(1);
    expect(compareSemver('0.9.0-beta', '0.9.0-beta')).toBe(0);
  });
});

describe('shouldPromptForRelease', () => {
  it('avisa apenas quando a release remota é maior', () => {
    expect(shouldPromptForRelease('0.8.0', 'v0.9.0', null)).toBe(true);
  });

  it('não avisa quando o cliente já está na versão mais recente', () => {
    expect(shouldPromptForRelease('0.9.0', 'v0.9.0', null)).toBe(false);
  });

  it('não avisa quando a remota é anterior à local', () => {
    expect(shouldPromptForRelease('0.9.0', 'v0.8.0', null)).toBe(false);
  });

  it('respeita a versão dispensada pelo usuário', () => {
    expect(shouldPromptForRelease('0.8.0', 'v0.9.0', '0.9.0')).toBe(false);
  });

  it('fica em silêncio em desenvolvimento', () => {
    expect(shouldPromptForRelease('development', 'v0.9.0', null)).toBe(false);
    expect(shouldPromptForRelease('0.8.0', 'development', null)).toBe(false);
  });

  it('fica em silêncio quando a versão não é semver válida', () => {
    expect(shouldPromptForRelease('0.8.0', 'nightly', null)).toBe(false);
  });
});
