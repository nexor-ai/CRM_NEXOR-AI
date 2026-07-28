# Canal de Atualização para Clones — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar tarefa a tarefa. Os passos usam checkbox (`- [ ]`) para rastreio.

**Spec:** `docs/plans/2026-07-27-canal-atualizacao-clones-design.md`

**Objetivo:** Fazer com que qualquer clone do NEXOR CRM, em qualquer servidor, seja avisado de novas versões e consiga instalar e atualizar sozinho com um comando.

**Arquitetura:** O repositório passa a ser público, e a fonte de verdade da versão passa a ser a tag semver da última Release do GitHub, comparada com `package.json.version` embutido no build. A rota `/api/updates` perde a dependência do `gh auth token` (que só existia na VPS de desenvolvimento) e ganha cache. O modal deixa de prometer um reload que não atualiza nada e passa a entregar um comando copiável que roda `scripts/update.sh`, com rollback automático.

**Stack:** Next.js 16.2.12 (App Router), React 19.2.4, TypeScript, Vitest, systemd user units, bash.

## Restrições Globais

- Node `>=20.0.0` (`package.json` → `engines`). O `install.sh` valida esse piso, não o v22 da VPS de desenvolvimento.
- Porta padrão de produção: **3010**, host `127.0.0.1`.
- Serviços: `wacrm.service` e `wacrm-worker.service`, systemd **user** units (`systemctl --user`, nunca `sudo systemctl`).
- Todo texto de interface em **português do Brasil**.
- Testes com **Vitest** (`npm run test`), arquivos `*.test.ts` ao lado do código.
- `AGENTS.md` do repositório determina: **este Next.js tem breaking changes em relação ao seu conhecimento prévio.** Antes de escrever qualquer rota ou componente, consulte `node_modules/next/dist/docs/` (existe: `01-app/`, `02-pages/`, `03-architecture/`, `04-community/`).
- Nunca commitar `.env`. Apenas `.env.local.example` é versionado.
- O repositório só se torna público **depois** que a release v0.9.0 existir.

---

### Task 1: Commitar a produção como baseline 0.9.0

Sem isso, tudo o mais é inútil: tornar o repositório público hoje publicaria a baseline 0.8.0 e o cliente continuaria clonando um produto sem 7 migrations e sem módulos inteiros.

**Arquivos:**
- Modificar: `package.json` (campo `version`)
- Commitar: 97 arquivos modificados + 51 não rastreados já existentes na VPS

**Interfaces:**
- Consome: nada.
- Produz: `package.json.version === "0.9.0"`, que a Task 2 e a Task 5 leem via `NEXT_PUBLIC_APP_RELEASE`.

- [ ] **Passo 1: Confirmar que nenhum arquivo sensível entrou**

```bash
git status --short | grep -iE "\.env($|\.)|\.pem$|\.key$|secret|credential"
```

Esperado: **saída vazia**. Se retornar qualquer linha, PARE e reporte antes de continuar.

- [ ] **Passo 2: Rodar a suíte antes de commitar**

```bash
npm run test
```

Esperado: suíte passa. Se houver falhas, anote quais e reporte — não corrija nesta task, elas podem ser pré-existentes.

- [ ] **Passo 3: Bump da versão**

Em `package.json`, alterar a linha 3:

```json
  "version": "0.9.0",
```

- [ ] **Passo 4: Commitar tudo**

```bash
git add -A
git commit -m "feat: NEXOR CRM 0.9.0 — canais, confiabilidade, agentes de IA, departamentos multi-instância, transcrição assíncrona

Inclui migrations 044 a 050 e módulos que estavam apenas na VPS de produção."
```

- [ ] **Passo 5: Verificar que a árvore ficou limpa**

```bash
git status --short
```

Esperado: **saída vazia**.

---

### Task 2: Comparação semver em `app-version.ts`

**Arquivos:**
- Modificar: `src/lib/app-version.ts`
- Testar: `src/lib/app-version.test.ts`

**Interfaces:**
- Consome: nada.
- Produz:
  - `normalizeVersion(value: string): string`
  - `compareSemver(a: string, b: string): number` — retorna `-1`, `0` ou `1`
  - `shouldPromptForRelease(current: string, available: string, dismissed: string | null): boolean`
  - `shouldPromptForUpdate` **inalterada** — a Task 5 continua usando para detectar rebuild.

- [ ] **Passo 1: Escrever os testes que falham**

Acrescentar ao final de `src/lib/app-version.test.ts`:

