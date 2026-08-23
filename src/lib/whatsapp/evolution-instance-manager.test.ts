import { describe, expect, it } from 'vitest';

import { normalizeEvolutionInstanceList } from './evolution-instance-manager';

describe('normalizeEvolutionInstanceList', () => {
  it('normalizes the Evolution v2 array response without exposing credentials', () => {
    expect(normalizeEvolutionInstanceList([
      { instance: { instanceName: 'NEXOR AI', state: 'open' } },
      { instance: { instanceName: 'Anderson Tech', state: 'close' } },
    ])).toEqual([
      { name: 'NEXOR AI', state: 'open' },
      { name: 'Anderson Tech', state: 'close' },
    ]);
  });

  it('accepts common wrappers and removes duplicate or nameless entries', () => {
    expect(normalizeEvolutionInstanceList({
      instances: [
        { instanceName: 'Sales', connectionStatus: 'connecting' },
        { instance: { instanceName: 'Sales', state: 'open' } },
        { instance: { state: 'open' } },
      ],
    })).toEqual([{ name: 'Sales', state: 'connecting' }]);
  });
});
