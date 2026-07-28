import { describe, expect, it } from 'vitest';
import { assertManualChannelAction, assertManualChannelTarget, createRevisionHash, verifyRevisionHash } from './manual-channel';

describe('Channels manual assistido', () => {
  it('produces a deterministic immutable revision hash', async () => {
    const a = await createRevisionHash({ title: 'Nota', body: 'Conteúdo', revision: 2 });
    const b = await createRevisionHash({ body: 'Conteúdo', revision: 2, title: 'Nota' });
    expect(a).toBe(b);
    expect(await verifyRevisionHash({ title: 'Nota', body: 'Conteúdo', revision: 2 }, a)).toBe(true);
    expect(await verifyRevisionHash({ title: 'Nota alterada', body: 'Conteúdo', revision: 2 }, a)).toBe(false);
  });

  it('fails closed for Evolution, auto publish and @newsletter targets', () => {
    expect(() => assertManualChannelTarget({ provider: 'manual', target: 'canal-interno', autoPublish: false })).not.toThrow();
    expect(() => assertManualChannelTarget({ provider: 'evolution', target: 'canal-interno', autoPublish: false })).toThrow('manual_provider_only');
    expect(() => assertManualChannelTarget({ provider: 'manual', target: '123@newsletter', autoPublish: false })).toThrow('newsletter_target_forbidden');
    expect(() => assertManualChannelTarget({ provider: 'manual', target: 'canal-interno', autoPublish: true })).toThrow('auto_publish_forbidden');
  });

  it('allows only immutable review, approval, export and human confirmation transitions', () => {
    expect(() => assertManualChannelAction('in_review', 'revise')).not.toThrow();
    expect(() => assertManualChannelAction('in_review', 'approve')).not.toThrow();
    expect(() => assertManualChannelAction('approved', 'export')).not.toThrow();
    expect(() => assertManualChannelAction('exported', 'confirm')).not.toThrow();
    expect(() => assertManualChannelAction('draft', 'export')).toThrow('channel_transition_forbidden');
    expect(() => assertManualChannelAction('approved', 'confirm')).toThrow('channel_transition_forbidden');
    expect(() => assertManualChannelAction('confirmed', 'revise')).toThrow('channel_transition_forbidden');
    expect(() => assertManualChannelAction('exported', 'publish')).toThrow('channel_action_forbidden');
  });
});