```typescript
import {
  shouldPromptForUpdate,
  normalizeVersion,
  compareSemver,
  shouldPromptForRelease,
} from './app-version';

describe('normalizeVersion', () => {
  it('remove o prefixo v das tags do GitHub', () => {
    expect(normalizeVersion('v0.9.0')).toBe('0.9.0');
    expect(normalizeVersion('0.9.0')).toBe('0.9.0');
    expect(normalizeVersion('  v1.2.3  ')).toBe('1.2.3');
  });
});

describe('compareSemver', () => {
  it('ordena por major, minor e patch', () => {
    expect(compareSemver('0.9.0', '0.8.0')).toBe(1);
    expect(compareSemver('0.8.0', '0.9.0')).toBe(-1);
    expect(compareSemver('0.9.0', '0.9.0')).toBe(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('0.9.10', '0.9.9')).toBe(1);
  });

  it('trata o prefixo v de forma transparente', () => {
    expect(compareSemver('v0.9.0', '0.9.0')).toBe(0);
  });

  it('coloca pre-release abaixo do estável', () => {
    expect(compareSemver('0.9.0-beta', '0.9.0')).toBe(-1);
    expect(compareSemver('0.9.0', '0.9.0-beta')).toBe(1);
    expect(compareSemver('0.9.0-beta', '0.9.0-beta')).toBe(0);
  });
});

describe('shouldPromptForRelease', () => {
  it('avisa apenas quando a release remota é maior', () => {
    expect(shouldPromptForRelease('0.8.0', 'v0.9.0', null)).toBe(true);
  });

  it('não avisa quando o cliente já está na versão mais recente', () => {
    expect(shouldPromptForRelease('0.9.0', 'v0.9.0', null)).toBe(false);
  });

  it('não avisa quando a remota é anterior à local', () => {
    expect(shouldPromptForRelease('0.9.0', 'v0.8.0', null)).toBe(false);
  });

  it('respeita a versão dispensada pelo usuário', () => {
    expect(shouldPromptForRelease('0.8.0', 'v0.9.0', '0.9.0')).toBe(false);
  });

  it('fica em silêncio em desenvolvimento', () => {
    expect(shouldPromptForRelease('development', 'v0.9.0', null)).toBe(false);
    expect(shouldPromptForRelease('0.8.0', 'development', null)).toBe(false);
  });

  it('fica em silêncio quando a versão não é semver válida', () => {
    expect(shouldPromptForRelease('0.8.0', 'nightly', null)).toBe(false);
  });
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
npm run test -- src/lib/app-version.test.ts
```

Esperado: FALHA com erro de import — `normalizeVersion`, `compareSemver` e `shouldPromptForRelease` não existem.

- [ ] **Passo 3: Implementar**

Acrescentar a `src/lib/app-version.ts`, mantendo `shouldPromptForUpdate` como está:

```typescript
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

/** Retorna 1 se a > b, -1 se a < b, 0 se equivalentes. NaN se alguma for inválida. */
export function compareSemver(a: string, b: string): number {
  const left = SEMVER_RE.exec(normalizeVersion(a));
  const right = SEMVER_RE.exec(normalizeVersion(b));
  if (!left || !right) return Number.NaN;

  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  const leftPre = left[4];
  const rightPre = right[4];
  if (leftPre === rightPre) return 0;
  // Ausência de pre-release é sempre maior: 0.9.0 > 0.9.0-beta
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return leftPre > rightPre ? 1 : -1;
}

export function shouldPromptForRelease(
  current: string,
  available: string,
  dismissed: string | null
): boolean {
  if (!current || !available) return false;
  if (current === 'development' || available === 'development') return false;
  if (dismissed && normalizeVersion(dismissed) === normalizeVersion(available)) {
    return false;
  }
  const result = compareSemver(available, current);
  return Number.isNaN(result) ? false : result > 0;
}
```

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
npm run test -- src/lib/app-version.test.ts
```

Esperado: PASSA, incluindo os testes pré-existentes de `shouldPromptForUpdate`.

- [ ] **Passo 5: Commitar**

```bash
git add src/lib/app-version.ts src/lib/app-version.test.ts
git commit -m "feat(update): comparação semver para releases, separada da detecção de rebuild"
```

---

### Task 3: Reescrever `/api/updates` sem `gh` e com cache

Esta é a correção da causa raiz: o `execFileSync('gh')` é o motivo de a notificação só funcionar na VPS de desenvolvimento.

**Arquivos:**
- Modificar: `src/app/api/updates/route.ts` (reescrita completa)
- Testar: `src/app/api/updates/route.test.ts` (criar)

**Interfaces:**
- Consome: `normalizeVersion` da Task 2.
- Produz: `GET /api/updates` respondendo `{ version, tag, name, changelog, publishedAt, url }`, consumido pela Task 5. `version` já vem normalizada (sem `v`).

- [ ] **Passo 1: Ler a documentação de Route Handlers**

Conforme `AGENTS.md`, antes de escrever a rota:

```bash
ls node_modules/next/dist/docs/01-app/
```

Localize e leia o guia de Route Handlers. Não assuma a API de memória.

- [ ] **Passo 2: Escrever os testes que falham**

Criar `src/app/api/updates/route.test.ts`:

```typescript
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
```

- [ ] **Passo 3: Rodar e confirmar que falha**

```bash
npm run test -- src/app/api/updates/route.test.ts
```

Esperado: FALHA — a rota atual chama `gh`, faz 3 requisições e não expõe `tag`.

- [ ] **Passo 4: Reescrever a rota**

Substituir todo o conteúdo de `src/app/api/updates/route.ts`:

```typescript
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
```

- [ ] **Passo 5: Rodar e confirmar que passa**

```bash
npm run test -- src/app/api/updates/route.test.ts
```

Esperado: PASSA, 5 testes.

- [ ] **Passo 6: Confirmar que `gh` sumiu do código**

```bash
grep -rn "execFileSync\|gh auth token" src/app/api/updates/
```

Esperado: **saída vazia**.

- [ ] **Passo 7: Commitar**

```bash
git add src/app/api/updates/route.ts src/app/api/updates/route.test.ts
git commit -m "fix(update): remover dependência do gh CLI e cachear consulta de release

