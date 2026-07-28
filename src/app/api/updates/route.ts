import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const run = promisify(execFile);

const REPO = 'nexor-ai/CRM_NEXOR-AI';
const BRANCH = process.env.NEXOR_UPDATE_BRANCH?.trim() || 'main';
const CACHE_TTL_MS = 15 * 60_000;
const STALE_CACHE_BACKOFF_MS = 60_000;

export interface UpdateStatus {
  /** Falso sempre que já estamos em dia — o cliente não deve avisar ninguém. */
  updateAvailable: boolean;
  /** Quantos commits o repositório está à frente desta instalação. */
  behindBy: number;
  localCommit: string;
  remoteCommit: string;
  /** Assunto dos commits novos, do mais recente para o mais antigo. */
  changes: string[];
  publishedAt: string;
  url: string;
}

let cache: { data: UpdateStatus; expiresAt: number } | null = null;
let localCommitCache: string | null = null;

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'NEXOR-CRM-update-checker',
  };
  // Repositório é público: o token é opcional e só serve para elevar o rate
  // limit. Exigi-lo foi a causa raiz do 404 que clones limpos recebiam.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * O commit desta instalação. Preferimos a variável gravada no build porque ela
 * descreve o código que está REALMENTE rodando; o git só é consultado como
 * reserva. Se nenhum dos dois responder, não há como comparar e o chamador
 * silencia o aviso em vez de incomodar quem talvez já esteja em dia.
 */
async function resolveLocalCommit(): Promise<string | null> {
  const fromEnv = process.env.NEXT_PUBLIC_APP_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  if (localCommitCache) return localCommitCache;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      timeout: 5_000,
    });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
    localCommitCache = sha;
    return sha;
  } catch {
    return null;
  }
}

function serveStale(now: number) {
  if (cache) {
    cache = { ...cache, expiresAt: now + STALE_CACHE_BACKOFF_MS };
    return NextResponse.json(cache.data);
  }
  return null;
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.data);
  }

  const localCommit = await resolveLocalCommit();
  if (!localCommit) {
    return NextResponse.json(
      { error: 'Não foi possível identificar o commit desta instalação.' },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/compare/${localCommit}...${BRANCH}`,
      { headers: buildHeaders(), cache: 'no-store' }
    );

    if (!res.ok) {
      // 404 aqui significa commit local ausente do remoto — instalação
      // modificada localmente ou branch privada. Não é erro do usuário e não
      // gera aviso: comparar seria mentir sobre o que ele precisa fazer.
      if (res.status === 404) {
        const data: UpdateStatus = {
          updateAvailable: false,
          behindBy: 0,
          localCommit,
          remoteCommit: '',
          changes: [],
          publishedAt: new Date().toISOString().slice(0, 10),
          url: `https://github.com/${REPO}`,
        };
        cache = { data, expiresAt: now + CACHE_TTL_MS };
        return NextResponse.json(data);
      }
      return (
        serveStale(now) ??
        NextResponse.json(
          { error: 'Não foi possível consultar atualizações agora.' },
          { status: 503 }
        )
      );
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const behindBy = typeof payload.ahead_by === 'number' ? payload.ahead_by : 0;
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const head = payload.commits && commits.length
      ? (commits[commits.length - 1] as Record<string, unknown>)
      : null;
    const remoteCommit =
      head && typeof head.sha === 'string' ? head.sha : localCommit;

    const changes = commits
      .map((entry) => {
        const commit = (entry as Record<string, unknown>).commit as
          | Record<string, unknown>
          | undefined;
        const message = typeof commit?.message === 'string' ? commit.message : '';
        return message.split('\n')[0].trim();
      })
      .filter((subject) => subject.length > 0)
      .reverse();

    const authored = (head?.commit as Record<string, unknown> | undefined)
      ?.author as Record<string, unknown> | undefined;

    const data: UpdateStatus = {
      updateAvailable: behindBy > 0,
      behindBy,
      localCommit,
      remoteCommit,
      changes,
      publishedAt:
        typeof authored?.date === 'string'
          ? authored.date.slice(0, 10)
          : new Date().toISOString().slice(0, 10),
      url: `https://github.com/${REPO}/compare/${localCommit.slice(0, 7)}...${BRANCH}`,
    };

    cache = { data, expiresAt: now + CACHE_TTL_MS };
    return NextResponse.json(data);
  } catch {
    return (
      serveStale(now) ??
      NextResponse.json(
        { error: 'Falha ao consultar atualizações no GitHub.' },
        { status: 503 }
      )
    );
  }
}
