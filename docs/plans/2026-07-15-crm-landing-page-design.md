# Design — landing page CRM NEXOR AI

**Data:** 2026-07-15
**Departamento dono:** CONTEUDO_E_AUTORIDADE + HERMES_E_AGENTES
**Projeto:** `/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI`
**Rota de revisão:** `/crm`

## Objetivo

Criar uma landing page pública de apresentação do CRM NEXOR AI sem alterar o comportamento do painel autenticado, banco, integrações, serviços ou rota raiz existente.

## Público

Empresas brasileiras que atendem e vendem pelo WhatsApp e precisam organizar equipe, histórico, contatos, oportunidades, campanhas e automações.

## Proposta central

O CRM transforma conversas dispersas em uma operação com contexto, responsável e próximo passo. A IA é apresentada como assistência supervisionada, não como automação irrestrita.

## Direção visual

- Premium editorial NEXOR.
- Marfim/papel como base; grafite como contraste; dourado como destaque.
- Logo oficial sempre sobre superfície clara.
- Tipografia Helvetica Neue conforme guia de marca, com apoio editorial pontual em Georgia.
- Sem gradiente roxo, template SaaS azul ou claims não verificáveis.

## Escopo

- Hero orientado ao resultado operacional, com público qualificado e CTAs.
- Mockup visual do produto sem dados reais, adaptado para desktop e mobile.
- Diagnóstico do custo da operação fragmentada.
- Quatro camadas conectadas: relacionamento, vendas, automação e IA supervisionada.
- Recorte explícito de público: atendimento em equipe, venda consultiva e operação em crescimento.
- Método de implantação em quatro fases: diagnóstico, arquitetura, configuração e acompanhamento.
- Governança, permissões, rastreabilidade e revisão humana.
- FAQ comercial e CTA final.
- Responsividade desktop/mobile e acessibilidade básica.

## Fora de escopo

- Publicação/deploy.
- Mudança da raiz `/`.
- Alteração de autenticação ou cadastro.
- Formulário próprio de leads.
- Banco, Evolution API, Supabase, campanhas reais ou serviços systemd.

## Definição de pronto

1. `/crm` compila e renderiza sem erro.
2. `npm run typecheck`, lint e build pertinentes passam ou têm bloqueio documentado.
3. Página validada em navegador desktop e viewport móvel.
4. Sem overflow horizontal da página em ~390px.
5. Console sem erros na rota.
6. CTAs apontam para `/login`, âncoras internas ou contato oficial NEXOR.

## Evidência de validação

- `npm run typecheck`: aprovado.
- `npm run lint -- src/app/crm/page.tsx`: aprovado.
- Prettier dos arquivos novos: aprovado.
- Rota local: HTTP 200, HTML com os marcadores esperados.
- Browser: título absoluto NEXOR, `lang="pt-BR"`, FAQ funcional e console com 0 erros.
- Geometria em 780 px: `body.scrollWidth === body.clientWidth` e `main.scrollWidth === main.clientWidth`.
- Revisão profissional de 21:34 BRT: nova copy e hierarquia orientadas a conversão, sem métricas, clientes, depoimentos ou garantias inventadas.
- Nova captura desktop: `.qa-artifacts/crm-nexor-professional-desktop-1440.png` (1440×7100).
- Nova captura mobile: `.qa-artifacts/crm-nexor-professional-mobile-390.png` (390×10554).
- As duas capturas foram revisadas visualmente; mockup, grids, CTA, governança, FAQ e footer renderizam sem cortes.
- Verificação DOM após a revisão: 9 seções, 7 títulos `h2`, 5 FAQs, 3 CTAs externos consistentes e imagens completas.
- Geometria após a revisão: nenhum elemento fora da viewport em 780 px e `scrollWidth === clientWidth` para `body` e `main`.
- Console em contexto novo: 0 erros e 0 avisos.
- HTTP após a revisão: 200, `text/html`, com os marcadores comerciais esperados.
- Revisão independente inicial: `FAIL` por contraste insuficiente dos CTAs e linguagem absoluta em controles de governança.
- Correção pós-revisão: texto dos CTAs alterado para grafite; contraste calculado entre `4,96:1` e `6,10:1` (WCAG AA). Texto secundário ajustado para `4,93:1`.
- Claims de governança reescritos como opções configuráveis ou definições da implantação, sem garantia absoluta.
- Mockup tratado semanticamente como imagem ilustrativa (`role="img"`), sem botão fictício e com estados visuais identificados como demonstrativos.
- Link `Acessar` preservado no cabeçalho móvel.
- Evidências pós-correção: `.qa-artifacts/crm-nexor-professional-desktop-reviewed.png` e `.qa-artifacts/crm-nexor-professional-mobile-reviewed.png`.
- QA pós-correção: HTTP 200, console novo com 0 erros/avisos, nenhum overflow em 780 px, termos absolutos removidos e revisão visual desktop/mobile sem regressão concreta.
- Segunda revisão independente: `FAIL` por cinco textos pequenos ainda abaixo de `4,5:1` (identificador CRM, badge/estados verdes, números do FAQ e copyright).
- Segundo ciclo de contraste: identificador CRM `5,56:1`; badge verde `5,36:1`; estados verdes `5,99:1`; números do FAQ `5,13:1`; copyright `4,93:1`.
- Verificação consolidada dos sete pares críticos (incluindo CTAs): `WCAG_AA_TEXT_NORMAL=PASS`.
- Capturas finais desse ciclo: `.qa-artifacts/crm-nexor-final-aa-desktop.png` e `.qa-artifacts/crm-nexor-final-aa-mobile.png`.
- QA renderizado final do ciclo: HTTP 200, console sem erros, nenhum outlier/overflow e inspeção visual desktop/mobile sem regressão concreta.
- Terceira revisão independente fail-closed: `PASS`, sem bloqueios.
- Revisão confirmou ausência de combinações adicionais abaixo de `4,5:1` nas superfícies efetivas, sem segredos, HTML inseguro, handlers perigosos ou claims absolutos.
- Observações não bloqueantes: textos internos do mockup permanecem ilustrativos e agrupados por `role="img"`; foco nativo do navegador permanece disponível, embora não haja estilização própria de `:focus-visible`.
- `npm run build`: bloqueado por erro preexistente em `src/app/(dashboard)/flows/[id]/page.tsx`, que importa `node:dns/promises` em Client Component.
- `npm test`: 620 testes aprovados e 6 falhas preexistentes fora da landing (5 em `src/app/api/whatsapp/send/route.test.ts`; 1 em `src/app/api/whatsapp/conversations/[conversationId]/read/route.test.ts`).

## Estado final

Landing revisada para uma apresentação comercial mais executiva, validada por três ciclos de revisão independente e concluída em `/crm`. Veredito final: `PASS`, sem bloqueios. A página agora vende a organização da operação — não apenas funcionalidades — e torna público, método de implantação e governança explícitos. Não houve deploy, restart de serviço, migração, alteração de credencial, commit ou push.