A rota autenticava via 'gh auth token', o que só existia na VPS de
desenvolvimento. Em qualquer outra máquina a API respondia 404 e a
notificação nunca aparecia."
```

---

### Task 4: Release notes vindas do GitHub, não de mapa fixo

**Arquivos:**
- Modificar: `src/lib/update-release-notes.ts`
- Modificar: `src/lib/update-release-notes.test.ts`

**Interfaces:**
- Consome: o formato de resposta da Task 3.
- Produz: `RemoteUpdate` ganha o campo `tag: string`. `buildGenericReleaseNote(remote: RemoteUpdate): ReleaseNote` continua com a mesma assinatura. `getReleaseNote` e `getUpdatePromptMode` **deixam de existir** — a Task 5 não pode mais importá-las.

- [ ] **Passo 1: Reescrever os testes**

Substituir todo o conteúdo de `src/lib/update-release-notes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  formatReleaseDate,
  buildGenericReleaseNote,
  type RemoteUpdate,
} from './update-release-notes';

const remote: RemoteUpdate = {
  version: '0.9.0',
  tag: 'v0.9.0',
  name: 'NEXOR CRM v0.9.0',
  changelog: '- Canais manuais\n- Transcrição assíncrona\n',
  publishedAt: '2026-07-28',
  url: 'https://github.com/nexor-ai/CRM_NEXOR-AI/releases/tag/v0.9.0',
};

describe('formatReleaseDate', () => {
  it('formata como data de calendário, sem virada de dia por UTC', () => {
    expect(formatReleaseDate('2026-07-25')).toBe('25/07/2026');
  });
});

describe('buildGenericReleaseNote', () => {
  it('converte o corpo da release em bullets', () => {
    const note = buildGenericReleaseNote(remote);
    expect(note.version).toBe('0.9.0');
    expect(note.date).toBe('2026-07-28');
    expect(note.changes).toEqual([
      'Canais manuais',
      'Transcrição assíncrona',
    ]);
  });

  it('cai num texto padrão quando a release não tem corpo', () => {
    const note = buildGenericReleaseNote({ ...remote, changelog: '' });
    expect(note.changes).toHaveLength(1);
    expect(note.changes[0]).toContain('0.9.0');
  });
});
```

- [ ] **Passo 2: Rodar e confirmar que falha**

```bash
npm run test -- src/lib/update-release-notes.test.ts
```

Esperado: FALHA — `RemoteUpdate` ainda não tem `tag`.

- [ ] **Passo 3: Limpar o módulo**

Em `src/lib/update-release-notes.ts`:

1. Acrescentar `tag: string;` à interface `RemoteUpdate`, logo após `version`.
2. Alterar `publishedAt` de `string | null` para `string`.
3. **Excluir** a constante `RELEASE_NOTES` inteira (linhas 17–49), a função `getReleaseNote` e a função `getUpdatePromptMode`.
4. Simplificar `buildGenericReleaseNote`, já que `publishedAt` deixou de ser nulo:

```typescript
export function buildGenericReleaseNote(remote: RemoteUpdate): ReleaseNote {
  const changes = parseChangelogToBullets(remote.changelog);
  return {
    version: remote.version,
    date: remote.publishedAt.slice(0, 10),
    changes: changes.length
      ? changes
      : [`Nova versão ${remote.version} disponível.`],
    breaking: false,
  };
}
```

Manter `ReleaseNote`, `formatReleaseDate` e `parseChangelogToBullets` como estão.

- [ ] **Passo 4: Rodar e confirmar que passa**

```bash
npm run test -- src/lib/update-release-notes.test.ts
```

Esperado: PASSA.

- [ ] **Passo 5: Confirmar que ninguém mais importa o que foi removido**

```bash
grep -rn "getReleaseNote\|getUpdatePromptMode" src/
```

Esperado: só ocorrências em `src/components/app-update-prompt.tsx`, que a Task 5 corrige. Nenhuma outra.

- [ ] **Passo 6: Commitar**

```bash
git add src/lib/update-release-notes.ts src/lib/update-release-notes.test.ts
git commit -m "refactor(update): usar o corpo da release do GitHub em vez de mapa fixo"
```

---

### Task 5: Separar os dois avisos em `app-update-prompt.tsx`

Hoje "servidor reconstruído" e "release nova no GitHub" caem no mesmo modal, com o mesmo botão que só dá `reload()`.

**Arquivos:**
- Modificar: `src/components/app-update-prompt.tsx` (reescrita)

**Interfaces:**
- Consome: `shouldPromptForUpdate` e `shouldPromptForRelease` (Task 2), `GET /api/updates` (Task 3), `buildGenericReleaseNote` e `RemoteUpdate` (Task 4).
- Produz: renderiza `<UpdateReleaseNotes>` com a prop nova `updateCommand`, implementada na Task 6.

- [ ] **Passo 1: Reescrever o componente**

Substituir todo o conteúdo de `src/components/app-update-prompt.tsx`:

```typescript
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { shouldPromptForUpdate, shouldPromptForRelease } from '@/lib/app-version';
import { buildGenericReleaseNote, type RemoteUpdate } from '@/lib/update-release-notes';
import { Button } from '@/components/ui/button';
import { UpdateReleaseNotes } from '@/components/update-release-notes';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const CURRENT_BUILD = process.env.NEXT_PUBLIC_APP_VERSION ?? 'development';
const CURRENT_RELEASE = process.env.NEXT_PUBLIC_APP_RELEASE ?? 'development';
const DISMISSED_RELEASE_KEY = 'nexor-crm-dismissed-release';
const BUILD_CHECK_INTERVAL_MS = 60_000;
const RELEASE_CHECK_INTERVAL_MS = 30 * 60_000;
const UPDATE_COMMAND = 'bash scripts/update.sh';

