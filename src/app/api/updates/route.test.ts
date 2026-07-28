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
});
