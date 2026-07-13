# Instrução de Execução — PLANO_AJUSTE_EVOLUTION.md

> Use este arquivo como prompt ao solicitar a execução do plano (nesta sessão ou numa futura). Ele não substitui o plano — só define COMO ele deve ser implementado.

---

## 1. Antes de tocar em qualquer código

1. Leia `PLANO_AJUSTE_EVOLUTION.md` inteiro — não pule direto para o código.
2. Confirme que o estado do working tree está limpo (`git status`) antes de começar. Se houver mudanças não commitadas que não são suas, **pare e avise Anderson** — não sobrescreva trabalho em andamento.
3. Rode a checklist de baseline abaixo e registre o resultado ANTES de qualquer alteração — é o "estado inicial" contra o qual você vai comparar no final:
   ```bash
   cd /home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI
   npx tsc --noEmit && npx eslint . && npx vitest run
   ```

## 2. Regras absolutas (não negociáveis, valem para toda a execução)

- **VPS-only.** Nada de Netlify, nada de deploy remoto. Tudo roda e é testado localmente na VPS (`localhost` + Tailscale).
- **Zero `git push`.** As alterações ficam no working tree local. Só commitar se Anderson pedir explicitamente — e mesmo assim, nunca dar push sem autorização separada.
- **Zero `netlify deploy`** ou qualquer comando de deploy em produção.
- **Nenhum envio de mensagem real** a partir de um número real de WhatsApp sem aprovação explícita, mesmo em teste.
- **Nenhuma URL pública** exposta (sem Tailscale Funnel público, sem DNS novo) sem aprovação.
- Respeite os **Gates de aprovação explícitos** listados no plano (migration em produção, DELETE de rows legadas, restart do `wacrm.service`). Chegando em qualquer um desses pontos, **pare e pergunte** — não assuma "sim" implícito.

## 3. Ordem de execução — segue a ordem do plano, sem pular etapas

Execute na ordem definida em "Ordem de execução recomendada" do plano (D → C → B → E → A → F → G → H). Não reordene por conveniência, mesmo que outra frente pareça mais fácil — a ordem existe porque:
- D e C destravam a capacidade de configurar e usar o sistema (sem elas, nada mais é testável de verdade).
- B fecha o problema mais provável que o Anderson está enfrentando.
- E, A, F são cosmético/UX de baixo risco — vêm depois porque não bloqueiam nada.
- G e H têm gates de produção — sempre por último, e sempre com confirmação.

Para cada frente:
1. Implemente exatamente o que está especificado (arquivo, linha, trecho de código).
2. Se durante a implementação você achar que a especificação do plano está desatualizada (linha mudou, função foi renomeada, etc.), **não invente uma solução alternativa silenciosamente** — avise qual é a divergência encontrada e proponha o ajuste antes de aplicar.
3. Não adicione escopo além do que a frente pede. Se notar outro problema relacionado, anote separadamente para reportar no final — não misture no mesmo diff.
4. Ao terminar a frente, rode:
   ```bash
   npx tsc --noEmit && npx eslint . && npx vitest run
   ```
   Se algo quebrar, corrija antes de avançar para a próxima frente. Não acumule frentes com testes quebrados.

## 4. Nível de rigor exigido

- **Sem meio-termo**: se uma seção do plano diz "remover X se não houver caller em runtime", verifique de fato com `grep`/`tsc` antes de remover — não assuma.
- **Sem placeholder**: nenhuma implementação "TODO depois" ou stub. Se uma frente não puder ser 100% concluída por falta de informação (ex: variável de ambiente que só existe na VPS em produção), pare nessa frente e pergunte, não finja que está pronta.
- **Sem invenção de UX**: os textos/tooltips da Frente E devem seguir literalmente o que o plano especifica (PT-BR ou EN conforme indicado) — não redija variações "melhores" por conta própria.
- **Verificação de cada afirmação do plano contra o código atual**: antes de aplicar qualquer trecho de código do plano, confirme que o arquivo/linha ainda corresponde ao que está descrito. O plano foi escrito num momento específico do código — se houve deriva, isso é um achado a reportar, não um motivo para forçar a mudança do jeito errado.

## 5. Frente G (DB/Supabase) — cuidado redobrado

- **Não rode nenhuma migration nova em produção sem aprovação explícita**, mesmo que pareça trivial (ex: `COMMENT ON COLUMN`).
- Rode primeiro os SELECTs de verificação (G3 do plano) e reporte o resultado — só decida o próximo passo depois de ver o estado real do schema em produção.
- Se encontrar rows legadas (`phone_number_id != NULL` e `evolution_base_url IS NULL`), **não delete** — reporte quantas são e peça decisão do Anderson.

## 6. Frente H (restart do serviço) — gate obrigatório

- Build e valide em porta alternativa (3001) primeiro, sem tocar no `wacrm.service` produtivo.
- Só peça para reiniciar o serviço depois que TODAS as frentes anteriores passaram na checklist de verificação final do plano.
- A frase de gate é literal: pergunte "Anderson, posso reiniciar o wacrm.service agora?" — não assuma consentimento de mensagens anteriores da conversa.

## 7. Ao final — relatório obrigatório

Não encerre a execução só com "pronto". Entregue um relatório curto com:
1. Quais frentes foram 100% concluídas vs. quais ficaram bloqueadas (e por quê).
2. Resultado da checklist de verificação final (`tsc`, `eslint`, `vitest`, `next build`).
3. Qualquer divergência encontrada entre o plano e o código real (itens do item 3.2 acima).
4. Lista explícita dos gates que ainda aguardam aprovação de Anderson, com o que cada um desbloqueia.
5. Um veredito direto: "o CRM está pronto para teste E2E real com WhatsApp?" sim/não, e o que falta se for não.

---

**Resumo em uma frase**: implemente o plano exatamente como escrito, na ordem escrita, validando build/lint/testes a cada frente, sem pular gates de produção e sem inventar solução onde a especificação não bate com o código atual — e feche com um relatório honesto do que ficou pronto e do que não.
