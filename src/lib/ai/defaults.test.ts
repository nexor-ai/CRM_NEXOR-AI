import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './defaults';

describe('buildSystemPrompt tenant isolation', () => {
  it('uses a neutral assistant identity when the account has no custom persona', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' });

    expect(prompt).toContain('assistente virtual da empresa');
    expect(prompt).not.toContain('NEXOR');
    expect(prompt).not.toContain('Secretária de IA');
  });

  it('adds the account-specific persona only through its stored prompt', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Você é a Secretária de IA da NEXOR AI.',
      mode: 'auto_reply',
    });

    expect(prompt).toContain('Você é a Secretária de IA da NEXOR AI.');
  });
});
