# Plano de funcionalidades — CRM NEXOR AI + Evolution API

**Data:** 17/07/2026
**Status:** Proposta para aprovação de Anderson
**Baseline técnico:** Evolution API 2.3.7
**Departamento responsável:** AUTOMAÇÃO_E_INTEGRAÇÕES, com revisão de QUALIDADE_E_RISCO
**Projeto:** `/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI`
**Objetivo deste documento:** listar o que pode ser implementado, por que implementar, prioridade, dependências e riscos. Este documento ainda não é o checklist de execução.

---

## 1. Decisão de produto recomendada

A Evolution API deve permanecer como camada de transporte, sessão e eventos do WhatsApp. O CRM deve continuar como fonte de verdade para contatos, conversas, permissões, departamentos, campanhas, automações, agentes, auditoria e métricas.

```text
Evolution API = conexão, WhatsApp, entrega e eventos
CRM NEXOR AI = dados, operação, regras, equipes, IA e auditoria
```

Não é recomendável expor todos os endpoints da Evolution apenas porque existem. A prioridade deve ser dada às capacidades que aumentam segurança, confiabilidade, valor comercial e capacidade de atendimento.

A ordem proposta é:

1. segurança e consistência;
2. sincronização operacional;
3. multi-instância e departamentos;
4. atendimento enriquecido;
5. IA e automações avançadas;
6. módulos especializados e integrações opcionais.

---

## 2. Resultado esperado

Ao concluir as fases aprovadas, o CRM deverá ser capaz de:

- manter WhatsApp e CRM consistentes mesmo diante de falhas;
- conectar e monitorar uma ou várias instâncias;
- sincronizar contatos, chats, mensagens, labels e eventos;
- operar diferentes números e departamentos;
- controlar bloqueio, opt-out, perfil, privacidade e políticas da instância;
- oferecer atendimento humano, automações e agentes especializados;
- registrar auditoria e evidência das ações externas;
- expor funcionalidades avançadas sem duplicar responsabilidades com a Evolution;
- ser oferecido como produto B2B operável e suportável pela NEXOR AI.

---

# FASE 0 — Segurança, consistência e certificação

Esta fase é pré-requisito para ampliar o catálogo. O CRM já possui muitas funções, mas existem riscos de divergência entre WhatsApp, Evolution e Supabase.

## EVO-001 — Outbox idempotente para operações externas

**O que implementar:**

- registrar uma intenção antes de chamar a Evolution;
- gerar chave idempotente por operação;
- controlar estados `pending`, `processing`, `succeeded`, `failed` e `uncertain`;
- reconciliar operações cujo resultado externo seja desconhecido;
- impedir reenvio automático de mensagens após timeout incerto;
- aplicar o padrão a envio, reação, edição, exclusão, arquivamento e marcação como não lida.

**Por que implementar:** atualmente algumas operações podem acontecer no WhatsApp antes de o registro local ser persistido. Se o banco falhar depois, o WhatsApp muda e o CRM não registra a ação. Um retry pode duplicar o efeito.

**Valor:** confiabilidade, auditoria e redução de duplicidades.

**Prioridade:** P0.

---

## EVO-002 — Mídia privada e acesso por URL assinada

**O que implementar:**

- tornar privado o armazenamento de mídia de conversa;
- servir arquivos somente após autenticação e escopo de conta;
- emitir URLs assinadas de curta duração;
- definir retenção e expiração;
- registrar acesso quando necessário;
- revisar mídia inbound e outbound já armazenada.

**Por que implementar:** documentos, áudios e imagens de clientes não devem permanecer publicamente legíveis por URL permanente.

**Valor:** segurança, privacidade e preparação para clientes corporativos.

**Prioridade:** P0.

---

## EVO-003 — Presets fail-closed

**O que implementar:**

- bloquear envio quando o preset solicitado não existir;
- impedir que o nome técnico do preset seja enviado como mensagem;
- registrar erro operacional;
- validar preset antes de liberar a operação para a Evolution;
- adicionar teste para preset ausente, inativo e incompatível.

**Por que implementar:** o fallback atual pode transformar o nome de um preset em conteúdo enviado ao cliente.

**Valor:** proteção reputacional e prevenção de mensagens incorretas.

**Prioridade:** P0.

---

## EVO-004 — Autorização uniforme antes de qualquer efeito externo

**O que implementar:**

