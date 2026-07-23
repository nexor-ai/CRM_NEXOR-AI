# Arquitetura — Publicação governada em WhatsApp Channels

Data da verificação: 2026-07-15 (Brasília, UTC-3)
Estado: design concluído; publicação automatizada bloqueada por capability ausente
Projeto: `/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI`
Versão auditada: Evolution API `2.3.7`, tag oficial no commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`

## Decisão executiva

A Evolution API 2.3.7 **não oferece uma API suportada para publicar em WhatsApp Channels/newsletters**.

Ela contém reconhecimento interno de JIDs de newsletter via Baileys, mas não expõe controller, rota, DTO ou serviço de publicação de canal. Os endpoints genéricos `sendText` e `sendMedia` também não são um atalho válido: o `createJid()` da própria 2.3.7 preserva apenas JIDs de usuário, grupo, LID e broadcast; um destino `@newsletter` é descartado/reformatado antes do envio.

A release oficial mais recente continua sendo `2.3.7`, e a branch oficial `main` não contém uma superfície adicional de newsletter. Portanto:

1. não criar endpoint falso no CRM;
2. não tratar canal como broadcast 1:1, grupo ou Status;
3. operar inicialmente em modo **manual assistido**;
4. preparar um módulo isolado, com aprovação humana obrigatória, capaz de receber no futuro um provider que prove suporte real de escrita.

## Evidência técnica

### Fonte oficial Evolution 2.3.7

Repositório/tag: <https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7>

- `package.json`: versão `2.3.7` e dependência `baileys: 7.0.0-rc.9`.
- `src/api/routes/sendMessage.router.ts`: publica rotas como `sendText`, `sendMedia` e `sendStatus`; não há rota de Channels/newsletters.
- `src/api/controllers/sendMessage.controller.ts`: não há operação de newsletter.
- `src/api/dto/sendMessage.dto.ts`: não há DTO de newsletter/canal.
- `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`: importa `isJidNewsletter` e usa o reconhecimento em lógica interna, mas não expõe operação pública de criação, descoberta administrativa ou publicação em canal.
- `src/utils/createJid.ts:35-70`: preserva `@g.us`, `@s.whatsapp.net`, `@lid` e `@broadcast`; não preserva `@newsletter`. O fluxo genérico transforma outro sufixo em usuário/grupo.
- Busca completa na árvore da tag por `newsletter`, `@newsletter`, `createNewsletter`, `followNewsletter` e `newsletterMetadata`: nenhum endpoint de publicação foi encontrado.

### Método de verificação executado

1. A referência `refs/tags/2.3.7` foi resolvida pela API oficial do GitHub para o commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.
2. A árvore Git completa desse commit foi consultada com `recursive=1`; o retorno indicou `truncated: false`.
3. O tarball oficial da tag foi carregado e todos os arquivos TypeScript, JavaScript, JSON e Markdown foram pesquisados, sem depender do índice de busca do GitHub.
4. Foram inspecionados os contextos das rotas, controllers, DTOs, serviço Baileys e `createJid()` citados acima.
5. A mesma busca foi repetida na branch oficial `main`.
6. A API de releases foi consultada e retornou `2.3.7` como release mais recente, publicada em 2025-12-05.

Saída material da verificação:

- tag: `refs/tags/2.3.7`;
- commit: `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`;
- árvore: `d88092bc6a96d643b2cf77a292a50de30071a276`;
- busca na árvore: não truncada;
- ocorrências relevantes na tag: changelog e reconhecimento interno por `isJidNewsletter`; zero rota/DTO/controller de publicação.

### Estado posterior

- A API do GitHub identifica `2.3.7` como a release oficial mais recente na data desta auditoria.
- A branch oficial `main` apresenta os mesmos usos internos de `isJidNewsletter`, sem rota de publicação.
- O Baileys upstream possui tipos/capacidades relacionados a newsletters, mas isso **não prova suporte da Evolution**: a Evolution não os expõe em sua API pública 2.3.7.

### Meta

A superfície pública encontrada para WhatsApp Channels na Meta Content Library é de pesquisa/leitura de conteúdo, não de publicação. Não foi identificado endpoint público oficial de escrita em Channels na WhatsApp Business Platform. Isso não deve ser convertido em afirmação eterna: a capability deve ser revalidada nas fontes oficiais antes de qualquer implementação futura.

## Separação de domínios

```text
WhatsApp 1:1
  conversations/messages + sendMessageToConversation

