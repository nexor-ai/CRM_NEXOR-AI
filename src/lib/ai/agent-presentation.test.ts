import { describe, expect, it } from 'vitest';
import {
  agentDisplayName,
  isAndersonMenttorProfile,
} from './agent-presentation';

describe('agent presentation isolation', () => {
  it('identifies Anderson Menttor by the exact profile email', () => {
    expect(isAndersonMenttorProfile('andersonmenttor@gmail.com')).toBe(true);
    expect(isAndersonMenttorProfile(' ANDERSONMENTTOR@gmail.com ')).toBe(true);
    expect(
      isAndersonMenttorProfile('contato.andersontechsolutions@gmail.com')
    ).toBe(false);
  });

  it('shows the NEXOR secretary name only for the configured Anderson Menttor profile', () => {
    expect(
      agentDisplayName({
        email: 'andersonmenttor@gmail.com',
        configured: true,
      })
    ).toBe('Secretária de IA NEXOR');

    expect(
      agentDisplayName({
        email: 'andersonmenttor@gmail.com',
        configured: false,
      })
    ).toBe('Agente de IA');

    expect(
      agentDisplayName({
        email: 'contato.andersontechsolutions@gmail.com',
        configured: true,
      })
    ).toBe('Agente de IA');
  });
});