- exigir role apropriada para todas as mutações;
- padronizar `viewer`, `agent`, `admin` e `owner`;
- garantir login, role, conta, configuração e instância antes da chamada externa;
- corrigir especialmente a rota de reação;
- adicionar testes negativos provando que roles insuficientes não chamam o transporte.

**Por que implementar:** uma ação externa não pode depender apenas de sessão e RLS posterior.

**Valor:** controle de acesso e prevenção de abuso interno.

**Prioridade:** P0.

---

## EVO-005 — Painel de confiabilidade Evolution

**O que implementar:**

- interface administrativa para dead letters;
- eventos em retry;
- efeitos `failed` e `uncertain`;
- último webhook recebido;
- última reconciliação;
- backlog e idade do evento mais antigo;
- ação controlada de reprocessamento;
- filtro por conta e instância;
- alertas para acúmulo, desconexão e falhas repetidas.

**Por que implementar:** o backend possui estruturas de confiabilidade, mas a operação precisa enxergar e corrigir falhas sem consultar diretamente o banco.

**Valor:** suporte, diagnóstico e continuidade operacional.

**Prioridade:** P0.

---

## EVO-006 — Capacidade e paralelismo do worker

**O que implementar:**

- medir taxa de entrada e tempo médio de processamento;
- aumentar `worker_limit` com limite configurável;
- processar eventos independentes com concorrência controlada;
- preservar ordem por conversa/instância quando necessário;
- aplicar backpressure;
- criar métricas de backlog, throughput e latência;
- definir estratégia para retomada após indisponibilidade.

**Por que implementar:** o modelo atual pode processar apenas um evento por chamada e formar backlog em picos, campanhas ou múltiplas instâncias.

**Valor:** escalabilidade e menor latência da Inbox.

**Prioridade:** P0/P1.

---

## EVO-007 — Provisionamento reconciliável de instâncias

**O que implementar:**

- estados `requested`, `creating`, `connecting`, `configured`, `active`, `failed` e `orphaned`;
- persistir a intenção antes de criar a instância;
- compensar falhas parciais;
- usar `fetchInstances` para comparar CRM e Evolution;
- identificar instâncias órfãs;
- permitir retomada segura do provisionamento;
- registrar histórico de criação, conexão, logout e remoção.

**Por que implementar:** a Evolution pode criar a instância e o banco falhar depois, deixando recurso externo sem registro local.

**Valor:** operação segura e inventário confiável.

**Prioridade:** P1.

---

## EVO-008 — Certificação ponta a ponta da integração atual

**O que implementar/validar após autorização:**

- migrations aplicadas no Supabase correto;
- testes unitários e de integração;
- typecheck, lint e build;
- versão viva da Evolution;
- conexão real;
- `/webhook/find` correto;
- mensagem inbound e outbound controladas;
- status entregue/lido;
- mídia;
- reply citado;
- reação;
- edição e exclusão;
- reconciliação e dead letter;
- rollback documentado.

**Por que implementar:** código existente não equivale a funcionalidade certificada em produção.

**Valor:** base verificável para vender, operar e expandir.

**Prioridade:** P0.

**Gate humano:** chamadas reais, deploy, migrations e reinício exigem aprovação específica.

---

# FASE 1 — Sincronização operacional completa

## EVO-101 — Importação e sincronização de contatos

**O que implementar:**

- importar contatos existentes da Evolution;
- consumir `CONTACTS_SET`, `CONTACTS_UPSERT` e `CONTACTS_UPDATE`;
- preservar JID, telefone, LID e identificadores alternativos;
- atualizar push name, avatar e perfil sem sobrescrever dados curados pelo atendente;
- deduplicar por conta, telefone e identidade WhatsApp;
- mostrar divergências e conflitos.

**Por que implementar:** atualmente o CRM cria contatos a partir de mensagens, mas não possui sincronização completa dos eventos e do catálogo de contatos da Evolution.

**Valor:** onboarding rápido, dados atualizados e menos cadastros duplicados.

**Prioridade:** P1.

---

## EVO-102 — Importação e sincronização de chats

**O que implementar:**

- importar chats existentes;
- consumir `CHATS_SET`, `CHATS_UPSERT`, `CHATS_UPDATE` e `CHATS_DELETE`;
- refletir arquivamento e mudanças relevantes;
- detectar conversas criadas no celular;
- reconciliar chats ausentes;
- separar conversas individuais e grupos.

**Por que implementar:** ações realizadas fora do CRM precisam aparecer na operação.

**Valor:** visão completa da conta WhatsApp.

**Prioridade:** P1.

---

## EVO-103 — Importação controlada de histórico