Broadcast 1:1
  broadcasts/broadcast_recipients + fila sequencial (mínimo 5 min)

Grupos
  domínio futuro próprio; não usar contacts/conversations como se cada grupo fosse pessoa

WhatsApp Channels
  channels/channel_posts/revisions/approvals/publication_attempts
  + provider capability explícita
  + aprovação humana obrigatória
```

O módulo de canais não deve importar nem chamar:

- `sendMessageToConversation()`;
- `createBroadcast()` ou `deliverBroadcast()`;
- `claim_next_broadcast_recipient()`;
- `sendTextMessage()`/`sendMediaMessage()` como tentativa de enviar para `@newsletter`;
- qualquer fluxo que crie `contact`, `conversation` ou `broadcast_recipient` para representar um canal.

A separação evita:

- misturar seguidores anônimos com contatos do CRM;
- aplicar intervalo e métricas de campanhas 1:1 a uma publicação única;
- gerar conversas artificiais;
- confundir grupo, Status e Channel;
- contornar o gate reputacional por uma rota antiga de envio.

## Arquitetura proposta

### 1. Provider seam com fail-closed

```ts
interface ChannelPublisherCapabilities {
  discoverChannels: boolean;
  publishText: boolean;
  publishImage: boolean;
  publishVideo: boolean;
  publishDocument: boolean;
  revokePost: boolean;
}

interface ChannelPublisher {
  readonly provider: string;
  capabilities(): Promise<ChannelPublisherCapabilities>;
  verifyAdmin(channelRef: string): Promise<VerificationResult>;
  publish(input: ApprovedChannelPublication): Promise<PublicationResult>;
}
```

Regras:

- `Evolution237ChannelPublisher` não deve existir enquanto não houver endpoint oficial comprovado.
- O provider inicial é `ManualAssistedChannelPublisher`, que nunca executa comunicação externa.
- Capability ausente bloqueia a transição para `publishing`; não degrada para grupo, Status ou broadcast.
- Toda chamada futura de escrita deve ter timeout, idempotency key e zero retry automático quando o resultado for incerto.
- Uma flag global de emergência (`CHANNEL_PUBLICATION_ENABLED=false` por padrão) deve permitir kill switch, mas não substituir o gate por registro.

### 2. Modelo de dados isolado

#### `whatsapp_channels`

- `id`, `account_id`, `whatsapp_config_id`;
- `provider`, `provider_channel_ref`;
- `display_name`, `description`;
- `admin_verification_status`: `unverified | verified | failed | stale`;
- `verified_at`, `verified_by`;
- `active`, `created_at`, `updated_at`;
- unicidade por `(account_id, provider, provider_channel_ref)`;
- RLS por conta.

Nunca aceitar apenas nome visível como identidade. O `provider_channel_ref` deve ser validado contra a instância e o papel de administrador antes de habilitar publicação.

#### `channel_posts`

- `id`, `account_id`, `channel_id`;
- `current_revision_id`;
- `status`: `draft | pending_approval | approved | ready_for_manual_publication | publishing | published | failed | uncertain | cancelled`;
- `scheduled_at`, `published_at`;
- `provider`, `external_message_id`, `external_permalink`;
- `created_by`, `created_at`, `updated_at`;
- `last_error_code`, `last_error_summary` sem credenciais/payload sensível.

#### `channel_post_revisions`

- `id`, `post_id`, `revision_number`;
- conteúdo canônico: tipo, texto/caption, mídia, alt text e metadados permitidos;
- `content_sha256`;
- `created_by`, `created_at`;
- imutável após criação.

Editar conteúdo cria nova revisão, altera `current_revision_id`, volta o post para `draft` e invalida qualquer aprovação anterior.

#### `channel_post_approvals`

- `id`, `post_id`, `revision_id`, `content_sha256`;
- `decision`: `approved | rejected | revoked`;
- `decided_by`, `decided_at`, `reason`;
- append-only para auditoria.

Uma aprovação é válida somente quando `revision_id` e `content_sha256` ainda correspondem à revisão atual.

#### `channel_publication_attempts`

- `id`, `post_id`, `revision_id`, `approval_id`;
- `provider`, `idempotency_key` única;
- `mode`: `manual_assisted | automated`;
- `status`: `claimed | dispatched | confirmed | failed | uncertain`;
- `request_fingerprint`, `external_message_id`, `external_permalink`;
- timestamps e erro sanitizado.

O histórico nunca deve ser apagado por retry. Resultado incerto exige revisão humana; não há reenvio automático.

### 3. Estados e gates

```text
draft
  → pending_approval       autor submete preview final
  → draft                  qualquer alteração cria nova revisão

