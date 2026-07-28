import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => { class UnauthorizedError extends Error {} class ForbiddenError extends Error {} return { UnauthorizedError, ForbiddenError, getCurrentAccount: vi.fn(), requireRole: vi.fn() }; });
vi.mock('@/lib/auth/account', () => ({ ...mocks, toErrorResponse: (e: unknown) => Response.json({ error: e instanceof Error ? e.message : 'error' }, { status: e instanceof mocks.UnauthorizedError ? 401 : e instanceof mocks.ForbiddenError ? 403 : 500 }) }));
import { GET, POST } from './route';
describe('channels API auth', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns 401 without a session', async () => { mocks.getCurrentAccount.mockRejectedValue(new mocks.UnauthorizedError('Unauthorized')); expect((await GET()).status).toBe(401); });
  it('returns 403 before creating a channel', async () => { mocks.requireRole.mockRejectedValue(new mocks.ForbiddenError('Insufficient role')); const response = await POST(new Request('https://crm.test/api/channels', { method: 'POST', body: '{}' })); expect(response.status).toBe(403); });
});