**O que implementar:**

- wizard para selecionar período ou volume;
- estimativa antes da importação;
- importação paginada;
- checkpoint e retomada;
- deduplicação por instância e message ID;
- progresso visível;
- limites por lote;
- isolamento por tenant;
- ativação de automações somente depois da importação.

**Por que implementar:** conectar uma instância sem histórico reduz o valor do CRM e dificulta a continuidade do atendimento.

**Valor:** onboarding comercial e migração de operação existente.

**Prioridade:** P1.

---

## EVO-104 — Sincronização de mensagens editadas e apagadas

**O que implementar:**

- consumir `MESSAGES_EDITED` e `MESSAGES_DELETE`;
- refletir ações feitas pelo celular ou outra sessão;
- preservar conteúdo original;
- registrar origem, horário e instância;
- marcar visualmente mensagem editada ou apagada;
- impedir reexecução indevida de automação/IA.

**Por que implementar:** edição e exclusão podem ocorrer fora do CRM e precisam manter auditoria local consistente.

**Valor:** histórico confiável e conformidade.

**Prioridade:** P1.

---

## EVO-105 — Sincronização de status de entrega ampliada

**O que implementar:**

- consolidar status recebido, enviado, entregue, lido e falho;
- preservar avanço monotônico;
- tratar payloads diferentes por build/canal;
- detectar mensagens sem atualização;
- exibir motivo de falha quando disponível;
- reconciliar status periodicamente.

**Por que implementar:** campanhas, atendimento e métricas dependem de status confiável.

**Valor:** métricas reais e diagnóstico de entrega.

**Prioridade:** P1.

---

## EVO-106 — Labels nativas vinculadas às tags do CRM

**O que implementar:**

- listar labels da Evolution;
- adicionar/remover label no WhatsApp;
- consumir `LABELS_EDIT` e `LABELS_ASSOCIATION`;
- criar tabela de mapeamento label Evolution ↔ tag CRM;
- permitir sincronização unidirecional ou bidirecional;
- disparar filtros e automações por label.

**Por que implementar:** labels são úteis para operação no celular, enquanto tags CRM organizam processos internos. Um mapeamento evita perder qualquer uma das duas taxonomias.

**Valor:** segmentação, automação e continuidade entre celular e CRM.

**Prioridade:** P1.

**Regra:** não transformar tag CRM e label WhatsApp na mesma entidade física.

---

## EVO-107 — Bloqueio, desbloqueio e opt-out

**O que implementar:**

- bloquear/desbloquear contato pela Evolution;
- registrar motivo e autor;
- manter lista de bloqueados;
- impedir campanhas e automações para opt-out;
- interpretar palavras de descadastro conforme política;
- permitir desbloqueio somente por papel autorizado;
- auditar todas as mudanças.

**Por que implementar:** protege clientes contra spam e atende pedidos de não contato.

**Valor:** reputação, segurança e governança comercial.

**Prioridade:** P1.

---

## EVO-108 — Presença inbound e resposta inteligente

**O que implementar:**

- consumir `PRESENCE_UPDATE`;
- exibir `digitando`, `gravando` e presença relevante;
- atrasar resposta automática quando o cliente estiver digitando;
- não persistir presença como histórico permanente;
- limitar frequência de atualização na UI.

**Por que implementar:** melhora a experiência e reduz respostas automáticas interrompendo o cliente.

**Valor:** atendimento mais natural.

**Prioridade:** P2.

---

# FASE 2 — Multi-instância e departamentos

## EVO-201 — Múltiplas instâncias por conta

**O que implementar:**

- remover a restrição de uma única configuração ativa por conta;
- garantir unicidade segura por conta e instância;
- selecionar instância explicitamente no envio;
- filtrar Inbox, contatos, mensagens, campanhas e métricas;
- preservar roteamento da conversa para a instância correta;
- implementar health e reconciliação por instância;
- impedir envio por instância errada.

**Por que implementar:** rastreabilidade de instância já existe parcialmente, mas o CRM ainda resolve somente uma configuração ativa.

**Valor:** filiais, marcas, vários números e operação B2B real.

**Prioridade:** P1 estratégico.

---

## EVO-202 — Departamentos e vinculação de instâncias

**O que implementar:**

- departamentos internos do cliente;
- membros por departamento;
- instâncias permitidas por departamento;
- filas de atendimento;
- atribuição automática;
- transferência entre departamentos;
- métricas por equipe;
- horário e política por departamento.

