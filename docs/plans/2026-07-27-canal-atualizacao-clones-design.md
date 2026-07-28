# Canal de atualização para clones — design

**Data:** 2026-07-27
**Status:** aguardando autorização de execução
**Autor:** Nexo / Anderson

---

## 1. Problema

Clientes que rodam o NEXOR CRM em servidor próprio nunca são avisados de novas
versões. A notificação só aparece na VPS de desenvolvimento. Além disso, o que
está publicado no GitHub está muito atrás do que existe em produção.

### 1.1 Causa direta da notificação não aparecer

`src/app/api/updates/route.ts` consulta a API do GitHub. O repositório
`nexor-ai/CRM_NEXOR-AI` é **privado**. Para autenticar, a rota executa
`gh auth token` via `execFileSync` (linha 13) — o que só funciona na VPS de
desenvolvimento, onde o `gh` está autenticado.

Na máquina do cliente não há `gh` nem `GITHUB_TOKEN`. A API do GitHub responde
**404** para todas as três chamadas (`releases/latest`, `tags`, `commits/develop`).
`safeJson` devolve `null` para todas, `preferred` fica `null`, a rota responde 404
e `app-update-prompt.tsx:72` engole o erro em silêncio. A notificação nunca é
exibida. Comportamento determinístico, não intermitente.

Verificação executada: requisição anônima a `api.github.com/repos/nexor-ai/CRM_NEXOR-AI`
retorna HTTP 404.

### 1.2 Causa do clone ser "muito inferior"

O código de produção não está no GitHub:

- `main`, `develop`, `origin/main` e `origin/develop` estão todos no mesmo commit
  (`57a2825`). O repositório tem 3 commits ao todo.
- A tag/release **v0.8.1 aponta para o mesmo commit da baseline 0.8.0**. A release
  não contém nenhuma linha de código nova.
- A VPS tem **97 arquivos modificados e 51 não rastreados** nunca commitados,
  incluindo **7 migrations de banco (044→050)** e módulos inteiros: canais,
  confiabilidade, agentes de IA especializados, departamentos multi-instância,
  transcrição assíncrona e mídia de chat.

Um clone atual não recebe uma versão levemente antiga: recebe um produto sem essas
funcionalidades e sem o schema de banco que elas exigem.

### 1.3 Defeitos adicionais confirmados

**Popup infinito.** `scripts/build.mjs:19` grava `NEXT_PUBLIC_APP_VERSION` como
`<sha12>-<timestamp>`, enquanto `/api/updates` devolve o nome da tag (`v0.8.1`).
`shouldPromptForUpdate` compara com `!==` puro, então as duas strings nunca são
iguais. Corrigido apenas o token, o cliente veria o modal para sempre, inclusive
segundos após atualizar.

**Rate limit.** Sem repositório privado, o limite anônimo da API do GitHub é
60 req/h por IP. A rota faz 3 chamadas por verificação. O front chama com
`?ts=${Date.now()}` e `cache: 'no-store'`, furando o `next: { revalidate: 120 }`.
O listener de `visibilitychange` (`app-update-prompt.tsx:80`) dispara uma
verificação a cada troca de aba, sem throttle. Um cliente alternando abas estoura
o limite e o check morre em silêncio.

**Botão que não faz nada.** `updateNow()` (linha 96) só executa
`window.location.reload()`. Não atualiza código algum. O rótulo "Recarregar e
aplicar agora" promete o que o botão não entrega.

**Instrução quebrada.** `README.md:45` e o passo 5 do modal mandam rodar
`npm run start:prod`. Esse script **não existe** no `package.json`, que só define
`dev`, `build`, `start`, `lint`, `typecheck`, `format`, `format:check`, `test` e
`test:watch`. Todo cliente que seguir as instruções à risca quebra no último passo.

**Release notes congeladas.** `src/lib/update-release-notes.ts` mantém um mapa
`RELEASE_NOTES` hardcoded com 0.8.0/0.7.5, que desatualiza a cada release.

### 1.4 Não existe caminho de instalação

Em produção o CRM roda com duas units systemd **de usuário**, ambas `enabled` com
`Linger=yes`:

- `wacrm.service` → `python3 scripts/run-wacrm-prod.py` → `next start -p 3010 -H 127.0.0.1`
- `wacrm-worker.service` → `python3 scripts/run-wacrm-worker.py`

