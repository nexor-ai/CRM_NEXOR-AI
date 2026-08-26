---
title: "Plano de certificação — piloto interno e cliente CRM NEXOR"
data: 2026-08-24
status: em-andamento
responsavel: Nexo
runtime: /home/hermes/ESCRITORIO_NEXOR-AI/tools/crm-nexor
acesso: https://vps-contabo.tail23fa54.ts.net:3010/login
---

# Plano de certificação — piloto interno e cliente CRM NEXOR

## Regra de avanço

Uma etapa só fecha quando tiver evidência atual, registrada e reproduzível. Falha ou evidência incompleta bloqueia a próxima etapa.

## 1. Login autenticado real

**Objetivo:** provar que `andersonmenttor@gmail.com` acessa e mantém sessão no CRM após o callback de magic link.

**Ação:** gerar magic link para o e-mail existente, abrir no navegador e validar `/auth/callback` → `/dashboard`.

**Pronto quando:**
- sessão persiste após reload;
- `/dashboard`, `/inbox`, `/contacts`, `/pipelines`, `/flows`, `/automations`, `/broadcasts`, `/notifications` e `/settings` abrem autenticados;
- console sem exceção e APIs sem 4xx/5xx inesperado;
- logout e novo login funcionam.

**Gate humano:** autorizar o envio do magic link para o e-mail de Anderson.

## 2. WhatsApp/Evolution ponta a ponta

**Objetivo:** provar a cadeia `CRM → Evolution → WhatsApp → Evolution → CRM` sem afetar terceiros.

**Ação:** usar exclusivamente o número de Anderson terminado em `5916`; criar contato/conversa de teste; enviar uma única mensagem aprovada; responder pelo celular; conferir inbox, status e log de evento no CRM.

**Pronto quando:**
- mensagem enviada aparece com ID/status no CRM;
- resposta do celular aparece uma vez na inbox correta;
- não há duplicação, falha silenciosa ou roteamento entre contas;
- logs do worker estão limpos;
- o artefato de teste fica identificado como interno e removível/arquivável com autorização.

**Gate humano:** texto exato da mensagem e autorização de envio real.

## 3. IA

**Objetivo:** tornar explícito se IA é parte do piloto e, se for, entregar uma integração com limite, custo e fallback.

**Decisão necessária:** provider e limite de custo. Recomendação inicial: provider já aprovado no cofre NEXOR, modelo econômico e teto mensal baixo; caso não exista provider aprovado, deixar IA desativada no piloto.

**Pronto quando:**
- provider configurado sem segredo em Git/logs;
- teste de geração usa dados sintéticos;
- falha do provider não bloqueia inbox, automação ou envio;
- custos, timeout e fallback estão registrados;
- mensagem automática permanece desativada até aprovação editorial.

**Gate humano:** escolha/aprovação do provider e do teto de custo.

## 4. Recuperação de desastre

**Objetivo:** certificar que o dump atual pode voltar a um ambiente compatível.

**Ação:** criar projeto Supabase de homologação ou ambiente Supabase compatível isolado; restaurar o dump; validar schema, `schema_migrations`, contatos, contas e permissões sem expor dados.

**Pronto quando:**
- restore termina sem erro crítico;
- schema/migrations batem com produção;
- app de homologação conecta com credenciais próprias;
- backup offsite tem retenção definida e evidência de último job;
- runbook de restore e RTO/RPO estão documentados.

**Gate humano:** criação/uso de ambiente de homologação e eventual custo associado.

## 5. Jornada operacional e cliente piloto

**Objetivo:** provar operação de ponta a ponta e preparar a primeira implantação isolada.

**Jornada interna:** login → criar contato → criar negócio → mover pipeline → receber/responder conversa de teste → registrar tarefa/automação sem envio → gerar relatório básico.

**Cliente piloto:**
- instância de CRM isolada;
- Supabase/banco, Evolution e `.env` próprios;
- conta administrativa do cliente separada;
- backup e atualização assistida próprios;
- onboarding, suporte, retorno e rollback documentados.

**Veredito de liberação:** somente após as etapas 1–4 em `GO` e a jornada interna passar sem falha.

## Não permitido antes da liberação

- compartilhar instância ou banco da NEXOR com cliente;
- enviar broadcast ou automação para contatos reais;
- promessa comercial de IA ou WhatsApp sem E2E certificado;
- atualização automática sem backup e janela operacional.
