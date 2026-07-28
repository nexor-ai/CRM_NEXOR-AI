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

Para parâmetros e migração do transporte WhatsApp, consulte [`docs/whatsapp-evolution-upgrade.md`](./docs/whatsapp-evolution-upgrade.md).

## Banco de dados e migrações

As migrações versionadas ficam em [`supabase/migrations/`](./supabase/migrations/). Antes de executar uma migração em ambiente compartilhado ou de produção, valide o plano, backup e impacto. A migração da Evolution API é:

```text
supabase/migrations/031_evolution_api_transport.sql
```

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