**Por que implementar:** múltiplos números sem estrutura de equipe criariam apenas complexidade. Departamentos transformam instâncias em operação organizada.

**Valor:** comercial, suporte, financeiro e pós-venda separados.

**Prioridade:** P1 estratégico.

---

## EVO-203 — Permissões por instância e departamento

**O que implementar:**

- visualizar, responder, gerenciar e administrar por escopo;
- papel global e papel departamental;
- restrição de campanhas por instância;
- restrição de agentes/flows;
- auditoria de acesso cruzado;
- testes de isolamento multi-tenant e multi-instância.

**Por que implementar:** não basta filtrar a interface; o backend e o banco precisam impedir acesso a números não autorizados.

**Valor:** segurança e venda para organizações maiores.

**Prioridade:** P1.

---

## EVO-204 — Roteamento de automações, flows e agentes

**O que implementar:**

- vínculo por `whatsapp_config_id`;
- regras por instância;
- regras por departamento;
- fallback para humano;
- prevenção de dois agentes respondendo ao mesmo evento;
- prioridade entre flow, automação e IA;
- ownership explícito da conversa.

**Por que implementar:** ao adicionar múltiplas instâncias, uma regra global pode responder com persona ou número incorretos.

**Valor:** operação segura e personalizável.

**Prioridade:** P1.

---

# FASE 3 — Administração e atendimento enriquecido

## EVO-301 — Configurações operacionais da instância

**O que implementar:**

- rejeitar chamadas;
- mensagem para chamadas recusadas;
- ignorar grupos;
- always online;
- leitura automática de mensagens;
- leitura de Status;
- sincronização completa de histórico;
- explicação do efeito e risco de cada configuração;
- auditoria e confirmação para opções sensíveis.

**Por que implementar:** a Evolution expõe essas políticas, mas o operador precisa controlá-las pelo CRM com contexto.

**Valor:** administração centralizada.

**Prioridade:** P2.

---

## EVO-302 — Identidade, perfil e privacidade do número

**O que implementar:**

- nome da instância;
- foto;
- status/about;
- remoção de foto;
- configurações de privacidade;
- presença global;
- histórico e aprovação das mudanças.

**Por que implementar:** evita uso do manager da Evolution para tarefas rotineiras.

**Valor:** gestão do número dentro do produto.

**Prioridade:** P2.

**Gate humano:** mudanças reputacionais na identidade do número exigem confirmação explícita.

---

## EVO-303 — Perfil comercial e catálogo

**O que implementar:**

- consultar business profile;
- exibir catálogo e coleções;
- permitir selecionar produto durante o atendimento;
- registrar interesse;
- criar negócio no pipeline;
- gerar resposta com produto/link;
- cache e paginação.

**Por que implementar:** cria valor para varejo, alimentação, estética e e-commerce.

**Valor:** atendimento comercial e conversão.

**Prioridade:** P2, condicionada ao ICP.

---

## EVO-304 — Status do WhatsApp com aprovação

**O que implementar:**

- rascunho de Status de texto, imagem, áudio ou vídeo;
- audiência suportada;
- pré-visualização;
- aprovação humana;
- publicação;
- histórico e resultado;
- teste de compatibilidade por versão antes da liberação.

**Por que implementar:** transforma conteúdo e campanhas em presença no Status.

**Valor:** marketing e relacionamento.

**Prioridade:** P2 experimental.

**Restrição:** `sendStatus` contém ressalva/TODO no código oficial 2.3.7. Não prometer sem E2E.

---

## EVO-305 — Eventos de chamadas recebidas

**O que implementar:**

- consumir evento `CALL`;
- registrar chamada recebida/perdida;
- notificar equipe;
- criar tarefa de retorno;
- enviar resposta conforme política;
- medir chamadas por contato e instância.

**Por que implementar:** chamadas não atendidas são oportunidades e demandas de suporte.

**Valor:** follow-up e redução de perda de contato.

**Prioridade:** P2.

**Restrição:** não implementar chamada outbound em Evolution 2.3.7; o endpoint oficial retorna resultado fictício.

---

## EVO-306 — Mensagens ricas avançadas e compatibilidade

**O que implementar:**

- PTV/vídeo circular;
- botões avançados compatíveis: reply, URL, copiar, chamada e PIX quando suportados;
- validação completa de localização;
- validação de enquete;
- matriz de compatibilidade Baileys/Meta;
- fallback textual explícito;
- feature flags por instância.

