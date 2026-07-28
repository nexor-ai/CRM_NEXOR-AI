import { describe, expect, it } from 'vitest';

import { planWhatsAppConfigWrite, type ConfigWriteCandidate } from './config-write-plan';

const candidate = (id: string, accountId = 'account-a'): ConfigWriteCandidate => ({
  id,
  account_id: accountId,
  is_default: id === 'default',
});

describe('planWhatsAppConfigWrite', () => {
  it('updates only the explicitly selected config in an account with two instances', () => {
    expect(
      planWhatsAppConfigWrite([candidate('default'), candidate('sales')], {
        configId: 'sales',
        createNew: false,
      }),
    ).toEqual({ kind: 'update', config: candidate('sales') });
  });

  it('fails closed when the selected config is outside the scoped account candidates', () => {
    expect(() =>
      planWhatsAppConfigWrite([candidate('default')], {
        configId: 'foreign-config',
        createNew: false,
      }),
    ).toThrowError('config_not_found');
  });

  it('creates without selecting or overwriting the current default', () => {
    expect(
      planWhatsAppConfigWrite([candidate('default'), candidate('sales')], {
        configId: null,
        createNew: true,
      }),
    ).toEqual({ kind: 'create' });
  });

  it('keeps legacy one-instance POST compatible', () => {
    expect(
      planWhatsAppConfigWrite([candidate('only')], {
        configId: null,
        createNew: false,
      }),
    ).toEqual({ kind: 'update', config: candidate('only') });
  });

  it('fails closed for a legacy POST when multiple instances exist', () => {
    expect(() =>
      planWhatsAppConfigWrite([candidate('default'), candidate('sales')], {
        configId: null,
        createNew: false,
      }),
    ).toThrowError('ambiguous_config');
  });
});
