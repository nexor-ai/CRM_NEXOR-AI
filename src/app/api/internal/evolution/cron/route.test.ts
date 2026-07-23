import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  processEvolutionWebhook: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: vi.fn(() => ({
      update: mocks.update,
    })),
  }),
}));

vi.mock('@/app/api/whatsapp/webhook/route', () => ({
  processEvolutionWebhook: mocks.processEvolutionWebhook,
}));

import { GET } from './route';

function authorizedRequest() {
  return new Request('https://crm.test/api/internal/evolution/cron', {
    headers: { 'x-cron-secret': 'test-secret' },
  });
}

describe('Evolution inbox worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTOMATION_CRON_SECRET = 'test-secret';
    mocks.update.mockReturnValue({
      eq: vi.fn(async () => ({ error: null })),
    });
  });

  afterEach(() => {
    delete process.env.AUTOMATION_CRON_SECRET;
  });

  it('rejects an invalid cron secret before claiming work', async () => {
    const response = await GET(
      new Request('https://crm.test/api/internal/evolution/cron', {
        headers: { 'x-cron-secret': 'wrong-secret' },
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('uses the atomic failure RPC and reports a final dead-letter state', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'claim_evolution_webhook_events') {
        return {
          data: [{ id: 'event-1', attempts: 8, claim_token: 'lease-1', payload: { event: 'MESSAGES_UPSERT' } }],
          error: null,
        };
      }
      if (name === 'finish_evolution_webhook_event') {
        return { data: 'dead_letter', error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.processEvolutionWebhook.mockRejectedValue(new Error('processing failed'));

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      claimed: 1,
      processed: 0,
      failed: 1,
      dead_lettered: 1,
      state_write_failures: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('finish_evolution_webhook_event', {
      event_id_arg: 'event-1',
      claim_token_arg: 'lease-1',
      succeeded_arg: false,
      error_arg: 'processing failed',
    });
  });
});