**Por que implementar:** o CRM já possui mensagens ricas, mas pode ampliar formatos sem perder compatibilidade.

**Valor:** atendimento interativo.

**Prioridade:** P2.

---

# FASE 4 — IA e automação avançadas

## EVO-401 — Agentes especializados por instância/departamento

**O que implementar:**

- catálogo de agentes;
- bindings por instância e departamento;
- modos `disabled`, `draft_only`, `supervised` e `auto_reply`;
- prompt, modelo, conhecimento e limites próprios;
- runs e eventos auditáveis;
- ownership da conversa;
- handoff humano;
- orçamento e limite por conversa.

**Por que implementar:** a página atual de agentes não constitui uma arquitetura multiagente vinculada à operação.

**Valor:** agentes verticais e departamentais vendáveis pela NEXOR AI.

**Prioridade:** P1/P2 estratégico.

---

## EVO-402 — Transcrição de áudio

**O que implementar:**

- fila durável de transcrição;
- download seguro;
- `faster-whisper` em CPU;
- transcript persistido;
- status e retry;
- acesso controlado;
- uso opcional pela IA;
- política de retenção.

**Por que implementar:** áudios são frequentes no WhatsApp e hoje dificultam triagem, busca e automação.

**Valor:** produtividade, acessibilidade e contexto para agentes.

**Prioridade:** P1/P2.

---

## EVO-403 — Resumo e extração estruturada

**O que implementar:**

- resumo da conversa;
- intenção;
- urgência;
- próximos passos;
- dados de lead;
- produto/serviço citado;
- criação sugerida de negócio/tarefa;
- aprovação antes de efeitos comerciais;
- evidência e confiança da extração.

**Por que implementar:** transforma conversas em dados operacionais e reduz trabalho manual.

**Valor:** vendas, suporte e gestão.

**Prioridade:** P2.

---

## EVO-404 — Governança de resposta automática

**O que implementar:**

- prioridade formal entre flow, automação, agente e humano;
- janela de silêncio após intervenção humana;
- limite de respostas;
- proibição de preço/prazo/promessa sem política;
- handoff por baixa confiança;
- opt-out;
- replay seguro em homologação;
- log da decisão.

**Por que implementar:** ampliar IA sem ownership pode causar respostas duplicadas e promessas indevidas.

**Valor:** confiança e proteção reputacional.

**Prioridade:** P1.

---

# FASE 5 — Módulos especializados e opcionais

## EVO-501 — Gestão de grupos

**O que implementar:**

- inventário de grupos;
- informações e participantes;
- convites;
- administradores;
- entrada, saída e alterações;
- moderação;
- configuração de mensagens temporárias;
- módulo e modelo de dados separados da Inbox 1:1.

**Por que implementar:** grupos podem atender comunidades, suporte coletivo e operações educacionais.

**Valor:** vertical específico.

**Prioridade:** P3, somente com caso de uso aprovado.

**Risco:** automação em grupo pode responder publicamente e expor informação. Deve nascer desativada.

---

## EVO-502 — Templates oficiais Meta

**O que implementar:**

- somente para instâncias `WHATSAPP-BUSINESS`;
- listar, criar, editar e excluir templates;
- estados de aprovação;
- idioma e categoria;
- política e cobrança Meta;
- separação clara de presets locais.

**Por que implementar:** clientes que usam Cloud API dependem de templates aprovados.

**Valor:** suporte híbrido Baileys + Meta.

**Prioridade:** P3, dependente da estratégia de canais.

---

## EVO-503 — S3/MinIO para mídia

**O que implementar:**

- provider configurável;
- bucket privado;
- lifecycle;
- URLs assinadas;
- migração controlada;
- isolamento por tenant;
- métricas e falhas de upload.

**Por que implementar:** pode ser necessário quando volume, retenção ou custo ultrapassarem o uso adequado do Supabase Storage.

**Valor:** escalabilidade de mídia.

**Prioridade:** P3.

---

## EVO-504 — Barramentos de eventos

**Opções:** RabbitMQ, Kafka, SQS, NATS, WebSocket e Pusher.

**O que implementar quando necessário:**

- publicação seletiva de eventos;
- contratos versionados;
- consumidores idempotentes;
- dead letter;
- observabilidade;
- segurança e segregação.

**Por que implementar:** integração corporativa, analytics em tempo real ou alto volume.

**Valor:** extensibilidade e escala.

**Prioridade:** P3; não implementar sem demanda comprovada.

---

## EVO-505 — Integrações externas de bot/atendimento

