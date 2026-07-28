# Plano TDD de execução — P0, P1 e P2 do NEXOR CRM

Data: 2026-07-25
Branch: `feat/crm-p0-p1-p2-20260725`
Produção preservada: `wacrm.service` e `wacrm-worker.service` não são reiniciados até o gate de rollout.

## Objetivo

Transformar o baseline 0.8.0 em um candidato certificável, fechando riscos P0/P1 antes de ampliar multi-instância, departamentos, agentes, transcrição e Channels manual assistido.

## Invariantes

1. Supabase é fonte de verdade; Evolution é transporte.
2. A conversa continua canônica por `(account_id, contact_id)`; `whatsapp_config_id` é carimbo de transporte.
3. Efeito externo só ocorre após sessão, role, conta, ownership, validação e intenção persistida.
4. Timeout depois de efeito externo gera `uncertain`; nunca retry automático de operação não idempotente.
5. Configuração com múltiplas candidatas falha com `ambiguous_config`; não escolhe uma linha silenciosamente.
6. Webhook e efeitos correlacionam por `whatsapp_config_id`/instância, não por ID global.
7. IA nasce em `draft_only`; `auto_reply` depende de política e limites explícitos.
8. Channels 2.3.7 é manual assistido; nenhuma publicação automática em `@newsletter`.

## Lote P0 — baseline

- release notes conhecidas com conteúdo estruturado;
- versão desconhecida usa prompt genérico, nunca tela nula;
- hooks de maior risco sem dependências faltantes;
- Next/PostCSS atualizados sem `npm audit fix --force`;
- gates: teste, typecheck, lint, build, browser candidato e audit produtivo.

## Lote P1-A — segurança sem schema

### A1. Webhooks outbound

- RED: entrega precisa usar conector DNS pinado; global `fetch` não pode ser chamado.
- GREEN: reutilizar `postJsonToPinnedPublicUrl`/helper equivalente existente.

### A2. Autorização de mutações WhatsApp

- `react`, `actions`, `messages`, `config` e demais mutações exigem `requireRole` antes de abrir admin client ou transporte.
- RED por rota: viewer recebe 403 e provider/admin client não são chamados; cross-account não gera efeito.

### A3. Presets fail-closed

- preset/template local ausente, inativo ou incompatível gera erro operacional antes do transporte;
- o nome técnico nunca vira texto enviado ao cliente.

## Lote P1-B — migration 044: mídia privada

Arquivo: `supabase/migrations/044_private_chat_media.sql`.

- bucket `chat-media` privado;
- policies account-scoped pelo primeiro segmento do path;
- webhook persiste storage key, não URL pública;
- rota autenticada/account-scoped cria signed URL curta ou faz streaming;
- compatibilidade controlada para registros antigos.

Testes RED/GREEN: migration contract, sem auth, cross-account, owner da conta, ausência de `getPublicUrl` no inbound.

## Lote P1-C — migration 045: outbox e provisionamento reconciliável

Arquivo: `supabase/migrations/045_external_operations_outbox.sql`.

Entidades:

- `external_operations`: conta, config, conversa/mensagem, tipo, idempotency key, payload sanitizado, estados `pending|processing|succeeded|failed|uncertain|cancelled`, attempts, lease, transport id, erro sanitizado e auditoria;
- estado de provisionamento em `whatsapp_config`: `requested|creating|connecting|configured|active|failed|orphaned|disabled`;
- RPCs service-role para claim/finish com fencing token e ACL fail-closed.

Operações cobertas:

- envio de mensagem/mídia/template/interativo;
- reação;
- edição e exclusão;
- arquivar/desarquivar e marcar não lida;
- criação, webhook setup, logout e remoção de instância.

Fluxo:

1. autenticar/autorizar/validar/escopar;
2. persistir intenção e idempotency key;
3. claim atômico;
4. executar uma vez;
5. persistir sucesso e estado local;
6. em resultado desconhecido, `uncertain` sem retry automático;
7. reconciliação/manual recovery pelo painel de confiabilidade.

