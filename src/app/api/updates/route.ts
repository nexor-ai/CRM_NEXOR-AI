import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';

export const dynamic = 'force-dynamic';

const REPO = 'nexor-ai/CRM_NEXOR-AI';
const API_BASE = 'https://api.github.com';

function resolveGitHubToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const stdout = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!stdout) return null;
    return stdout.split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

function githubHeaders(token: string | null) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'NEXOR-CRM-selfhosted-update-checker',
  };
  const bearer = token?.trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

async function safeJson(res: Response) {
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

function pickVersionFromCommit(commit: Record<string, unknown>) {
  const sha = typeof commit.sha === 'string' ? commit.sha.slice(0, 12) : null;
  const commitData = commit.commit as Record<string, unknown> | undefined;
  const authorData = (commitData?.author as Record<string, unknown> | undefined) ?? {};
  const message = typeof commitData?.message === 'string' ? commitData.message.split('\n')[0].trim() : '';
  const date = typeof authorData.date === 'string' ? authorData.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  if (!sha) return null;
  const title = message || `Commit ${sha}`;
  const truncated = title.length > 120 ? `${title.slice(0, 117)}...` : title;
  return {
    version: sha,
    release: sha,
    name: `Commit ${sha}`,
    changelog: truncated,
    publishedAt: date,
    url: `https://github.com/${REPO}/commit/${sha}`,
  };
}

export async function GET() {
  try {
    const token = resolveGitHubToken();
    const [owner, repo] = REPO.split('/');
    const [latestReleaseRes, tagsRes, commitsRes] = await Promise.all([
      fetch(`${API_BASE}/repos/${owner}/${repo}/releases/latest?per_page=1`, {
        headers: githubHeaders(token),
        next: { revalidate: 120 },
      }),
      fetch(`${API_BASE}/repos/${owner}/${repo}/tags?per_page=20`, {
        headers: githubHeaders(token),
        next: { revalidate: 120 },
      }),
      fetch(`${API_BASE}/repos/${owner}/${repo}/commits/develop?per_page=1`, {
        headers: githubHeaders(token),
        next: { revalidate: 120 },
      }),
    ]);

    const latestRelease = await safeJson(latestReleaseRes);
    const tags = await safeJson(tagsRes);
    const latestCommit = await safeJson(commitsRes);

    let preferred: { version: string; release: string; name: string; changelog: string; publishedAt: string; url: string } | null = null;

    if (latestRelease && typeof latestRelease === 'object' && latestRelease.tag_name) {
      preferred = {
        version: String(latestRelease.tag_name),
        release: String(latestRelease.tag_name),
        name: typeof latestRelease.name === 'string' && latestRelease.name.trim() ? latestRelease.name.trim() : String(latestRelease.tag_name),
        changelog: typeof latestRelease.body === 'string' ? latestRelease.body.trim() : '',
        publishedAt: typeof latestRelease.published_at === 'string' ? latestRelease.published_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
        url: typeof latestRelease.html_url === 'string' && latestRelease.html_url.trim() ? latestRelease.html_url.trim() : `https://github.com/${REPO}/releases/tag/${latestRelease.tag_name}`,
      };
    } else if (Array.isArray(tags) && tags.at(0)?.name) {
      const tag = tags[0];
      preferred = {
        version: String(tag.name),
        release: String(tag.name),
        name: String(tag.name),
        changelog: '',
        publishedAt: new Date().toISOString().slice(0, 10),
        url: `https://github.com/${REPO}/releases/tag/${tag.name}`,
      };
    } else if (latestCommit && typeof latestCommit === 'object') {
      preferred = pickVersionFromCommit(latestCommit as Record<string, unknown>) ?? null;
    }

    if (!preferred) {
      return NextResponse.json({ error: 'Sem releases, tags ou commits disponíveis no repositório.' }, { status: 404 });
    }

    return NextResponse.json(preferred, {
      headers: {
        'Cache-Control': 'public, max-age=120, must-revalidate',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Falha ao consultar atualizações no GitHub.' },
      { status: 502 }
    );
  }
}
