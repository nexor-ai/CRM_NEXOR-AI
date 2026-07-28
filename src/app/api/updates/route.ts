import { NextResponse } from 'next/server';
import { normalizeVersion } from '@/lib/app-version';

export const dynamic = 'force-dynamic';

const REPO = 'nexor-ai/CRM_NEXOR-AI';
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_TTL_MS = 15 * 60_000;

interface LatestRelease {
  version: string;
  tag: string;
  name: string;
  changelog: string;
  publishedAt: string;
  url: string;
}

let cache: { data: LatestRelease; expiresAt: number } | null = null;

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'NEXOR-CRM-update-checker',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.data);
  }

  try {
    const res = await fetch(RELEASE_URL, {
      headers: buildHeaders(),
      cache: 'no-store',
    });

    if (!res.ok) {
      // Rate limit ou indisponibilidade: serve o cache vencido, se houver.
      if (cache) return NextResponse.json(cache.data);
      return NextResponse.json(
        { error: 'Não foi possível consultar atualizações agora.' },
        { status: 503 }
      );
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
    if (!tag) {
      return NextResponse.json(
        { error: 'Repositório sem releases publicadas.' },
        { status: 404 }
      );
    }

    const data: LatestRelease = {
      version: normalizeVersion(tag),
      tag,
      name:
        typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : tag,
      changelog: typeof payload.body === 'string' ? payload.body.trim() : '',
      publishedAt:
        typeof payload.published_at === 'string'
          ? payload.published_at.slice(0, 10)
          : new Date().toISOString().slice(0, 10),
      url:
        typeof payload.html_url === 'string' && payload.html_url.trim()
          ? payload.html_url.trim()
          : `https://github.com/${REPO}/releases/tag/${tag}`,
    };

    cache = { data, expiresAt: now + CACHE_TTL_MS };
    return NextResponse.json(data);
  } catch {
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json(
      { error: 'Falha ao consultar atualizações no GitHub.' },
      { status: 503 }
    );
  }
}