Testes: provider nunca chamado antes da intenção; falha DB pré-efeito; timeout incerto; replay de idempotency key; zero-row; cross-account; retry apenas quando seguro.

## Lote P1-D — capacidade, rotas e migrations

- worker limit configurável 1–5, concorrência controlada e métricas de backlog/latência;
- testes direcionados das rotas `actions`, `messages`, `react`, `config`, `reconcile`;
- certificar migrations 001–045 em PostgreSQL efêmero no espaço do usuário;
- testar ACL, rollback, RLS, constraints e RPCs reais;
- validar browser autenticado no candidato.

## Lote P2-A — migrations 046–047: multi-instância e departamentos

### 046 — foundation

- departments, memberships e departamento padrão;
- `whatsapp_config.department_id`, `is_default`, identidade de webhook por config;
- snapshots em conversations, flow runs, automation logs/pending, broadcast recipients e jobs;
- signup/invite/redeem mantêm membership padrão;
- endpoints por `config_id` e departamentos;
- resolver determinístico: explícito → conversa → único default → único ativo → `ambiguous_config`.

### 047 — cutover

Somente após todos callers deixarem `.maybeSingle()`/`.limit(1)` ambíguos:

- remover one-config-per-account;
- unicidade ativa por conta/origem/instância;
- uma default por conta;
- RLS por departamento, mantendo owner/admin globais;
- compatibilidade temporária para conta com uma única config.

## Lote P2-B — migration 048: agentes especializados

- `ai_agents`, `ai_agent_bindings`, `conversation_agent_state`, `ai_agent_runs`, `ai_agent_events`;
- prioridade determinística: sticky → config+department → config → department → default;
- modos `disabled|draft_only|supervised|auto_reply`;
- cap/budget claim atômico antes do provider;
- handoff, auditoria, prompt/conhecimento account-scoped;
- persona “Secretária de IA NEXOR” apenas no tenant Anderson Menttor; demais perfis neutros.

## Lote P2-C — migration 049: transcrição assíncrona

- `transcription_jobs`, transcripts e enrichments;
- claim `SKIP LOCKED`, retry/backoff, stale recovery, dead letter;
- limites MIME/tamanho/duração e erro sanitizado;
- worker Python separado usando `faster-whisper` CPU/int8;
- nunca executar modelo pesado no webhook;
- histórico/reconcile não dispara IA por padrão.

## Lote P2-D — painel de confiabilidade

- tela administrativa separada;
- dead letters, uncertain, backlog, webhook/reconcile freshness, throughput e latência;
- ações de recovery com confirmação e auditoria;
- filtros por instância/departamento;
- nenhum efeito externo direto sem operação persistida.

## Lote P2-E — migration 050: Channels manual assistido

- canais, posts, revisões imutáveis, hash, aprovações e evidências;
- pacote manual exportável;
- confirmação humana do resultado;
- provider `manual` apenas;
- Evolution 2.3.7 falha fechado para `@newsletter`;
- publicação automática fica fora de escopo.

## Gates por lote

```bash
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
npm audit --omit=dev --audit-level=high
```

Além disso:

- migration test em PostgreSQL efêmero;
- servidor candidato em porta livre;
- browser autenticado e console;
- revisão independente spec-first e quality/security;
- relatório Obsidian e Kanban reconciliados.

## Rollout

1. backup e confirmação do projeto Supabase alvo;
2. migrations em ordem;
3. smoke queries e RLS;
4. promote `.next` → `.next-production`;
5. restart controlado do serviço/worker;
6. smoke HTTP/auth;
7. Evolution E2E controlado;
8. rollback de código e compensação documentada de schema quando aplicável.

Commit/push/merge continuam separados da certificação técnica e só ocorrem após revisão final de Anderson.