Os dois wrappers Python estão versionados no repositório. **As units não** — vivem
em `~/.config/systemd/user/` com caminhos absolutos cravados:

```
WorkingDirectory=/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI
Environment=PATH=/home/hermes/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=PORT=3010
```

O `PATH` aponta para um Node v22.22.3 que só existe nessa VPS. O cliente clona e
não recebe serviço, nem boot automático, nem instruções. O `README.md` não tem
seção de instalação.

Atualizar pressupõe uma instalação que hoje o cliente não consegue fazer. Por isso
instalação entra no escopo.

---

## 2. Decisões tomadas

| Decisão | Escolha |
|---|---|
| Distribuição | Repositório **público**. Check de update funciona sem token. |
| Gatilho da notificação | **Somente Release publicada** com tag semver. |
| Ação do botão | **Comando único copiável** que roda `scripts/update.sh`. |
| Versão de produção | Node v22, systemd user units, porta **3010**. |

### 2.1 Segurança da abertura do repositório

Auditoria do histórico executada antes de recomendar a virada para público:

- Nenhum `.env` rastreado (apenas `.env.local.example`).
- `.gitignore` cobre `*.env*` desde o primeiro commit.
- Únicos padrões de segredo encontrados são placeholders literais:
  `'sk-ant-...'` em `src/components/settings/ai-config.tsx` e `'sk-ant-x'` em
  `src/lib/ai/generate.test.ts`.
- Histórico do `origin` é curto (3 commits, já squashado) e não arrasta o
  histórico do projeto de origem `ArnasDon/wacrm`.
- Zero forks, zero deploy keys, nenhum colaborador além de `nexor-ai`.

**Conclusão:** pode ser tornado público sem vazamento. Duas ressalvas: manter o
arquivo `LICENSE` com a atribuição MIT original ao projeto derivado, e considerar
que a partir da virada qualquer segredo commitado por engano vira exposição
imediata.

---

## 3. Arquitetura da solução

### 3.1 Fonte de verdade da versão

Duas grandezas distintas, hoje confundidas:

| Grandeza | Origem | Uso |
|---|---|---|
| `NEXT_PUBLIC_APP_VERSION` | `<sha12>-<timestamp>` do build | "o servidor foi reconstruído, recarregue a aba" |
| `NEXT_PUBLIC_APP_RELEASE` | `package.json.version` | "existe release nova no GitHub" |

`scripts/build.mjs:20` **já grava** `NEXT_PUBLIC_APP_RELEASE`. A peça existe e só
não estava sendo usada para comparação de release.

Comparação passa a ser **semver real**, não igualdade de string. Notifica somente
quando `remoto > local`.

### 3.2 Fluxo

```
Release publicada no GitHub (tag v0.9.0)
        │
        ▼
GET /api/updates  ── cache 15min em memória ──► api.github.com/releases/latest
        │                                        (anônimo; GITHUB_TOKEN opcional)
        ▼
{ version: "0.9.0", tag: "v0.9.0", name, changelog, publishedAt, url }
        │
        ▼
app-update-prompt compara semver com NEXT_PUBLIC_APP_RELEASE
        │
        ▼ (remoto > local e não dispensado)
Modal com changelog da release + comando copiável
        │
        ▼
Cliente cola na VPS: bash scripts/update.sh
        │
        ▼
pull → npm ci → build → systemctl --user restart → healthcheck
        │
        └── build ou healthcheck falhou ──► rollback automático ao SHA anterior
```

### 3.3 Componentes

**`src/lib/app-version.ts`** — ganha `normalizeVersion(v)` (remove prefixo `v`),
`compareSemver(a, b)` e `shouldPromptForRelease(atual, disponivel, dispensada)`.

`shouldPromptForUpdate` **permanece intacta**: ela compara identificadores de
build opacos (`build-a` vs `build-b`) e a igualdade de string é a comparação
correta para o evento "servidor reconstruído". Trocá-la por semver quebraria esse
caso. São dois eventos distintos, logo duas funções distintas.

`shouldPromptForRelease` retorna `true` apenas se
`compareSemver(disponivel, atual) > 0` e o valor não tiver sido dispensado.
Pre-release ordena abaixo do estável (`0.9.0-beta` < `0.9.0`). Qualquer versão
`development` desliga a notificação.

