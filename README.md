# CRM NEXOR AI

CRM operacional da **NEXOR AI** para centralizar atendimento via WhatsApp, contatos, oportunidades comerciais, campanhas e automações. É uma adaptação privada do projeto open source [wacrm](https://github.com/ArnasDon/wacrm), evoluída para a operação da NEXOR.

> **Status:** em desenvolvimento interno. Não é um produto público nem uma instância pronta para produção sem a configuração completa de infraestrutura, banco e credenciais.

## Capacidades

- Caixa de entrada compartilhada para conversas no WhatsApp.
- Gestão de contatos, tags, campos personalizados e importação CSV.
- Pipeline comercial em Kanban, negócios e acompanhamento de oportunidades.
- Campanhas, listas e mensagens em massa.
- Automações e fluxos visuais acionados por eventos, palavras-chave e agenda.
- Assistente de IA e base de conhecimento por conta, com revisão humana.
- Gestão de equipe, funções e permissões por conta.
- API REST pública e webhooks para integrações controladas.

## Arquitetura

| Camada | Tecnologia |
| --- | --- |
| Aplicação | Next.js 16, React 19, TypeScript e Tailwind CSS 4 |
| Dados e autenticação | Supabase (Postgres, Auth, Storage e RLS) |
| Transporte WhatsApp | Evolution API |
| Testes | Vitest |
| Qualidade | ESLint, Prettier e TypeScript |

## Pré-requisitos

- Node.js 20 ou superior.
- Um projeto Supabase configurado.
- Uma instância da Evolution API configurada para o número de WhatsApp.
- Variáveis de ambiente válidas. **Nunca versionar arquivos `.env` ou chaves.**

## Desenvolvimento local

```bash
git clone https://github.com/nexor-ai/CRM_NEXOR-AI.git
cd CRM_NEXOR-AI
npm install
cp .env.local.example .env.local
# Preencha .env.local com valores do ambiente autorizado.
npm run dev
```

Abra `http://localhost:3000`. O acesso autenticado depende da configuração do Supabase.

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

Na primeira execução ele cria o `.env` a partir do `.env.local.example`,
segue até o fim (build, units systemd) e para sem subir os serviços,
esperando que você preencha as credenciais — inclusive `SUPABASE_DB_URL`
(ver [Variáveis de ambiente](#variáveis-de-ambiente)). Depois de preencher,
rode o instalador de novo — ele aplica as migrations e, desta vez, já sobe
os serviços sozinho no final (não precisa rodar `systemctl enable --now` à
mão):

```bash
bash scripts/install.sh
```

Nessa segunda execução, com `.env` já preenchido, o instalador aplica
automaticamente todas as migrations de `supabase/migrations/`
(`001` até a mais recente) via `scripts/migrate.mjs`, num banco Supabase
zerado. Isso só vale para banco zerado: se o schema já existe porque foi
aplicado à mão (sem a tabela de controle `public.schema_migrations`), rodar
o instalador sem preparo tentaria reaplicar as migrations desde o início e
quebraria a instalação — veja "Banco de dados e migrações" abaixo para o
procedimento de `--baseline` nesse caso. Se `SUPABASE_DB_URL` ainda não
estiver preenchida quando você rodar de novo, o instalador não trava: ele
avisa e pula as migrations, mas termina o resto (build, units, serviços) —
rode `node scripts/migrate.mjs` manualmente depois de preencher a variável.

## Atualização

O CRM avisa dentro da interface quando existe uma versão nova. Para aplicar,
no terminal do servidor, dentro da pasta do projeto:

```bash
bash scripts/update.sh
```

O script busca a última release, reconstrói, reinicia os serviços e confere se
o CRM voltou a responder. Se qualquer etapa falhar, ele restaura sozinho a
versão anterior. **Toda vez que `SUPABASE_DB_URL` está definida** (não só
quando esta atualização específica trouxe migration nova), o script roda
`scripts/migrate.mjs` antes do rebuild e aplica qualquer migration pendente
de `supabase/migrations/` — não é mais preciso aplicá-las à mão no Supabase.
Isso requer `SUPABASE_DB_URL` definida em `.env` (ver
[Variáveis de ambiente](#variáveis-de-ambiente)); se **esta atualização
específica** trouxer migrations novas e a variável não estiver definida,
`update.sh` aborta antes de mexer em qualquer arquivo, para não deixar
código novo rodando contra schema velho (se a variável estiver definida mas
a atualização não trouxer migration nova, o runner roda mesmo assim — é
barato e idempotente — só não aborta a atualização se não houver nada
pendente).

> **PARE antes de definir `SUPABASE_DB_URL` numa instalação já existente.**
> `update.sh` roda `scripts/migrate.mjs` sempre que `SUPABASE_DB_URL` está
> definida — não só quando esta atualização específica trouxe migration
> nova (o runner também cobre banco atrasado por outros motivos). Se a sua
> instalação já tem o schema aplicado e **não tem** a tabela
> `public.schema_migrations` (é o caso de qualquer instalação anterior a
> este runner, como a VPS de produção e a cópia do notebook, ambas em
> schema `043`), o runner detecta isso sozinho — antes de aplicar qualquer
> SQL, ele confere se tabelas de aplicação (`contacts`, `conversations`,
> `messages`, `profiles`, `tags`) já existem em `public` e, se existirem sem
> nenhum registro em `schema_migrations` e sem `--baseline` na chamada,
> **recusa rodar e para com erro**, instruindo a fazer o baseline primeiro.
> Essa recusa é a rede de segurança de última linha, não a primeira: ela só
> existe porque a documentação sozinha não é garantia contra `DELETE`/`DROP`
> de migrations antigas em cima de dados reais — o objetivo continua sendo
> nunca chegar nela, seguindo a ordem certa abaixo.
>
> A ordem correta é **baseline antes de `SUPABASE_DB_URL` entrar no
> `.env`** — nunca o contrário. Faça o procedimento da seção "Instalações
> com schema aplicado à mão (`--baseline`)", em "Banco de dados e
> migrações" abaixo, primeiro; só depois de concluído é seguro salvar
> `SUPABASE_DB_URL` em `.env` e rodar `update.sh` normalmente.

O script detecta sozinho a porta da instalação (lendo a unit systemd
`wacrm.service`), então não é preciso repetir `PORT=...` na hora de atualizar
mesmo que a instalação tenha usado uma porta customizada. Para forçar outra
porta explicitamente: `PORT=<valor> bash scripts/update.sh`.

Comandos úteis:

```bash
systemctl --user status wacrm.service
journalctl --user -u wacrm.service -f
```

## Variáveis de ambiente

Use [`.env.local.example`](./.env.local.example) como referência. As variáveis necessárias são:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY`
- `WHATSAPP_WEBHOOK_TOKEN`
- `SUPABASE_DB_URL` — connection string direta do Postgres (não é chave de
  API), exigida por `scripts/install.sh` e `scripts/update.sh` para aplicar
  migrations automaticamente. Ver comentário em `.env.local.example` para
  onde pegar o valor no painel do Supabase. **Instalação já existente, com
  schema aplicado à mão?** Não coloque esta variável em `.env` ainda — leia
  primeiro o aviso na seção [Atualização](#atualização) e o procedimento de
  `--baseline` em "Banco de dados e migrações" abaixo.

Para parâmetros e migração do transporte WhatsApp, consulte [`docs/whatsapp-evolution-upgrade.md`](./docs/whatsapp-evolution-upgrade.md).

## Banco de dados e migrações

As migrações versionadas ficam em [`supabase/migrations/`](./supabase/migrations/). Antes de executar uma migração em ambiente compartilhado ou de produção, valide o plano, backup e impacto. A migração da Evolution API é:

```text
supabase/migrations/031_evolution_api_transport.sql
```

### Regra para quem publica: migration já lançada é imutável

> **Depois que um `NNN_descricao.sql` sai numa release e chega a QUALQUER
> cliente, o conteúdo desse arquivo nunca mais muda.** Isto é para quem
> mantém este repositório e corta releases, não para o operador de uma
> instalação.

Cada cliente grava o checksum sha256 do conteúdo do arquivo em
`public.schema_migrations` no momento em que aplica a migration.
`scripts/update.sh` roda `scripts/migrate.mjs` em toda atualização em que
`SUPABASE_DB_URL` está definida (ver "Aplicação automática" abaixo), e o
runner recusa continuar se o checksum de uma migration já aplicada não bate
mais com o arquivo no checkout atual — de propósito, porque um arquivo
publicado que muda depois de aplicado é sinal de schema imprevisível (ver
`computePendingSet`/divergência em `scripts/migrate.mjs`).

O efeito prático de editar um arquivo já publicado: a partir da release que
contém a edição, `update.sh` de **todo** cliente que já tinha aplicado
aquela migration passa a abortar por divergência → aciona rollback de código
→ volta para a versão anterior — e como a próxima tentativa de atualizar
encontra o mesmo arquivo editado, o cliente fica **permanentemente** preso
na versão de código anterior à edição, em toda tentativa futura de
atualização, não só na primeira. O cliente não tem acesso/autorização para
rodar `DELETE FROM schema_migrations` por conta própria para se destravar.

**Se algo precisa ser corrigido numa migration já publicada, publique uma
migration NOVA** (`0XX_descricao_da_correcao.sql`) que corrige o efeito da
anterior. Nunca edite o arquivo antigo.

**Se isso já aconteceu e uma instalação está travada** (ela relata
divergência de checksum e `update.sh` sempre volta para o SHA anterior), a
válvula de escape é `--force-checksum <arquivo>` (repetível), que re-registra
o checksum de um arquivo já aplicado **sem rodar o SQL dele de novo** — não
duplica o efeito da migration, só corrige o registro de controle. Recusa
rodar junto com `--baseline` (são operações para situações opostas: uma é
para tabela de controle vazia, a outra para registro já existente).
Procedimento, sem precisar de SQL manual:

```bash
# 1. Identifique o(s) arquivo(s) divergentes na mensagem de erro do
#    update.sh (ou no log em logs/update-*.log).

# 2. Traga o conteúdo publicado (o que está em origin/main) para o arquivo
#    local, sem fazer checkout do resto do código ainda:
git fetch origin
git show origin/main:supabase/migrations/NNN_arquivo.sql > supabase/migrations/NNN_arquivo.sql

# 3. Re-registre o checksum desse conteúdo, sem executar o SQL de novo
#    (repita --force-checksum para cada arquivo divergente na mesma chamada):
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --force-checksum NNN_arquivo.sql

# 4. Rode a atualização normalmente — desta vez o checksum bate.
bash scripts/update.sh
```

### Aplicação automática

`scripts/install.sh` (banco zerado, na segunda execução, depois do `.env`
preenchido) e `scripts/update.sh` (sempre que `SUPABASE_DB_URL` está
definida, em toda atualização — não só nas que trazem migration nova)
aplicam as migrations pendentes sozinhos, chamando `scripts/migrate.mjs` com
`SUPABASE_DB_URL`. Para aplicar manualmente ou conferir o que está pendente
sem aplicar:

```bash
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --dry-run
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs
```

### Instalações com schema aplicado à mão (`--baseline`)

Uma instalação que já tem o schema no banco — porque as migrations foram
rodadas manualmente antes deste runner existir — **não tem** a tabela de
controle `public.schema_migrations`. Rodar o runner nela sem preparo faria
ele tentar reaplicar as migrations `001` em diante do zero — incluindo
`DELETE`/`DROP` de migrations antigas (ex.:
`supabase/migrations/022_contact_phone_dedup.sql` e
`supabase/migrations/043_atomic_flow_automation_definition_saves.sql`) — **em
cima dos dados reais já existentes na base**.

O runner detecta esse caso sozinho: antes de aplicar qualquer SQL, se
`schema_migrations` está vazia e nenhum `--baseline` foi passado, ele
verifica se alguma tabela de aplicação (`contacts`, `conversations`,
`messages`, `profiles`, `tags`) já existe em `public`; se existir, recusa
rodar e imprime instrução para fazer o baseline primeiro. Isso é uma trava
de última linha — não decida contar com ela: siga os passos abaixo, nesta
ordem, sem pular nenhum, para nunca depender de ser barrado no último
segundo:

1. **Backup.** Faça um dump completo do banco antes de tocar em qualquer
   comando abaixo (`pg_dump`, ou o backup/snapshot do painel do Supabase).
   Sem isso, um `NNN` errado no passo 3 não tem como ser desfeito.

2. **Confirme o `NNN` real do schema desta instalação** — o número da
   última migration que já está de fato aplicada no banco, não um palpite.
   Formas de confirmar:
   - Se existe registro de deploy/changelog interno de quais migrations
     foram rodadas manualmente, use esse número.
   - Na dúvida, compare o schema atual com o conteúdo de
     `supabase/migrations/`, do arquivo de maior número para o menor: abra
     cada `NNN_descricao.sql` e verifique se os objetos que ele cria/altera
     (tabela, coluna, índice) já existem no banco (via `psql \d` ou o Table
     Editor do Supabase). O primeiro `NNN`, descendo, cujos objetos já
     existem é o baseline correto.
   - `--baseline` errado para MAIS que o real deixa migrations intermediárias
     de fora do controle (elas nunca serão aplicadas nem revalidadas).
     `--baseline` errado para MENOS que o real faz o passo 4 reaplicar
     migrations já rodadas, incluindo as destrutivas citadas acima. Não
     prossiga com um número que você não confirmou.

3. **Baseline:** registra `001..NNN` como já aplicadas, sem rodar SQL
   nenhum (`--baseline` exige a tabela de controle vazia — só funciona
   nessa janela, antes de qualquer migration ter sido de fato aplicada
   pelo runner). Rode com `SUPABASE_DB_URL` só na linha de comando, **sem**
   ainda tê-la salvo em `.env`:

   ```bash
   SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --baseline NNN
   ```

4. **Confira antes de aplicar de verdade:**

   ```bash
   SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --dry-run
   ```

   O que aparecer listado deve ser só o que vem depois de `NNN` — se
   aparecer alguma migration `<= NNN`, pare e revise o número do passo 2
   antes de continuar.

5. **Só agora** salve `SUPABASE_DB_URL` em `.env` e rode
   `node scripts/migrate.mjs` (ou deixe `update.sh` rodar normalmente daqui
   em diante).

Duas instalações estão hoje nessa situação, ambas com schema confirmado em
`043`: a VPS de produção e a cópia no notebook. Nas duas, os passos 3–4 são:

```bash
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --baseline 043
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --dry-run   # confere: só o que vem depois de 043
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs             # aplica as posteriores a 043
```

Depois do baseline feito uma vez, essas instalações seguem o fluxo normal —
`update.sh` (ou execuções manuais do runner) só aplicam o que vier depois do
que já está registrado.

## Verificação

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Execute apenas os comandos pertinentes ao escopo da alteração. Não faça deploy, migração remota, envio de mensagem ou alteração de credencial sem aprovação explícita.

## Segurança e governança

- Arquivos locais de credenciais, chaves e estado temporário são ignorados pelo Git.
- Tokens de API e chaves de integrações não devem ser incluídos em issues, logs ou commits.
- A API Evolution e os webhooks devem usar segredo compartilhado e operar com validação fail-closed.
- Mudanças de produção, DNS, firewall, credenciais, banco remoto e publicação exigem aprovação humana.

## Origem e licença

Este repositório deriva de [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm), sob licença [MIT](./LICENSE). As adaptações e a operação da NEXOR AI são mantidas neste repositório privado.
