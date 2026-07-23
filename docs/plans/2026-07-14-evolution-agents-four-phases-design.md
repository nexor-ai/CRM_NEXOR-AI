# CRM NEXOR AI — Design das quatro fases Evolution, Agents e Canais

Data: 2026-07-14
Estado: execução local autorizada; produção requer gates humanos
Projeto: `/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI`

## Objetivo

Transformar o CRM atual em uma plataforma multiempresa para atendimento WhatsApp com Evolution API, agentes especializados, operação multi-instância, métricas e publicação governada, preservando isolamento por conta, rastreabilidade e handoff humano.

## Premissas

1. Evolution API 2.3.7 é o transporte WhatsApp atual.
2. Supabase é a fonte de verdade do produto; Evolution é transporte e fonte auxiliar de reconciliação.
3. Webhook é o caminho rápido, mas não pode ser o único mecanismo de consistência.
4. Nenhum agente publica, envia proposta, preço, promessa ou comunicação reputacional sem política explícita.
5. Mudanças locais, migrations e build candidato podem ser preparados sem aprovação; migration remota, restart, deploy e teste WhatsApp real exigem Anderson.
6. O dirty diff atual é preservado; não haverá rebase, reset ou refatoração ampla.
7. “Agents” do CRM são entidades multi-tenant do produto. Não são os 11 departamentos Hermes nem a crew Discord.
8. “Canais” significa provisoriamente WhatsApp Channels/newsletters. Grupos e broadcasts 1:1 são recursos diferentes.

## Arquitetura-alvo

```text
WhatsApp/Evolution
  ├─ webhook autenticado + idempotente
  ├─ health probe + reconciliação
  ├─ operações de chat/mensagem
  └─ instâncias por conta/departamento
          ↓
Next.js API / worker
  ├─ provider seam Evolution
  ├─ policies de envio e handoff
  ├─ agent router
  ├─ transcription/enrichment jobs
  └─ métricas/event log
          ↓
Supabase
  ├─ whatsapp_config (N instâncias por conta)
  ├─ conversations/messages com carimbo de instância
  ├─ ai_agents + bindings + runs + events
  ├─ media/transcripts/enrichments
  └─ RLS + RPCs atômicas
```

## Fase 1 — Confiabilidade operacional

### Escopo

- índice único `(message_id, whatsapp_instance)`;
- timeout para todas as chamadas Evolution e retry apenas em operações idempotentes;
- health check com estado da instância + `/webhook/find` + eventos/opções esperadas;
- read receipt real;
- presença `composing/recording/paused`;
- mídia inbound por `message.base64/mediaUrl` com fallback controlado;
- reconciliação por `findMessages` sem duplicar efeitos;
- telemetria de último webhook e última reconciliação.

### Definição de pronto

- testes unitários dos payloads;
- fixture webhook duplicada produz uma mensagem e um único disparo;
- health probe distingue “conectado” de “webhook operacional”;
- abrir conversa chama read receipt e zera unread local;
- timeout não reenvia POST de mensagem;
- reconciliação é idempotente.

## Fase 2 — Experiência de atendimento

### Escopo

- botões/listas nativos com fallback textual configurável;
- validação/cache de números;
- avatar, push name e perfil sem sobrescrever nome humano;
- localização, vCard, sticker e enquete;
- editar/apagar com auditoria local;
- arquivar/desarquivar e marcar como não lida;
- tipos e renderização do inbox.

### Decisão

Recursos nativos são capability-detected. Fallback textual permanece porque suporte Baileys/cliente pode variar.

## Fase 3 — IA e áudio

### Escopo

- fila assíncrona de transcrição;
- adapter de transcrição local (`faster-whisper`) atrás de interface;
- resumo, intenção e extração de ações/oportunidades;
- sugestão de resposta separada de auto-send;
- agente selecionado por binding conta/instância/departamento;
- handoff humano, limite por conversa, timeout, orçamento e auditoria;
- nenhum preço/prazo/promessa sem fonte/política.

### Estados do agente

- `draft_only`: apenas rascunha;
- `supervised`: executa ações não reputacionais e pede aprovação para envio sensível;
- `auto_reply`: responde dentro de política e cap;
- `disabled`.

## Fase 4 — Multi-instância e departamentos

### Escopo

- remover restrição de uma config por conta;
- uma configuração ativa por `(account_id, evolution_instance)`;
- departamentos internos;
- associação membro↔departamento e instância↔departamento;
- permissões por instância/departamento;
- roteamento de inbox, flows, broadcasts e agents;
- métricas por instância/agente/departamento;
- seleção explícita de instância em operações que hoje usam a única ativa.

### Migração segura

- manter compatibilidade com registros existentes;
- criar departamento padrão por conta;
- vincular configs atuais ao departamento padrão;
- não mudar a chave canônica de conversa `(account_id, contact_id)` nesta etapa;
- `whatsapp_config_id` continua sendo carimbo de transporte, não chave da thread.

## Canais do WhatsApp

Tratar como módulo separado após confirmar suporte real na versão instalada. O módulo deve ter:

- cadastro de canal e papel do usuário;
- composer e calendário editorial;
- aprovação humana obrigatória;
- outbox idempotente;
- mídia e status de publicação;
- auditoria;
- nenhuma reutilização indevida da fila de broadcasts 1:1.

Se Evolution 2.3.7 não tiver API oficial de Channels/newsletters, não simular via grupos nem status. Alternativas serão upgrade validado, provider separado ou operação manual assistida.

## Riscos

1. Dirty diff amplo: toda mudança deve ser cirúrgica e testada.
2. Migration multi-instância altera pressupostos de `.single()`/`maybeSingle()` em rotas existentes.
3. Native buttons/lists podem degradar em versões Baileys; fallback é obrigatório.
4. Transcrição em CPU precisa de fila e limites para não bloquear worker.
5. Reconciliação não pode redisparar IA/flows em mensagens históricas sem política.
6. Agents não podem compartilhar prompt, conhecimento ou credencial entre contas.
7. Publicação em canais é reputacional e exige aprovação humana.

## Gates humanos

- aplicar migrations remotas;
- reconfigurar webhooks vivos;
- restart de `wacrm.service`/worker;
- envio/teste real nas instâncias;
- publicação em canal;
- credenciais novas;
- deploy/commit/push/merge.
