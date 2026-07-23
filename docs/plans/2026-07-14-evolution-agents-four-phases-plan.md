# Plano TDD — Evolution, Agents e Multi-instância

Design: `docs/plans/2026-07-14-evolution-agents-four-phases-design.md`

## Ordem de execução

### Bloco A — Fundação Evolution (Fase 1)

1. Criar testes de contrato para timeout, webhook health, read receipt, presença e query de mensagens.
2. Estender `src/lib/whatsapp/evolution-api.ts` com chamadas tipadas e retry somente idempotente.
3. Criar rota `POST /api/whatsapp/conversations/[id]/read` e substituir reset direto na UI.
4. Ampliar verify-registration para validar `/webhook/find`.
5. Criar serviço de reconciliação idempotente e teste com fixture.
6. Fechar mídia inbound e fallback `getBase64FromMediaMessage`.
7. Rodar suíte focalizada, typecheck, lint, testes completos e build.

### Bloco B — Atendimento (Fase 2)

1. Testar payloads de botões/listas/localização/contato/sticker/enquete.
2. Implementar capabilities no wrapper.
3. Estender `ContentType`/normalização/renderização.
4. Criar rotas de chat actions com account/role/config scoping.
5. Adicionar validação/cache de números e perfil.
6. Browser check autenticado da inbox.

### Bloco C — Agents e áudio (Fase 3)

1. Migration local: `ai_agents`, `ai_agent_bindings`, `ai_agent_runs`, `ai_agent_events`, campos de transcript/enrichment.
2. Repositório e RLS por conta.
3. Router determinístico de agente.
4. Adapter de transcrição com fila e timeout.
5. Pipeline de enrichment estruturado.
6. UI de catálogo, binding e modos draft/supervised/auto_reply.
7. Testes de isolamento, handoff, caps, falha de provider e ausência de transcript.
8. Browser check autenticado.

### Bloco D — Multi-instância (Fase 4)

1. Migration local de departamentos e memberships.
2. Remover índice `whatsapp_config_one_active_per_account`; criar unicidade por instância.
3. Atualizar resolver para exigir preferência/contexto quando houver N configs.
4. Auditar todos os callers de config.
5. UI de instâncias/departamentos e filtros.
6. Escopar broadcasts/status e agents por config.
7. RPCs/métricas por instância/departamento/agente.
8. Testes multi-tenant e browser check.

### Bloco E — Canais

1. Confirmar suporte da API instalada.
2. Se suportado, criar migration/outbox/composer/approval worker.
3. Se não suportado, documentar upgrade/provider/manual-assisted; não criar endpoint falso.

## Comandos de verificação

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Além disso:

- servidor candidato em porta livre;
- navegação autenticada;
- console sem erros novos;
- chamadas Evolution apenas com fixtures até aprovação;
- comparação de migrations locais vs schema remoto antes do rollout.

## Gates de rollout

O código e migrations podem ser preparados localmente. Para produção, a ordem é indivisível:

1. backup/evidência do schema;
2. aplicar migrations aprovadas;
3. configurar webhooks aprovados;
4. promover build;
5. restart aprovado;
6. smoke test autenticado;
7. teste real controlado;
8. rollback se qualquer gate falhar.
