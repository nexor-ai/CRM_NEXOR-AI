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
rode o instalador de novo para aplicar as migrations e então suba os
serviços:

```bash
bash scripts/install.sh
systemctl --user enable --now wacrm.service wacrm-worker.service
```

Na segunda execução, com `.env` já preenchido, o instalador aplica
automaticamente todas as migrations de `supabase/migrations/`
(`001` até a mais recente) via `scripts/migrate.mjs`, num banco Supabase
zerado. Isso só vale para banco zerado: se o schema já existe porque foi
aplicado à mão (sem a tabela de controle `public.schema_migrations`), rodar
o instalador sem preparo tentaria reaplicar as migrations desde o início e
quebraria a instalação — veja "Banco de dados e migrações" abaixo para o
procedimento de `--baseline` nesse caso.

## Atualização

O CRM avisa dentro da interface quando existe uma versão nova. Para aplicar,
no terminal do servidor, dentro da pasta do projeto:

```bash
bash scripts/update.sh
```

O script busca a última release, reconstrói, reinicia os serviços e confere se
o CRM voltou a responder. Se qualquer etapa falhar, ele restaura sozinho a
versão anterior. Se a atualização trouxer migrations novas em
`supabase/migrations/`, elas são aplicadas automaticamente via
`scripts/migrate.mjs` antes do rebuild — não é mais preciso aplicá-las à mão
no Supabase. Isso requer `SUPABASE_DB_URL` definida em `.env` (ver
[Variáveis de ambiente](#variáveis-de-ambiente)); se a atualização trouxer
migrations novas e a variável não estiver definida, `update.sh` aborta antes
de mexer em qualquer arquivo, para não deixar código novo rodando contra
schema velho.

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
  onde pegar o valor no painel do Supabase.

Para parâmetros e migração do transporte WhatsApp, consulte [`docs/whatsapp-evolution-upgrade.md`](./docs/whatsapp-evolution-upgrade.md).

## Banco de dados e migrações

As migrações versionadas ficam em [`supabase/migrations/`](./supabase/migrations/). Antes de executar uma migração em ambiente compartilhado ou de produção, valide o plano, backup e impacto. A migração da Evolution API é:

```text
supabase/migrations/031_evolution_api_transport.sql
```

### Aplicação automática

`scripts/install.sh` (banco zerado, na segunda execução, depois do `.env`
preenchido) e `scripts/update.sh` (quando a atualização traz migration nova)
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
ele tentar reaplicar as migrations `001` em diante do zero (`create table`
etc. em objetos que já existem), quebrando a instalação. Para essas
instalações, o primeiro passo é registrar como já aplicado, sem executar,
tudo até o número de schema que o banco de fato tem hoje (`--baseline`
exige a tabela de controle vazia — só funciona nessa janela, antes de
qualquer migration ter sido de fato aplicada pelo runner):

```bash
# 1. Baseline: registra 001..NNN como já aplicadas, sem rodar SQL nenhum.
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --baseline NNN

# 2. Execução normal: aplica só o que vem depois de NNN.
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs
```

Duas instalações estão hoje nessa situação, ambas com schema em `043`: a VPS
de produção e a cópia no notebook. Nas duas, o procedimento é:

```bash
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs --baseline 043
SUPABASE_DB_URL=postgres://... node scripts/migrate.mjs   # aplica 044..050
```

Depois do baseline feito uma vez, essas instalações seguem o fluxo normal —
`update.sh` (ou execuções manuais do runner) só aplicam o que vier depois de
`050`.

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