export function AppUpdatePrompt() {
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [remote, setRemote] = useState<RemoteUpdate | null>(null);
  const lastReleaseCheck = useRef(0);

  // Evento 1: o servidor foi reconstruído. Recarregar a aba é a ação correta.
  const checkBuild = useCallback(async () => {
    try {
      const response = await fetch(`/api/version?ts=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as { version?: string };
      if (!payload.version) return;
      if (shouldPromptForUpdate(CURRENT_BUILD, payload.version, null)) {
        setRebuildOpen(true);
      }
    } catch {
      // Verificação de versão nunca pode interromper o fluxo do CRM.
    }
  }, []);

  // Evento 2: existe release nova no GitHub. Recarregar não resolve — precisa do script.
  const checkRelease = useCallback(async () => {
    const now = Date.now();
    if (now - lastReleaseCheck.current < RELEASE_CHECK_INTERVAL_MS) return;
    lastReleaseCheck.current = now;
    try {
      const response = await fetch('/api/updates', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = (await response.json()) as RemoteUpdate & { error?: string };
      if (!payload?.version || payload.error) return;
      const dismissed = window.localStorage.getItem(DISMISSED_RELEASE_KEY);
      if (shouldPromptForRelease(CURRENT_RELEASE, payload.version, dismissed)) {
        setRemote(payload);
      }
    } catch {
      // Falha de rede é silenciosa por design.
    }
  }, []);

  useEffect(() => {
    void checkBuild();
    void checkRelease();
    const buildTimer = window.setInterval(() => void checkBuild(), BUILD_CHECK_INTERVAL_MS);
    const releaseTimer = window.setInterval(() => void checkRelease(), RELEASE_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkBuild();
        void checkRelease(); // já protegido por throttle interno
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(buildTimer);
      window.clearInterval(releaseTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkBuild, checkRelease]);

  function dismissRelease() {
    if (remote?.version) {
      window.localStorage.setItem(DISMISSED_RELEASE_KEY, remote.version);
    }
    setRemote(null);
  }

  if (remote) {
    return (
      <UpdateReleaseNotes
        release={buildGenericReleaseNote(remote)}
        remote={remote}
        updateCommand={UPDATE_COMMAND}
        onSkip={dismissRelease}
      />
    );
  }

  return (
    <Dialog open={rebuildOpen} onOpenChange={(next) => !next && setRebuildOpen(false)}>
      <DialogContent showCloseButton={false} className="border-border bg-popover overflow-hidden p-0 sm:max-w-md">
        <div className="relative px-6 pt-6 pb-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_right,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_70%)]" />
          <div className="relative flex items-start gap-4">
            <div className="border-primary/25 bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl border shadow-sm">
              <Sparkles className="size-5" aria-hidden="true" />
            </div>
            <DialogHeader className="gap-2 text-left">
              <div className="text-primary flex items-center gap-2 text-xs font-medium tracking-[0.18em] uppercase">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Nova build no servidor
              </div>
              <DialogTitle className="text-lg">Recarregue para continuar</DialogTitle>
              <DialogDescription className="leading-6">
                O NEXOR CRM foi reconstruído neste servidor. Recarregue a página
                para carregar a versão nova.
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>
        <DialogFooter className="border-border bg-muted/40 m-0 rounded-none px-6 py-4">
          <Button variant="ghost" onClick={() => setRebuildOpen(false)}>
            Depois
          </Button>
          <Button onClick={() => window.location.reload()} className="gap-2">
            <RefreshCw className="size-4" aria-hidden="true" />
            Recarregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Passo 2: Verificar tipos**

```bash
npm run typecheck
```

Esperado: erro apontando que `UpdateReleaseNotes` não aceita `updateCommand` e ainda exige `onUpdate`. Isso é esperado — a Task 6 resolve. Anote e siga.

- [ ] **Passo 3: Commitar junto com a Task 6**

Não commitar isoladamente: o typecheck só fecha após a Task 6.

---

### Task 6: Modal com comando copiável

**Arquivos:**
- Modificar: `src/components/update-release-notes.tsx`

**Interfaces:**
- Consome: `ReleaseNote`, `RemoteUpdate`, `formatReleaseDate` (Task 4); prop `updateCommand` (Task 5).
- Produz: props `{ release, remote?, updateCommand, onSkip }`. A prop `onUpdate` é **removida** — não existe mais ação de reload neste modal.

- [ ] **Passo 1: Atualizar a interface de props**

Em `src/components/update-release-notes.tsx`, substituir a interface e o início do componente:

```typescript
interface UpdateReleaseNotesProps {
  release: ReleaseNote;
  remote?: RemoteUpdate | null;
  updateCommand: string;
  onSkip: () => void;
}

export function UpdateReleaseNotes({
  release,
  remote,
  updateCommand,
  onSkip,
}: UpdateReleaseNotesProps) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(updateCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
```

Ajustar os imports do topo do arquivo:

```typescript
import { useState } from 'react';
import { ArrowUpCircle, Check, Copy } from 'lucide-react';
```

Remover `RefreshCw` e `buildGenericReleaseNote` dos imports, que deixam de ser usados aqui.

- [ ] **Passo 2: Substituir o bloco de instruções**

Trocar todo o bloco `{hasUpdateSteps && (...)}` por:

```tsx
<div className="border-border bg-muted/40 rounded-md border p-4 text-sm">
  <h4 className="mb-2 font-medium">Como atualizar</h4>
  <p className="text-muted-foreground mb-3">
    Abra o terminal do servidor onde o NEXOR CRM está instalado, entre na
    pasta do projeto e execute:
  </p>
  <div className="flex items-center gap-2">
    <code className="bg-background border-border flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
      {updateCommand}
    </code>
    <Button variant="outline" size="sm" onClick={copyCommand} className="gap-1 shrink-0">
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copiado' : 'Copiar'}
    </Button>
  </div>
  <p className="text-muted-foreground mt-3 text-xs">
    O script atualiza, reconstrói e reinicia os serviços. Se algo falhar, ele
    restaura sozinho a versão anterior.
  </p>
  {remote?.url && (
    <p className="mt-2">
      <a href={remote.url} target="_blank" rel="noreferrer" className="text-primary underline">
        Ver a release no GitHub
      </a>
    </p>
  )}
</div>
```

Remover também a linha `const hasUpdateSteps = ...`, que deixa de existir.

- [ ] **Passo 3: Corrigir o rodapé**

Substituir o `DialogFooter` — sobra um único botão, porque não há mais o que "aplicar agora" pelo navegador:

```tsx
<DialogFooter>
  <Button variant="ghost" onClick={onSkip}>
    Fechar
  </Button>
</DialogFooter>
```

- [ ] **Passo 4: Verificar tipos e suíte**

```bash
npm run typecheck && npm run test
```

Esperado: ambos passam. Os erros da Task 5 desaparecem.

- [ ] **Passo 5: Commitar Tasks 5 e 6**

```bash
git add src/components/app-update-prompt.tsx src/components/update-release-notes.tsx
git commit -m "feat(update): separar aviso de rebuild do aviso de release e entregar comando copiável

O botão 'Recarregar e aplicar agora' não atualizava nada — só recarregava
a aba. O modal de release passa a mostrar o comando real de atualização."
```

---

### Task 7: Units versionadas e `install.sh`

Sem isso o cliente clona e não consegue subir o CRM: as units vivem em `~/.config/systemd/user/` da VPS de desenvolvimento, com caminhos absolutos cravados, e não estão no repositório.

**Arquivos:**
- Criar: `deploy/wacrm.service.template`
- Criar: `deploy/wacrm-worker.service.template`
- Criar: `scripts/install.sh`

**Interfaces:**
- Consome: `scripts/run-wacrm-prod.py` e `scripts/run-wacrm-worker.py`, já versionados.
- Produz: units instaladas em `~/.config/systemd/user/`, consumidas pelo `update.sh` da Task 8 via `systemctl --user restart`.

- [ ] **Passo 1: Criar `deploy/wacrm.service.template`**

```ini
[Unit]
Description=NEXOR CRM — servidor Next.js de produção
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=__INSTALL_DIR__
Environment=PATH=__NODE_BIN_DIR__:/usr/local/bin:/usr/bin:/bin
Environment=NEXOR_ENV=__INSTALL_DIR__/.env
Environment=PORT=__PORT__
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/python3 __INSTALL_DIR__/scripts/run-wacrm-prod.py
Restart=on-failure
RestartSec=10
KillMode=control-group

[Install]
WantedBy=default.target
```

- [ ] **Passo 2: Criar `deploy/wacrm-worker.service.template`**

```ini
[Unit]
Description=NEXOR CRM — worker interno de automações e fluxos
After=network-online.target wacrm.service
Wants=wacrm.service
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=__INSTALL_DIR__
Environment=PATH=__NODE_BIN_DIR__:/usr/local/bin:/usr/bin:/bin
Environment=NEXOR_ENV=__INSTALL_DIR__/.env
Environment=PORT=__PORT__
ExecStart=/usr/bin/python3 __INSTALL_DIR__/scripts/run-wacrm-worker.py
Restart=on-failure
RestartSec=10
KillMode=control-group

[Install]
WantedBy=default.target
```

- [ ] **Passo 3: Criar `scripts/install.sh`**

```bash
#!/usr/bin/env bash
# Instalação de primeira vez do NEXOR CRM em servidor próprio.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3010}"
UNIT_DIR="$HOME/.config/systemd/user"

echo "==> NEXOR CRM — instalação"
echo "    Diretório: $INSTALL_DIR"
echo "    Porta:     $PORT"

# 1. Node
if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não encontrado. Instale Node 20 ou superior." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERRO: Node $NODE_MAJOR encontrado. É necessário Node 20 ou superior." >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$(command -v node)")"
echo "==> Node $(node -v) em $NODE_BIN_DIR"

# 2. python3, exigido pelos wrappers de serviço
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERRO: python3 não encontrado. Ele é necessário para os serviços." >&2
  exit 1
fi

# 3. Arquivo de ambiente
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.local.example" "$INSTALL_DIR/.env"
  echo "==> .env criado a partir do exemplo."
  echo "    PREENCHA $INSTALL_DIR/.env antes de subir os serviços."
  NEEDS_ENV=1
else
  echo "==> .env já existe, mantido."
  NEEDS_ENV=0
fi

# 4. Dependências e build
echo "==> Instalando dependências..."
cd "$INSTALL_DIR"
npm ci
echo "==> Construindo..."
npm run build

# 5. Units systemd
mkdir -p "$UNIT_DIR"
for unit in wacrm wacrm-worker; do
  sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
      -e "s|__PORT__|$PORT|g" \
      "$INSTALL_DIR/deploy/$unit.service.template" > "$UNIT_DIR/$unit.service"
  echo "==> Unit instalada: $UNIT_DIR/$unit.service"
done

# 6. Sobreviver a logout e reboot
loginctl enable-linger "$USER" 2>/dev/null || \
  echo "AVISO: não foi possível habilitar linger; os serviços podem parar ao sair da sessão."

systemctl --user daemon-reload

if [ "$NEEDS_ENV" -eq 1 ]; then
  echo ""
  echo "==> Instalação concluída, serviços NÃO iniciados."
  echo "    1. Preencha $INSTALL_DIR/.env"
  echo "    2. Rode: systemctl --user enable --now wacrm.service wacrm-worker.service"
  exit 0
fi

systemctl --user enable --now wacrm.service wacrm-worker.service
echo ""
echo "==> Pronto. NEXOR CRM rodando em http://127.0.0.1:$PORT"
echo "    Status: systemctl --user status wacrm.service"
```

- [ ] **Passo 4: Tornar executável e validar sintaxe**

```bash
chmod +x scripts/install.sh && bash -n scripts/install.sh
```

Esperado: sem saída (sintaxe válida).

- [ ] **Passo 5: Conferir que os templates casam com a produção atual**

```bash
diff <(sed -e "s|__INSTALL_DIR__|/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI|g" \
             -e "s|__NODE_BIN_DIR__|/home/hermes/.hermes/node/bin|g" \
             -e "s|__PORT__|3010|g" deploy/wacrm.service.template) \
     ~/.config/systemd/user/wacrm.service
```

Esperado: diferenças apenas em `Description` (texto) e ordem de linhas. **Nenhuma diferença em `ExecStart`, `WorkingDirectory` ou `Environment`.** Se houver, corrija o template para refletir a produção real.

- [ ] **Passo 6: Commitar**

```bash
git add deploy/ scripts/install.sh
git commit -m "feat(deploy): versionar units systemd e script de instalação

As units viviam apenas em ~/.config da VPS de desenvolvimento, com caminhos
absolutos. Clientes não tinham como subir o CRM."
```

---

### Task 8: `scripts/update.sh` com rollback

**Arquivos:**
- Criar: `scripts/update.sh`

**Interfaces:**
- Consome: units instaladas pela Task 7.
- Produz: o comando `bash scripts/update.sh`, exibido pelo modal da Task 6.

- [ ] **Passo 1: Criar o script**

```bash
#!/usr/bin/env bash
# Atualiza o NEXOR CRM para a última release publicada, com rollback automático.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INSTALL_DIR"

PORT="${PORT:-3010}"
LOG_DIR="$INSTALL_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/update-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "==> NEXOR CRM — atualização iniciada em $(date)"

# 1. Não atropelar alterações locais do cliente
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERRO: existem alterações locais não commitadas neste diretório." >&2
  echo "      Salve ou descarte essas alterações antes de atualizar." >&2
  git status --short >&2
  exit 1
fi

PREVIOUS_SHA="$(git rev-parse HEAD)"
echo "==> Versão atual: $PREVIOUS_SHA"

# 2. Buscar a última release
git fetch --tags --prune origin
LATEST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
if [ -z "$LATEST_TAG" ]; then
  echo "ERRO: nenhuma tag de release encontrada no repositório." >&2
  exit 1
fi
echo "==> Última release: $LATEST_TAG"

if [ "$(git rev-parse "$LATEST_TAG")" = "$PREVIOUS_SHA" ]; then
  echo "==> Já está na versão mais recente. Nada a fazer."
  exit 0
fi

# 3. Migrations que entram nesta atualização
NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$PREVIOUS_SHA" "$LATEST_TAG" -- supabase/migrations/ || true)"

rollback() {
  echo ""
  echo "!!! FALHA NA ATUALIZAÇÃO — restaurando $PREVIOUS_SHA" >&2
  git checkout --force "$PREVIOUS_SHA"
  npm ci
  npm run build
  systemctl --user restart wacrm.service wacrm-worker.service
  echo "!!! Versão anterior restaurada. Log completo em $LOG_FILE" >&2
  exit 1
}

# 4. Atualizar
git checkout --force "tags/$LATEST_TAG"
npm ci || rollback
npm run build || rollback

# 5. Reiniciar
systemctl --user restart wacrm.service wacrm-worker.service || rollback

# 6. Healthcheck
echo "==> Aguardando o serviço responder..."
OK=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/version"; then
    OK=1
    break
  fi
  sleep 2
done
[ "$OK" -eq 1 ] || rollback

echo ""
echo "==> Atualizado para $LATEST_TAG com sucesso."

if [ -n "$NEW_MIGRATIONS" ]; then
  echo ""
  echo "############################################################"
  echo "# ATENÇÃO: esta versão inclui migrations de banco novas.    #"
  echo "# Aplique-as no Supabase antes de usar o CRM:               #"
  echo "############################################################"
  echo "$NEW_MIGRATIONS" | sed 's/^/  - /'
  echo ""
fi

echo "Log completo: $LOG_FILE"
```

- [ ] **Passo 2: Tornar executável e validar sintaxe**

```bash
chmod +x scripts/update.sh && bash -n scripts/update.sh
```

Esperado: sem saída.

- [ ] **Passo 3: Ignorar os logs no git**

Acrescentar ao `.gitignore`:

```
# logs de atualização
/logs/
```

- [ ] **Passo 4: Commitar**

```bash
git add scripts/update.sh .gitignore
git commit -m "feat(deploy): script de atualização com rollback e aviso de migrations"
```

---

### Task 9: Documentar instalação e atualização

**Arquivos:**
- Modificar: `README.md`

- [ ] **Passo 1: Remover a instrução quebrada**

`README.md:45` manda rodar `npm run start:prod`. Esse script **não existe** no `package.json`. Localizar e remover:

```bash
grep -n "start:prod" README.md
```

- [ ] **Passo 2: Escrever a seção de instalação**

Inserir antes da seção de configuração:

````markdown
## Instalação em servidor próprio

Requisitos: Linux com systemd, Node 20+, Python 3, git e uma conta Supabase.

```bash
git clone https://github.com/nexor-ai/CRM_NEXOR-AI.git
cd CRM_NEXOR-AI
bash scripts/install.sh
```

O script valida os requisitos, instala dependências, constrói o projeto,
registra os serviços `wacrm` e `wacrm-worker` no systemd do usuário e sobe tudo
na porta 3010. Para usar outra porta: `PORT=3020 bash scripts/install.sh`.

Na primeira execução ele cria o `.env` a partir do `.env.local.example` e para,
esperando que você preencha as credenciais. Depois de preencher:

```bash
systemctl --user enable --now wacrm.service wacrm-worker.service
```

Aplique as migrations de `supabase/migrations/` no seu projeto Supabase, em
ordem numérica.

## Atualização

O CRM avisa dentro da interface quando existe uma versão nova. Para aplicar,
no terminal do servidor, dentro da pasta do projeto:

```bash
bash scripts/update.sh
```

O script busca a última release, reconstrói, reinicia os serviços e confere se
o CRM voltou a responder. Se qualquer etapa falhar, ele restaura sozinho a
versão anterior. Se a atualização trouxer migrations novas, elas são listadas ao
final — aplique-as no Supabase.

Comandos úteis:

```bash
systemctl --user status wacrm.service
journalctl --user -u wacrm.service -f
```
````

- [ ] **Passo 3: Commitar**

```bash
git add README.md
git commit -m "docs: instruções de instalação e atualização; remover npm run start:prod inexistente"
```

---

### Task 10: Publicar release v0.9.0 e abrir o repositório

**Portão manual: não executar sem autorização explícita do Anderson.** Tornar um repositório público é irreversível na prática — uma vez indexado ou clonado, o conteúdo circulou.

- [ ] **Passo 1: Rodar a validação completa**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Esperado: todos passam. Se algum falhar, PARE.

- [ ] **Passo 2: Conferir a atribuição da licença**

O `LICENSE` traz `Copyright (c) 2026 Arnas Donauskas`, do projeto de origem. Num
derivado MIT essa linha **é obrigatória e não pode ser removida**. Acrescentar o
copyright da NEXOR AI logo abaixo, sem apagar o original:

```
Copyright (c) 2026 Arnas Donauskas
Copyright (c) 2026 NEXOR AI
```

```bash
git add LICENSE && git commit -m "docs: acrescentar copyright NEXOR AI mantendo a atribuição original"
```

- [ ] **Passo 3: Apagar a release e a tag v0.8.1 mentirosas**

Elas apontam para o código da 0.8.0 e enganam quem confiar nelas.

```bash
gh release delete v0.8.1 -R nexor-ai/CRM_NEXOR-AI --yes
git push origin :refs/tags/v0.8.1
git tag -d v0.8.1
```

- [ ] **Passo 4: Enviar o código e criar a tag**

```bash
git push origin HEAD:main
git tag -a v0.9.0 -m "NEXOR CRM v0.9.0"
git push origin v0.9.0
```

- [ ] **Passo 5: Publicar a release**

O corpo desta release é o que o cliente vê no modal — cada linha vira um item da lista.

```bash
gh release create v0.9.0 -R nexor-ai/CRM_NEXOR-AI \
  --title "NEXOR CRM v0.9.0" \
  --notes "- Canais manuais assistidos
- Painel de confiabilidade das instâncias
- Agentes de IA especializados por departamento
- Departamentos com múltiplas instâncias do WhatsApp
- Transcrição assíncrona de áudios
- Mídia em conversas privadas
- Instalação e atualização por script, com rollback automático
- Aviso de nova versão agora funciona em qualquer servidor"
```

- [ ] **Passo 6: Confirmar autorização e tornar público**

Confirmar com o Anderson. Só então:

```bash
gh repo edit nexor-ai/CRM_NEXOR-AI --visibility public --accept-visibility-change-consequences
```

- [ ] **Passo 7: Verificar acesso anônimo**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://api.github.com/repos/nexor-ai/CRM_NEXOR-AI/releases/latest
```

Esperado: **200**. Era 404 antes — este número é a correção do problema original.

---

### Task 11: Teste de aceite simulando a máquina do cliente

Esta é a verificação que nunca foi feita e que teria exposto a causa raiz. Sem ela, a task anterior não vale como concluída.

- [ ] **Passo 1: Clonar limpo, fora da pasta de produção**

```bash
git clone https://github.com/nexor-ai/CRM_NEXOR-AI.git /tmp/teste-cliente-crm
cd /tmp/teste-cliente-crm && npm ci
```

- [ ] **Passo 2: Simular uma instalação desatualizada**

Editar `package.json` do clone, campo `version`, para `0.8.0`. Isso reproduz um cliente atrasado.

- [ ] **Passo 3: Construir e subir sem credencial do GitHub**

Porta 3011 para não colidir com a produção em 3010.

```bash
cd /tmp/teste-cliente-crm
cp .env.local.example .env
env -u GITHUB_TOKEN PATH=/usr/local/bin:/usr/bin:/bin:$(dirname $(command -v node)) \
  npm run build
env -u GITHUB_TOKEN npx next start -p 3011 -H 127.0.0.1 &
```

- [ ] **Passo 4: Verificar a rota como o cliente a vê**

```bash
sleep 5 && curl -s http://127.0.0.1:3011/api/updates | head -20
```

Esperado: JSON com `"version":"0.9.0"` e o changelog. **Se vier 404 ou 503, o problema original não foi resolvido — pare e investigue.**

- [ ] **Passo 5: Verificar ausência de falso positivo**

Restaurar `version` para `0.9.0` no `package.json` do clone, reconstruir e conferir que o modal **não** aparece. Isso valida a regressão do popup infinito.

- [ ] **Passo 6: Testar o rollback do update.sh**

No clone, quebrar o build de propósito (por exemplo, inserir `const x: number = "erro";` em `src/lib/app-version.ts`), commitar localmente, criar uma tag falsa mais alta e rodar `bash scripts/update.sh`. Confirmar que o serviço volta à versão anterior e continua respondendo.

- [ ] **Passo 7: Limpar**

```bash
pkill -f "next start -p 3011" || true
rm -rf /tmp/teste-cliente-crm
```

- [ ] **Passo 8: Commitar o spec e o plano**

```bash
git add docs/plans/2026-07-27-canal-atualizacao-clones-*.md
git commit -m "docs: spec e plano do canal de atualização para clones"
git push origin HEAD:main
```

---

## Riscos conhecidos

**Migrations não são aplicadas automaticamente.** O `update.sh` avisa, mas não executa. Um cliente que ignorar o aviso sobe código 0.9.0 sobre schema antigo e o CRM quebra. Automatizar isso é trabalho separado, fora deste escopo.

**Ninguém está rodando o CRM hoje além da VPS.** O repositório não tem colaboradores, deploy keys nem forks. Não há base instalada a quebrar — mas também significa que o fluxo de instalação nunca foi exercitado por outra pessoa. A Task 11 é a primeira vez.

**Rate limit anônimo.** 60 req/h por IP. Com cache de 15 minutos e throttle de 30 minutos, uma instância faz no máximo 4 req/h. Folga confortável, mas se algum cliente colocar o CRM atrás de um NAT compartilhado com muitas instâncias, pode apertar — nesse caso ele configura `GITHUB_TOKEN` no `.env`.
