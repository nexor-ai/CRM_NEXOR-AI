import { describe, expect, it } from 'vitest';
import { shouldPromptForUpdate } from './app-version';

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