pending_approval
  → approved               owner/admin aprova a revisão exata
  → draft                  rejeição devolve para edição

approved
  → ready_for_manual_publication  provider manual
  → publishing                    somente provider automatizado comprovado
  → draft                          aprovação revogada/expirada

publishing
  → published              resposta inequívoca + external_message_id
  → failed                 falha inequívoca antes do envio
  → uncertain              timeout/queda após despacho; nunca retry automático

ready_for_manual_publication
  → published              operador confirma publicação e registra evidência
  → cancelled              operador desiste
```

Aprovação humana é sempre obrigatória, inclusive para post agendado. Agendar define intenção de horário; não autoriza conteúdo.

### 4. APIs internas

- `POST /api/channels` — cadastra referência; não publica.
- `POST /api/channels/:id/verify` — no modo manual registra verificação assistida; no futuro consulta provider read-only.
- `POST /api/channels/posts` — cria draft/revisão.
- `POST /api/channels/posts/:id/submit` — congela preview e pede aprovação.
- `POST /api/channels/posts/:id/approve` — owner/admin; grava aprovação da revisão exata.
- `POST /api/channels/posts/:id/reject` — grava decisão e motivo.
- `POST /api/channels/posts/:id/revoke-approval` — invalida aprovação ainda não publicada.
- `POST /api/channels/posts/:id/prepare-manual` — gera pacote manual da revisão aprovada.
- `POST /api/channels/posts/:id/confirm-manual-publication` — exige evidência e registra resultado.
- `POST /api/internal/channels/publication-worker` — segredo de worker, somente para provider automatizado comprovado.

Nenhuma dessas rotas deve compartilhar scope público `broadcasts:send`. Se houver API pública no futuro, usar scope próprio, por exemplo `channels:draft`; a ação `channels:publish` deve continuar restrita e subordinada a aprovação persistida.

### 5. Modo manual assistido — recomendação atual

O CRM gera um pacote imutável da revisão aprovada:

- preview exato do texto/caption;
- mídia final e checksum;
- canal-alvo verificado;
- aprovador, data e hash aprovado;
- checklist operacional;
- botão de copiar texto e abrir instruções, sem automação de clique/publicação;
- expiração opcional da aprovação.

O operador publica pelo aplicativo oficial do WhatsApp e retorna ao CRM para registrar:

- confirmação explícita;
- horário;
- link/identificador externo quando disponível;
- evidência visual opcional, sem expor dados desnecessários;
- divergência entre o conteúdo aprovado e o publicado, se houver.

O sistema recalcula o hash do pacote antes da confirmação. Conteúdo divergente não herda a aprovação; deve ser marcado para reconciliação.

### 6. Worker automatizado futuro

Só pode ser habilitado quando uma fonte oficial e um teste controlado provarem:

1. endpoint de escrita suportado na versão instalada;
2. identificação estável do canal;
3. validação de papel administrativo;
4. tipos de mídia realmente suportados;
5. retorno inequívoco de `external_message_id`;
6. comportamento sob timeout e duplicidade;
7. webhook ou consulta de reconciliação;
8. termos operacionais aceitáveis para a NEXOR.

Algoritmo:

1. claim atômico de um post `approved` cuja aprovação corresponde à revisão atual;
2. revalidar canal, instância, capability, hash, horário e kill switch;
3. criar attempt com idempotency key;
4. despachar uma única vez;
5. persistir resposta;
6. marcar `published`, `failed` ou `uncertain`;
7. notificar operador em falha/incerteza;
8. nunca trocar provider nem destino automaticamente.

## Segurança e controles

- RLS por `account_id`; aprovação restrita a owner/admin.
- Separação de funções recomendada: autor e aprovador distintos quando houver equipe.
- CSRF/origin checks nas rotas do dashboard e rate limit separado.
- Não aceitar base URL arbitrária por post; provider e transporte vêm de configuração governada.
- Mídia deve ser snapshot imutável ou URL allowlisted, com MIME, tamanho e checksum validados; bloquear SSRF.
- Logs não armazenam API key, cookies, conteúdo privado completo ou payload bruto sensível.
- Auditoria append-only para revisões, aprovações e tentativas.
- Publicação nunca parte de automações, flows ou agentes sem passar pelo mesmo registro de aprovação.
- `scheduled_at` não pode ser retroativo nem superar a validade da aprovação.
- Canal desverificado, instância desconectada, capability ausente ou hash divergente = bloqueio fail-closed.
- Timeout após possível envio = `uncertain`, sem retry automático.
- Remoção/edição externa de post é capability distinta e exige nova aprovação humana.

## Plano de implementação

### Etapa C0 — agora

- manter publicação automatizada desabilitada;
- registrar este veredito;
- não criar wrapper Evolution de Channels;
- operar publicação fora do CRM até o modo manual assistido existir.

### Etapa C1 — módulo manual assistido

- migration das cinco tabelas isoladas e RLS;
- composer, revisão imutável e preview;
- submit/approve/reject/revoke;
- pacote manual e confirmação com evidência;
- testes de transição, tenancy, hash e invalidação da aprovação;
- nenhuma chamada externa de publicação.

### Etapa C2 — capability probe

- script/teste read-only que identifica versão instalada e capabilities do provider;
- relatório sem credenciais;
- `ManualAssistedChannelPublisher` como único provider habilitado.

### Etapa C3 — automação futura, condicionada

- reabrir fontes oficiais da versão candidata;
- criar adapter somente após endpoint real;
- testes de contrato com fixture;
- teste real em canal não produtivo, após aprovação de Anderson;
- ativação gradual por conta/canal, com kill switch e observação.

### Donos, dependências e rollback

- C1 — dono: `AUTOMACAO_E_INTEGRACOES`, com revisão de `QUALIDADE_E_RISCO`; dependências: Supabase, autenticação/RLS e UI do CRM. Rollback: manter feature flag desligada, remover o item de navegação e deixar as tabelas aditivas sem worker ativo. Nenhum dado existente de mensagens/broadcasts é alterado.
- C2 — dono: `AUTOMACAO_E_INTEGRACOES`; dependência: fonte oficial do provider. Rollback: remover/desabilitar o probe read-only; não há efeito externo nem alteração de canal.
- C3 — dono técnico: `AUTOMACAO_E_INTEGRACOES`; aprovação: Anderson; revisão: `QUALIDADE_E_RISCO`. Dependências: provider comprovado, credencial governada, worker, observabilidade e canal de teste. Rollback: kill switch, suspensão do worker e retorno ao modo manual assistido. Publicação já realizada é irreversível pelo CRM e exige procedimento de despublicação aprovado, quando o provider oferecer essa capability.

Antes de qualquer migration remota de C1, produzir backup do schema/dados afetados e plano SQL reverso. Como o design é aditivo, a reversão operacional preferida é desabilitar o módulo; `DROP TABLE` não deve ser usado como rollback automático quando já houver trilha de auditoria.

## Definição de pronto para C1

- canal não aparece em Contacts, Inbox, Groups ou Broadcasts;
- toda publicação tem revisão imutável e aprovação vinculada ao hash;
- editar após aprovação impede publicação;
- usuário sem papel permitido não aprova;
- publicação manual deixa trilha de auditoria;
- nenhuma rota externa é chamada por testes ou worker;
- estado `uncertain` nunca reenvia;
- testes de RLS/tenant e concorrência de aprovação passam;
- UI mostra claramente “manual assistido — nenhuma publicação automática”.

## Gates de Anderson

Exigem autorização explícita:

- aplicar migrations remotas;
- ativar provider de escrita;
- configurar/alterar credencial;
- executar teste real de publicação;
- publicar qualquer conteúdo;
- habilitar worker recorrente;
- deploy, restart ou promoção para produção.

## Riscos e ângulo cego

O maior risco não é apenas técnico; é reputacional. Como Channels é comunicação pública ou semi-pública, reaproveitar a infraestrutura de campanhas criaria uma rota de contorno para conteúdo não aprovado. O gate precisa estar no modelo transacional e no worker, não apenas em um modal da interface.

Outro risco é confundir capacidade do Baileys upstream com contrato suportado pela Evolution. Uma função interna ou tipo disponível na dependência não equivale a endpoint estável, observável e operável. Um fork para expor essa função aumentaria risco de quebra, bloqueio de conta e dívida de manutenção; não é a escolha recomendada para produção.

## Recomendação

Implementar primeiro C1, manual assistido, como domínio isolado. Não tentar publicação automática com Evolution 2.3.7 e não iniciar um fork de Baileys. Reavaliar automação somente quando existir endpoint de escrita oficialmente exposto por um provider e puder ser validado ponta a ponta em canal de teste com aprovação humana.
