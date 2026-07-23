import { NextResponse } from 'next/server';

/**
 * Direct array fan-out is intentionally disabled. Campaigns must be persisted
 * and drained by /api/broadcasts/cron so the five-minute minimum cannot be
 * bypassed by an old client or integration.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        'Direct broadcast sending is disabled. Create a sequential campaign.',
      code: 'broadcast_direct_send_disabled',
      enqueue_endpoint: '/api/v1/broadcasts',
      minimum_interval_minutes: 5,
    },
    { status: 410 }
  );
}
