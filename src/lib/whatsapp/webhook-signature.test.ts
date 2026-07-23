import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evolutionWebhookTokenForScope,
  verifyEvolutionWebhookToken,
} from './webhook-signature';

describe('Evolution webhook token', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects query-string credentials', () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_TOKEN', 'secret');
    const token = evolutionWebhookTokenForScope('account-a');
    const req = new Request(`https://crm.test/api/whatsapp/webhook?token=${token}`);
    expect(verifyEvolutionWebhookToken(req)).toBe(false);
  });

  it('accepts a token derived for the declared account scope', () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_TOKEN', 'secret');
    const scope = 'account-a';
    const req = new Request('https://crm.test/api/whatsapp/webhook', {
      headers: {
        'x-wacrm-webhook-scope': scope,
        'x-wacrm-webhook-token': evolutionWebhookTokenForScope(scope),
      },
    });
    expect(verifyEvolutionWebhookToken(req)).toBe(true);
  });

  it('does not accept one account token for another scope', () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_TOKEN', 'secret');
    const req = new Request('https://crm.test/api/whatsapp/webhook', {
      headers: {
        'x-wacrm-webhook-scope': 'account-b',
        'x-wacrm-webhook-token': evolutionWebhookTokenForScope('account-a'),
      },
    });
    expect(verifyEvolutionWebhookToken(req)).toBe(false);
  });

  it('fails closed without configured root token', () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_TOKEN', '');
    const req = new Request('https://crm.test/api/whatsapp/webhook', {
      headers: { 'x-wacrm-webhook-scope': 'account-a', 'x-wacrm-webhook-token': 'x' },
    });
    expect(verifyEvolutionWebhookToken(req)).toBe(false);
  });
});
