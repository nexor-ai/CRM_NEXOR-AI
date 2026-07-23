import { describe, expect, it } from 'vitest';
import {
  BROADCAST_INTERVAL_OPTIONS,
  CAMPAIGN_TEMPLATE_PRESETS,
  estimateCampaignMinutes,
  normalizeBroadcastInterval,
} from './broadcast-campaign';

describe('sequential broadcast campaign rules', () => {
  it('never accepts an interval below five minutes', () => {
    expect(normalizeBroadcastInterval(0)).toBe(5);
    expect(normalizeBroadcastInterval(4)).toBe(5);
    expect(normalizeBroadcastInterval('2')).toBe(5);
  });

  it('keeps valid interval variations and caps one day', () => {
    expect(normalizeBroadcastInterval(10)).toBe(10);
    expect(normalizeBroadcastInterval(90)).toBe(90);
    expect(normalizeBroadcastInterval(9999)).toBe(1440);
    expect(BROADCAST_INTERVAL_OPTIONS.every((value) => value >= 5)).toBe(true);
  });

  it('estimates elapsed time between the first and final recipient', () => {
    expect(estimateCampaignMinutes(1, 5)).toBe(0);
    expect(estimateCampaignMinutes(100, 5)).toBe(495);
  });

  it('ships eight tenant-neutral presets with at least three variations', () => {
    expect(CAMPAIGN_TEMPLATE_PRESETS).toHaveLength(8);
    expect(
      new Set(CAMPAIGN_TEMPLATE_PRESETS.map((item) => item.slug)).size
    ).toBe(8);
    for (const preset of CAMPAIGN_TEMPLATE_PRESETS) {
      expect(preset.variations.length).toBeGreaterThanOrEqual(3);
      expect(preset.recommendedIntervalMinutes).toBeGreaterThanOrEqual(5);
    }
  });
});
