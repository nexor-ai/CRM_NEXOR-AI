import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = global.fetch;
const LOCAL = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);

/** Resposta do endpoint compare do GitHub: base=commit local, head=branch. */
function comparePayload(aheadBy: number) {
  return {
    ahead_by: aheadBy,
    commits: Array.from({ length: aheadBy }, (_, index) => ({
      sha: index === aheadBy - 1 ? REMOTE : `c${index}`.padEnd(40, '0'),
      commit: {
        message: `feat: mudança ${index + 1}\n\ncorpo ignorado`,
        author: { date: '2026-07-28T01:39:35Z' },
      },
    })),
  };
}

function okResponse(aheadBy: number) {
  return new Response(JSON.stringify(comparePayload(aheadBy)), { status: 200 });
}

describe('GET /api/updates', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GITHUB_TOKEN;
    // Evita depender do git da máquina de teste.
    process.env.NEXT_PUBLIC_APP_COMMIT = LOCAL;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.NEXT_PUBLIC_APP_COMMIT;
    vi.restoreAllMocks();
  });

  it('avisa quando o repositório está à frente desta instalação', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(3));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updateAvailable).toBe(true);
    expect(body.behindBy).toBe(3);
    expect(body.remoteCommit).toBe(REMOTE);
    // Mais recente primeiro, e só o assunto — nunca o corpo do commit.
    expect(body.changes[0]).toBe('feat: mudança 3');
    expect(body.changes).toHaveLength(3);
    expect(body.changes.join(' ')).not.toContain('corpo ignorado');
  });

  it('NÃO avisa quem já está atualizado', async () => {
    global.fetch = vi.fn().mockResolvedValue(okResponse(0)) as unknown as typeof fetch;

    const { GET } = await import('./route');
    const body = await (await GET()).json();

    expect(body.updateAvailable).toBe(false);
    expect(body.behindBy).toBe(0);
  });

  it('não avisa quando o commit local é desconhecido no remoto (404)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404 })) as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    // Instalação com commits locais: incomodar seria mentir sobre o que fazer.
    expect(res.status).toBe(200);
    expect(body.updateAvailable).toBe(false);
  });

  it('responde 503 quando não dá para identificar o commit local', async () => {
    delete process.env.NEXT_PUBLIC_APP_COMMIT;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    vi.doMock('node:child_process', () => ({
      execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
        cb(new Error('sem git')),
    }));

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('compara contra a branch e não exige token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(1));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    await GET();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/compare/${LOCAL}...main`);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('faz uma única chamada e serve do cache dentro do TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(2));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    await GET();
    await GET();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('envia Authorization quando GITHUB_TOKEN existe', async () => {
    process.env.GITHUB_TOKEN = 'token-de-teste';
    const fetchMock = vi.fn().mockResolvedValue(okResponse(1));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    await GET();

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-de-teste');
  });

  it('responde 503 sem quebrar quando o GitHub falha e não há cache', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 403 })) as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET();

    expect(res.status).toBe(503);
  });

  it('serve cache vencido em backoff quando resposta não é ok, sem nova chamada logo em seguida', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(okResponse(2));
      global.fetch = fetchMock as unknown as typeof fetch;

      const { GET } = await import('./route');

      await GET();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15 * 60_000 + 1);

      fetchMock.mockResolvedValue(new Response('', { status: 403 }));
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.behindBy).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const res2 = await GET();
      expect(res2.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('após o backoff de falha expirar, uma nova chamada de rede acontece', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(okResponse(2));
      global.fetch = fetchMock as unknown as typeof fetch;

      const { GET } = await import('./route');

      await GET();
      vi.advanceTimersByTime(15 * 60_000 + 1);

      fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
      await GET();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(15 * 60_000 + 1);

      fetchMock.mockResolvedValue(okResponse(2));
      const res = await GET();

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
