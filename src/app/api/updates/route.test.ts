import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = global.fetch;

function releasePayload() {
  return {
    tag_name: 'v0.9.0',
    name: 'NEXOR CRM v0.9.0',
    body: '- Canais manuais\n- Transcrição assíncrona',
    published_at: '2026-07-28T01:39:35Z',
    html_url: 'https://github.com/nexor-ai/CRM_NEXOR-AI/releases/tag/v0.9.0',
  };
}

describe('GET /api/updates', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('devolve a última release sem exigir token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releasePayload()), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.version).toBe('0.9.0');
    expect(body.tag).toBe('v0.9.0');
    expect(body.changelog).toContain('Canais manuais');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('faz uma única chamada à API do GitHub', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releasePayload()), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    await GET();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serve do cache na segunda chamada dentro do TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releasePayload()), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    await GET();
    await GET();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('envia Authorization quando GITHUB_TOKEN existe', async () => {
    process.env.GITHUB_TOKEN = 'token-de-teste';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(releasePayload()), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { GET } = await import('./route');
    await GET();

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-de-teste');
  });

  it('responde 503 sem quebrar quando o GitHub falha', async () => {
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
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(releasePayload()), { status: 200 })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const { GET } = await import('./route');

      // Popula o cache com sucesso.
      await GET();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Vence o TTL de 15 minutos.
      vi.advanceTimersByTime(15 * 60_000 + 1);

      // Próxima consulta ao GitHub falha (ex.: rate limit).
      fetchMock.mockResolvedValue(new Response('', { status: 403 }));
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.tag).toBe('v0.9.0');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Chamada imediatamente seguinte deve ser servida do cache (backoff),
      // sem nova ida à rede.
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
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(releasePayload()), { status: 200 })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const { GET } = await import('./route');

      // Popula o cache com sucesso e vence o TTL normal.
      await GET();
      vi.advanceTimersByTime(15 * 60_000 + 1);

      // Falha e serve cache vencido com backoff curto.
      fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
      await GET();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Avança além dos 15 minutos do TTL normal (bem além do backoff de 60s).
      vi.advanceTimersByTime(15 * 60_000 + 1);

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(releasePayload()), { status: 200 })
      );
      const res = await GET();

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
