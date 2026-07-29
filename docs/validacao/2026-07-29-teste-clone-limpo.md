# Teste de aceite em clone limpo — 2026-07-29

A Task 11 do plano original. Nunca tinha sido feita; é o teste que teria pego a
causa raiz do 404 lá na Task 3.

Executado depois do push (`origin/main` = `c36f281`).

## Montagem

- `git clone https://github.com/nexor-ai/CRM_NEXOR-AI.git` para `/tmp`, limpo.
- `git checkout 78e408e` — simula um cliente que instalou 2 commits atrás.
- `npm ci`, `next dev -p 3011`.
- Ambiente **sem `GITHUB_TOKEN`** e **sem `GH_TOKEN`** (`env -u`).
- Produção na 3010 intocada durante todo o teste.

## Resultado 1 — cliente atrasado recebe o aviso

`GET /api/updates` → HTTP 200

```json
{
  "updateAvailable": true,
  "behindBy": 2,
  "localCommit":  "78e408e323d5c37675310aa018509d1fa13b66f2",
  "remoteCommit": "c36f281103aa218096b6bb4a0f9f92cb2b1f8c84",
  "changes": [
    "test(migrate): validação do runner contra Postgres real (16 checagens, tudo verde)",
    "feat(migrate): --force-checksum, imutabilidade de migrations, e mais 4 fixes da revisão final"
  ],
  "url": "https://github.com/nexor-ai/CRM_NEXOR-AI/compare/78e408e...main"
}
```

Sem token, HTTP 200. A causa raiz original (404 porque a rota exigia
`gh auth token`) está encerrada de forma verificada, não presumida.

## Resultado 2 — depois de atualizar, o aviso some

`git fetch && git checkout --force origin/main` (o que o `update.sh` faz),
servidor reiniciado:

```json
{
  "updateAvailable": false,
  "behindBy": 0,
  "localCommit":  "c36f281...",
  "remoteCommit": "c36f281...",
  "changes": []
}
```

## Armadilha encontrada durante o teste (vale registrar)

A primeira medição do resultado 2 deu `updateAvailable: true` — falso positivo.
Causa: `pkill -f "next dev -p 3011"` NÃO mata o servidor, porque o processo se
renomeia para `next-server (v16.2.12)`. A medição vinha do processo antigo, com
`localCommit` em cache. Só matando por PID (`kill -9 <pid>`) o teste ficou
válido.

Quem for repetir este teste: confira o PID que está escutando na porta antes de
confiar na resposta.

## Resultado 3 — o modal na tela (Chromium headless)

Feito depois, no mesmo clone, com Playwright. Capturas em
`aviso-atualizacao-antes.png` e `aviso-atualizacao-depois.png`.

**Antes (2 commits atrás)** — o modal aparece com:
- título "Atualização disponível"
- "2 atualizações pendentes • 29/07/2026"
- os assuntos reais dos dois commits novos
- bloco "Como atualizar" com `bash scripts/update.sh` e botão "Copiar"
- link "Ver as mudanças no GitHub" e botão "Fechar"

**Depois (`git checkout --force origin/main`)** — a rota devolve
`updateAvailable: false` e o modal desaparece; só o formulário de login fica.

### Armadilha que gera falso negativo

Acessar o dev server por `127.0.0.1` em vez de `localhost` faz o Next bloquear
os recursos de dev por cross-origin ("Blocked cross-origin request to Next.js
dev resource"). A hidratação não acontece, o `useEffect` nunca roda, e nenhuma
chamada a `/api/updates` sai — a página renderiza normalmente e parece defeito
do produto. Custou três rodadas de depuração. **Use `localhost`.**

## O que este teste NÃO cobre

- `install.sh` de ponta a ponta contra um Supabase real — o teste usou
  credenciais fictícias, já que `/api/updates` não toca no banco. O middleware
  exige as variáveis do Supabase para qualquer rota responder.
- Teste automatizado de componente. A verificação visual acima foi manual (via
  script Playwright, não versionado). O projeto não tem `@testing-library/react`
  nem ambiente jsdom no Vitest — o `environment` é `node`.