**Opções oficiais:** Chatwoot, Typebot, OpenAI, Dify, Flowise, n8n, Evolution Bot e EvoAI.

**Estratégia recomendada:** não ativar como núcleo. Criar conectores opcionais apenas quando um cliente já depender do produto externo.

**Por que não usar diretamente como padrão:** o CRM já possui Inbox, flows, automações, IA, conhecimento, handoff e auditoria. Habilitar o mesmo comportamento dentro da Evolution pode gerar respostas duplicadas e dois estados de sessão.

**Prioridade:** P3, por implantação.

---

# 6. Recursos bloqueados ou não recomendados na baseline 2.3.7

## BLOQ-001 — Chamada outbound

Não implementar. `POST /call/offer/:instanceName` existe, mas a implementação Baileys 2.3.7 retorna dado fictício e o canal Meta rejeita a operação.

## BLOQ-002 — WhatsApp Channels/newsletters

Não implementar nem anunciar como capacidade Evolution 2.3.7. Não existe contrato REST público dedicado para CRUD, publicação ou administração de Channels/newsletters.

## BLOQ-003 — Edição de mídia enviada

Não prometer. A edição de texto existe; edição de mídia não possui contrato funcional confirmado na baseline.

## BLOQ-004 — Status como garantia de produção

Pode ser prototipado, mas só deve ser liberado após teste E2E da versão viva.

## BLOQ-005 — Paridade Baileys e Meta

Não assumir. Grupos, labels, presença, perfil, privacidade, arquivamento e outras operações possuem diferenças por canal.

## BLOQ-006 — Resposta duplicada por bot externo

Não habilitar agente do CRM e bot direto da Evolution para a mesma instância/conversa sem ownership e exclusão mútua formal.

---

# 7. Pacotes possíveis para aprovação

## Pacote A — Fundação segura

Inclui:

- EVO-001 a EVO-008.

**Resultado:** integração atual certificável, observável e preparada para expansão.

**Recomendação:** obrigatório antes dos demais.

## Pacote B — CRM WhatsApp operacional

Inclui:

- Pacote A;
- EVO-101 a EVO-108.

**Resultado:** sincronização completa, histórico, labels, opt-out e consistência com operações feitas no celular.

## Pacote C — CRM multi-instância B2B

Inclui:

- Pacotes A e B;
- EVO-201 a EVO-204.

**Resultado:** vários números, departamentos, permissões e roteamento. É o pacote com maior impacto comercial para transformar o CRM em produto empresarial.

## Pacote D — Atendimento inteligente

Inclui:

- Pacotes A, B e C;
- EVO-301 a EVO-306;
- EVO-401 a EVO-404.

**Resultado:** administração da instância, catálogo, Status experimental, chamadas inbound, transcrição e agentes especializados.

## Pacote E — Verticais e integrações

Inclui seletivamente:

- EVO-501 a EVO-505.

**Resultado:** grupos, Meta, S3 e ecossistema externo conforme cliente/ICP.

---

# 8. Ordem recomendada de aprovação

Minha recomendação é aprovar o plano conceitualmente nesta ordem:

1. **Pacote A — Fundação segura**;
2. **Pacote B — Sincronização operacional**;
3. **Pacote C — Multi-instância B2B**;
4. **EVO-401, EVO-402 e EVO-404 — agentes, transcrição e governança**;
5. catálogo, Status, grupos e integrações somente mediante caso comercial.

A maior oportunidade de produto é o Pacote C. A maior obrigação técnica é o Pacote A. Pular a fundação para acelerar funcionalidades aumentaria dívida e risco de inconsistência.

---

# 9. Decisões que Anderson deverá tomar antes do checklist

1. Aprovar apenas o Pacote A ou já aprovar A + B + C como direção completa.
2. Definir se multi-instância/departamentos é objetivo imediato do produto.
3. Definir política de retenção de mídias e conversas.
4. Decidir se o CRM continuará prioritariamente Baileys ou se suportará Meta Cloud como canal de primeira classe.
5. Definir os ICPs prioritários para catálogo, grupos e Status.
6. Definir quais ações externas exigirão aprovação humana por padrão.
7. Confirmar se agentes especializados serão vendidos por departamento, por instância ou por caso de uso.

Após aprovação, este plano deve ser convertido em checklist de execução com:

- tarefa granular;
- arquivo exato;
- teste falhando primeiro;
- comando de validação;
- dependências;
- gate humano;
- evidência esperada;
- definição de pronto;
- ordem de rollout e rollback.
