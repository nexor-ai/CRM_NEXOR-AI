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

## Self-hosted / Cliente final

Este repositório é preparado para ser clonado, construído e empacotado para produção.
O fluxo recomendado para atualizar uma instância self-hosted é:

```bash
git pull
npm install
npm run build
python3 scripts/promote-wacrm-production.py
npm run start:prod
```

Observação:
- Nunca execute esses passos em produção sem validação e backup.
- As credenciais devem ser inseridas apenas no `.env` local.
- Alterações de infraestrutura, DNS, firewall, banco remoto e publicação exigem aprovação humana.

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