**`src/app/api/updates/route.ts`** — reescrita:
- Remove `resolveGitHubToken()` e o `execFileSync('gh')` por completo.
- `GITHUB_TOKEN` de ambiente continua sendo usado se existir, nunca obrigatório.
- Uma única chamada a `releases/latest`. Saem os fallbacks de `tags` e
  `commits/develop` — com "somente Release publicada" eles são ruído.
- Cache em módulo com TTL de 15 minutos, imune ao `?ts=` do cliente.
- Em 403/429 (rate limit) devolve o cache anterior se houver; caso contrário
  responde erro silencioso que o front ignora.

**`src/components/app-update-prompt.tsx`** — separa os dois avisos:
- *Rebuild do servidor* (intervalo de 60s): mantém `reload()`, que é a ação
  correta nesse caso.
- *Release nova* (intervalo de 30min, throttle no `visibilitychange`): exibe
  changelog e comando copiável. Não faz reload.
- Dispensar migra de `sessionStorage` para `localStorage`, para o "Depois"
  realmente silenciar até a próxima release.

**`src/lib/update-release-notes.ts`** — remove o mapa `RELEASE_NOTES`,
`getReleaseNote` e `getUpdatePromptMode`. O corpo da Release do GitHub passa a ser
a única fonte, já convertido em bullets por `buildGenericReleaseNote`. Mantém
`formatReleaseDate` e `parseChangelogToBullets`.

**`deploy/wacrm.service.template`** e **`deploy/wacrm-worker.service.template`** —
units versionadas com marcadores `__INSTALL_DIR__`, `__NODE_BIN_DIR__` e
`__PORT__`, substituídos na instalação. Padrão de porta: 3010.

**`scripts/install.sh`** — instalação de primeira vez: valida Node ≥ 22, gera
`.env` a partir de `.env.local.example`, `npm ci`, `npm run build`, materializa as
units a partir dos templates, `loginctl enable-linger`, `systemctl --user
daemon-reload` e `enable --now` nos dois serviços.

**`scripts/update.sh`** — o comando do modal:
1. Aborta se houver alterações locais não commitadas (não atropela customização
   do cliente).
2. Guarda o SHA atual.
3. `git fetch --tags --prune`, checkout da tag mais recente.
4. `npm ci` e `npm run build`.
5. `systemctl --user restart wacrm.service wacrm-worker.service`.
6. Healthcheck em `127.0.0.1:$PORT`.
7. **Rollback automático** ao SHA anterior, com rebuild e restart, se o passo 4
   ou o 6 falhar.
8. Detecta arquivos novos em `supabase/migrations/` entre o SHA antigo e o novo e
   **avisa em destaque** quais precisam ser aplicados. Não aplica nada — apenas
   impede que o cliente suba código novo sobre schema velho sem saber.
9. Log em arquivo.

**`README.md`** — ganha seção de instalação e atualização. Remove a referência a
`npm run start:prod` (linha 45).

---

## 4. Plano de versão e release

- Commitar os 97 modificados + 51 não rastreados após revisão.
- Bump de `package.json` de `0.8.0` para **`0.9.0`** — 7 migrations e módulos
  inteiros caracterizam minor, não patch.
- **Apagar release e tag `v0.8.1`**, que apontam para o código da 0.8.0 e
  enganam quem confiar nelas.
- Publicar release `v0.9.0` com changelog real no corpo.
- Tornar o repositório público **somente após** a release existir.

---

## 5. Critério de aceite

Clone limpo do repositório público em diretório separado, **sem `gh` no PATH e sem
`GITHUB_TOKEN` no ambiente**, simulando a máquina do cliente, rodando em porta
alternativa para não colidir com a produção em 3010. O modal de atualização precisa
aparecer nesse clone.

Enquanto esse teste não passar, o problema não está resolvido — é exatamente a
verificação que nunca foi feita e que teria exposto a causa em 1.1.

Complementarmente:
- Cliente já na versão mais recente **não** vê o modal (regressão do popup infinito).
- `update.sh` com build quebrado propositalmente restaura a versão anterior e o
  serviço volta no ar.

---

## 6. Fora de escopo

- Auto-update sem terminal (decidido: comando copiável).
- Telemetria de quais clientes rodam qual versão.
- Migração automática de banco durante o update — as migrations 044→050 seguem
  aplicadas manualmente nesta entrega.
- Refatoração dos módulos não commitados. Eles entram como estão; revisão de
  qualidade é trabalho separado.
