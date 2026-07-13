# Plano de Ajuste — CRM_NEXOR-AI 100% Evolution API (VPS-only)

> **Path:** `/home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI`
> **Estado inicial:** typecheck ✓ | lint ✓ | build ✓ | 557 testes ✓ — fork está saudável; falta alinhar runtime + UX ao Evolution
> **Restrições absolutas (Anderson):**
>   - **VPS-only**: tudo fica no servidor local. O build do Next roda na VPS e serve aApp via `wacrm.service` em localhost + Tailscale. Nada de Netlify.
>   - **Zero Git push / Netlify deploy** — proibido. As alterações ficam localmente no working tree da VPS.
>   - **Sem enviar para fora** (sem clients externos reais, sem clientes reais): qualquer "validação real" precisa de approvação explícita do Anderson.
> **Criado em:** 2026-07-04 por Nexo. ATUALIZADO em 2026-07-04 com correções de frontend.

---

## Stack mapeado (original vs. fork)

### Original (github.com/ArnasDon/wacrm)
- Transporte WhatsApp: **Meta Cloud API** (`graph.facebook.com/v21.0`)
  - `phone_number_id` + `access_token` (WABA) + `verify_token` + PIN 2FA
  - Webhook: assinado HMAC-SHA256 (`META_APP_SECRET` + `x-hub-signature-256`); GET faz handshake `hub.challenge`
  - Registro: `POST /{phone_number_id}/register` (PIN) + `POST /{waba_id}/subscribed_apps` — sem isso, sem inbound
  - Templates: submetidos ao Graph; aprovação assíncrona (`Pending → Approved/Rejected`)
  - Media: `uploadResumableMedia` + `getMediaUrl`/`downloadMedia` (Graph media-id)
  - DB `whatsapp_config` (001): `phone_number_id TEXT NOT NULL`, `access_token TEXT NOT NULL`, `waba_id TEXT`, `verify_token TEXT`, UNIQUE em user_id (post-017: account_id)
- 3 motores Meta: `send-message.ts` (inbox + API v1), `automations/meta-send.ts` (automações), `flows/meta-send.ts` (fluxos)
- Frontend `whatsapp-config.tsx`: form pedindo `phone_number_id`, `waba_id`, `access_token`, `verify_token`; botão "Verify Registration"
- Frontend `template-manager.tsx`: tela "Submit to Meta for Approval", "Sync from Meta", "Meta quality score"
- Frontend `message-thread.tsx`: timer de sessão 24h; quando expirado, composer bloqueia
- Frontend `template-picker.tsx` (inbox): "Meta requires every variable to be set"

### Fork (CRM_NEXOR-AI) — estado atual
- Transporte novo: `src/lib/whatsapp/evolution-api.ts` exporta funções equivalentes
- `meta-api.ts` virou shim `export * from './evolution-api'`
- Migration 031 adiciona colunas Evolution à `whatsapp_config` (`evolution_base_url`, `evolution_instance`, `evolution_api_key`, `connection_state`) + torna `phone_number_id`/`access_token` nullable + drop UNIQUE + novo UNIQUE em `evolution_instance`
- Webhook (`webhook/route.ts`) reescrito: trocou HMAC por `verifyEvolutionWebhookToken` (token via `?token=` ou `x-wacrm-webhook-token`); POST mapeia eventos Evolution (`connection.update`, `messages.upsert`, `messages.update`, `send.message`) para o schema interno
- Config route reescrito: chama `createInstance` + `connectInstance` (QR) + `setInstanceWebhook`; GET faz `getConnectionState`
- `send-message.ts`, `broadcast/route.ts`, `broadcast-core.ts`, `flows/meta-send.ts`, `automations/meta-send.ts` — todos trocaram import para `evolution-api` e leem `config.evolution_*`
- `templates/sync/route.ts` (local-only) e `templates/submit/route.ts` (`status='APPROVED'` automático)
- Backend sem falhas — typecheck/lint/build/testes todos passam

### Resíduos Meta identificados (BACKEND)
- `webhook-signature.ts:18`: `verifyMetaWebhookSignature()` no-op (mantém órfão)
- `webhook-signature.test.ts:26`: testa o shim legado
- `registration.test.ts`: importa `registerPhoneNumber`/`subscribeWabaToApp` do shim (no-ops)
- `send-message.ts:82` (JSDoc): "Meta's `wamid`"
- `flows/meta-send.ts`, `flows/engine.ts:19,25-26,276-278`, `automations/meta-send.ts` — comentários comentário Meta
- `media/[mediaId]/route.ts`: 410 com mensagem clara — OK
- `types/index.ts:252-253`: `subscribed_apps_at?` e `last_registration_error?` (nullable) — runtime OK

### Resíduos Meta identificados (FRONTEND — precisa correção)
1. `whatsapp-config.tsx` — **sem botão Save Confirmation visível**. Handlers `handleSave` (L165) e `handleTestConnection` (L240) estão definidos mas só há JSX `onClick` para `handleVerifyRegistration` (L440) e `handleReset` (L367). Os botões Save e Test não estão renderizados.
2. `template-manager.tsx` (45KB) — cheio de UX Meta:
   - L285-289: toast "Edit submitted — Meta typically reviews within 24 hours" / "Submitted to Meta — typical review time is 24 hours"
   - L296-312: função `handleSyncFromMeta()` ainda nomeada assim; toast "Synced X templates from Meta"
   - L487 SettingsPanelHead description: OK ("Create local WhatsApp presets for Evolution...")
   - L491-499: botão "Refresh presets" chama `handleSyncFromMeta` — funcional mas o nome interno + toast ainda citam Meta
   - L549: tooltip "Meta quality score"
   - L579: tooltip "Editing triggers Meta re-review — status flips to PENDING"
   - L592: tooltip "Edit the template and resubmit to Meta for review"
   - L606-612: dialogs de delete "Delete template from Meta and locally" / "Delete from Meta and locally"
   - L648: "Save your changes to re-submit to Meta. Status will flip back to PENDING during review"
   - L649: "Build a template and submit it to Meta for approval. Once approved..."
   - L676: "Name is fixed once a template exists on Meta..."
   - L729: "Language is fixed once a template exists on Meta"
   - L732: "Must match the exact code on Meta — en_US"
   - L792: placeholder "Sample value for {{1}} (required for Meta review)"
   - L855-856: "we upload it to Meta for review automatically" / "Meta fetches it once during review"
   - L886: "Sample values (Meta uses these to review your template)"
   - L1080: "Submit for Approval" (botão com texto antigo)
   - L1100-1102: dialog delete citando "real Meta delete"
3. `template-picker.tsx` (inbox) L197: "Fill in the placeholders to render this template. Meta requires every variable to be set."
4. `message-thread.tsx` L222-246: `sessionInfo` calculado com `hoursSince >= 24` → `expired: true`
5. `message-thread.tsx` L850: badge "Expired" em vermelho no header
6. `message-thread.tsx` L1076: `<MessageComposer sessionExpired={sessionInfo.expired} ...>`
7. `message-composer.tsx` (todo): `sessionExpired` bloqueia textarea + paperclip + botão send; banner "24-hour session expired. Use a template to re-engage."
8. Outros com referencias Meta (cosmético): `automations/templates.ts`, `presence.ts`

---

## Plano de ajuste (8 frentes)

### Frente A — Backend cosmético (sem risco)

- `send-message.ts:82` — JSDoc `/** Meta's wamid */` → `/** Evolution/Baileys key.id for the delivered message */`
- `send-message.ts:74` (comentário "sends to Meta") → "sends to Evolution"
- `flows/meta-send.ts` — JSDoc "Meta API calls" → "Evolution API calls"; "Meta already has the message" → "Evolution already has the message"
- `automations/meta-send.ts` — mesmas trocas em comentários
- `flows/engine.ts:19,25-26,276-278` — JSDoc "Meta message" → "Evolution/Baileys message"; `meta_message_id` no tipo interno permanence (o DB usa `message_id`)
- `whatsapp/webhook-signature.ts:18` — remover `verifyMetaWebhookSignature` se não há runtime caller; inspecionar com `grep -r verifyMetaWebhookSignature src/`. Se só usado em test, remover função + teste legado juntos. **NÃO remover** se `meta-api.ts` shim ainda a exportar.
- `types/index.ts:252-253` — atualizar JSDoc de `subscribed_apps_at` e `last_registration_error` para "legacy Meta field — NULL on Evolution deployments"
- `evolution-api.ts:208,213` — melhorar JSDoc explicando que são no-ops legados

### Frente B — Webhook inbound: robustez (P0)

**Sintoma principal que você provavelmente está vendo:** mensagens enviadas do WhatsApp não chegam no inbox.

**B1 — Validar entrega do token via setInstanceWebhook**
Verificar em runtime que a Evolution tem a URL registrada com `?token=...`:
```bash
# Após re-salvar config pela UI (uma vez que o Save button funcionar via Frente C):
curl -s -H "apikey: $EVOLU...KEY" \\
  http://127.0.0.1:8080/webhook/find/NEXOR_AI | jq
```
Confirmar `.webhook.url` contém `?token=...`.

**B2 — Adicionar fallback header `x-evolution-webhook-token`** em `webhook-signature.ts`:
```typescript
const received =
  url.searchParams.get('token') ||
  request.headers.get('x-wacrm-webhook-token') ||
  request.headers.get('x-evolution-webhook-token') ||  // NOVO
  ''
```
E em `evolution-api.ts` `setInstanceWebhook`, enviar `headers: { "x-evolution-webhook-token": process.env.WHATSAPP_WEBHOOK_TOKEN }` junto (se var existir).

**B3 — Tratar `@lid` e `@g.us` em remoteJid** (`webhook/route.ts:normalizeEvolutionMessage`):
```typescript
const remote = String(key.remoteJid || '')
if (!remote.includes('@s.whatsapp.net')) {
  // @lid ou @g.us — não é um contato telefônico válido
  console.warn('[webhook] ignoring non-whatsapp remoteJid:', remote)
  return null
}
return remote.replace(/@.*/, '')
```

**B4 — Try/catch por item no loop `messages.update`** (`webhook/route.ts:processEvolutionWebhook`):
```typescript
if (event.includes('messages.update') || event.includes('send.message')) {
  const rows = Array.isArray(body.data) ? body.data : [body.data]
  for (const row of rows) {
    try { await handleStatusUpdate({ ... }) }
    catch (err) { console.error('[webhook] status update failed for', row?.key?.id, err) }
  }
  return
}
```

### Frente C — Settings WhatsApp UI (botão Save + UX)

**C1 — Adicionar botões Save + Test Connection no JSX** de `whatsapp-config.tsx`. Atualmente só existem `handleReset` (L367) e `handleVerifyRegistration` (L440) como `onClick`. Inserir logo abaixo do `<Card>` "API Credentials" (após o bloco do Accordion):
```tsx
<div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
  <Button
    type="button"
    variant="outline"
    onClick={handleTestConnection}
    disabled={testing || !config}
    className="border-border text-foreground hover:bg-muted"
  >
    {testing ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
    Test Connection
  </Button>
  <Button
    type="button"
    onClick={handleSave}
    disabled={saving}
    className="bg-primary hover:bg-primary/90"
  >
    {saving ? <Loader2 className="size-4 animate-spin" /> : null}
    Save Configuration
  </Button>
</div>
```

**C2 — Envolver QR não-data-URL em data URL** (`whatsapp-config.tsx:handleSave` ~L207):
```typescript
const raw = data.qrcode?.base64 || data.qrcode?.code || null
let qrForState = raw
if (raw && !raw.startsWith('data:') && !raw.startsWith('http') && /^[0-9a-fA-F]{80,}$/.test(raw)) {
  qrForState = `data:image/png;base64,${raw}`
}
setQrCode(qrForState)
```

**C3 — Defaults do GET /api/whatsapp/config** quando `!config` (server route):
Atualmente GET retorna `{ connected: false, reason: 'no_config', ... }`. Adicionar `defaults` no payload:
```typescript
if (!config) {
  return NextResponse.json({
    connected: false,
    reason: 'no_config',
    message: 'No Evolution configuration saved yet.',
    defaults: {
      base_url: process.env.EVOLUTION_API_URL || 'http://127.0.0.1:8080',
      instance: process.env.EVOLUTION_INSTANCE || '',
    },
  })
}
```
E no frontend `whatsapp-config.tsx:fetchConfig`, depois do `} else {`, ler defaults:
```typescript
} else {
  setConfig(null)
  // inline defaults ok; evolução: futuramente usar payload.defaults
  setEvolutionBaseUrl('http://127.0.0.1:8080')
  setEvolutionInstance('NEXOR_AI')
  ...
}
```
(Opção incremental: deixar defaults hardcoded por ora; puxar do server em iteration 2.)

**C4 — Adicionar um botão "Refresh QR"** para re-chamar `connectInstance` sem re-salvar a config. Endpoint novo:
- `POST /api/whatsapp/config/qr` → server chama `connectInstance` + `setInstanceWebhook` + returns `{ qrcode, connection_state }`
- Frontend adiciona botão "Refresh QR / Pairing payload" visível quando `!isRegistered`.

### Frente D — Inbox: desativar gate 24h (Evolution não tem)

**D1 — `message-thread.tsx:222-246`** substituir o cálculo de sessionInfo para nunca expirar quando provider = Evolution. A forma mais defensiva: simplesmente desativar o gate completo, porque a Evolution/Baileys opera no conceito de WhatsApp normal, sem janela 24h business-customer:
```typescript
// EVOLUTION: there is no Meta-style 24h business-customer window.
// Inbound/outbound is always free; the composer gate is removed.
const sessionInfo = useMemo(() => ({ expired: false, remaining: '' }), [])
```
Remover a badge de sessão no header (L850) ou simplificá-la. Alternativa menos invasiva: manter a badge como "info" ("XXh since last customer msg") sem bloquear o composer.

**D2 — `message-thread.tsx:1076`** manter `<MessageComposer sessionExpired={sessionInfo.expired} ...>` (já `false` após D1).

**D3 — `message-composer.tsx`**
- Remover o bloco `{sessionExpired && (<div>...24h expired...`)}` ou substituir por nada.
- `inputsDisabled = readOnly || sessionExpired` → `inputsDisabled = readOnly` (manter so o gate de permissão por role).
- JSDoc "Meta caps media captions" → "WhatsApp caps media captions".

### Frente E — Template Manager: traduzir UX de Meta para Evolution local presets

**E1 — Renomear função interna** `handleSyncFromMeta` → `handleRefreshPresets` em `template-manager.tsx:302`. Atualizar todas referências (botão `onClick={handleSyncFromMeta}` em L491 → `onClick={handleRefreshPresets}`).

**E2 — Toasts em `template-manager.tsx:285-289`** (após salvar template):
```typescript
toast.success(
  data.local_preset
    ? (isEdit ? 'Preset atualizado localmente.' : 'Preset criado localmente.')
    : (isEdit ? 'Preset atualizado.' : 'Preset criado.'),
);
```
(PT-BR se você quiser; inglês se quiser manter o idioma original do template.)

**E3 — Tooltips e descrições em `template-manager.tsx`** substituir Metáfodos por "local preset":
- L549: tooltip "Meta quality score" — **remover** ou trocar para "Local preset (no quality score on Evolution)"
- L579: "Editing triggers Meta re-review — status flips to PENDING" → "Local presets are always editable. No external review on Evolution."
- L592: "Edit the template and resubmit to Meta for review" → "Edit the local preset"
- L606-612: txaw "Delete template from Meta and locally" → "Delete preset (local only)"; "Delete from Meta and locally" → "Delete local preset"
- L648-649: "Save your changes to re-submit to Meta..." / "Build a template and submit it to Meta for approval..." → "Save your changes. Evolution uses presets immediately, no approval step." / "Build a local preset for Evolution. Once saved, you can use it in broadcasts and the inbox."
- L676: "Name is fixed once a template exists on Meta..." → "Name is fixed once a local preset exists — create a new preset to change it."
- L729: "Language is fixed once a template exists on Meta" → "Language is fixed once a local preset exists"
- L732: "Must match the exact code on Meta — en_US" → "Language code, e.g. en_US or pt_BR"
- L792: placeholder "Sample value for {{1}} (required for Meta review)" → "Sample value for {{1}}"
- L855-856: "Upload a JPEG/PNG (≤5 MB ...) — we upload it to Meta for review automatically" / "Meta fetches it once during review" → "Paste a public HTTPS link to the header image (Evolution fetches it at send time)" — sem upload automático
- L886: "Sample values (Meta uses these to review your template)" → "Sample values (optional — help you preview the preset)"
- L1100-1102: dialog delete text "real Meta delete is happening" → "This will permanently delete the local preset."
- L1080: botão "Submit for Approval" → "Save Preset"

**E4 — `template-picker.tsx` (inbox) L197** substituir texto do helper:
```typescript
"Fill in the placeholders to render this preset. Every variable must be set to send."
```

**E5 — Remover a coluna "Status" da listagem de templates em `template-manager.tsx`** se ela mostra `Pending`/`Approved` racked Metáchodos. Substituir por simplesmente `Active` (todos presets locais, `status='APPROVED'` no DB via submit route). Confirmar Linhas da listagem (~L540) e o `statusKey` mapping.

### Frente F — Outros ajustes (automações/templates lib, presence)

- `src/lib/automations/templates.ts` — Grep + revisar referências a Meta; atualizar naming para "preset" onde for UI-facing (log messages, error messages).
- `src/lib/presence.ts` — confirmar que "Meta" é só description; se afeta UX (não deve), corrigir.

### Frente G — DB/Migration (auditoria completa das 31 migrations, não só a 031)

Reli `supabase/migrations/001` até `031` inteiras e cruzei com o código atual (`webhook/route.ts`, `config/route.ts`, `templates/submit/route.ts`). Resultado:

**G0 — Já está correto, não mexer:**
- `031_evolution_api_transport.sql` é idempotente e cobre o essencial: `evolution_base_url/instance/api_key/connection_state`, `phone_number_id`/`access_token` nullable, UNIQUE parcial em `evolution_instance`, `message_templates.category` nullable.
- Webhook (`webhook/route.ts:45`) já busca o config por `evolution_instance`, não por `phone_number_id` — roteamento já migrado corretamente.
- `evolution_api_key` é criptografado pelo mesmo helper `encrypt`/`decrypt` do antigo `access_token` (`src/lib/whatsapp/encryption.ts`) — sem regressão de segurança.
- RLS de `whatsapp_config`/`message_templates` usa `is_account_member()` (multi-tenant por `account_id`, já do repo original via migration 017) — não foi tocado pela troca de provedor e não precisa de ajuste.
- `messages.content_type` já foi ampliado para incluir `'interactive'` (migration 010) — os inserts do webhook Evolution para respostas de botão/lista não batem em CHECK constraint.
- `messages.status` CHECK (`sending/sent/delivered/read/failed`) já cobre tudo que `normalizeEvolutionStatus()` produz.

**G1 — Achado: bloco morto/redundante em `031` (cosmético, não bloqueia nada)**
`031` tenta `DROP CONSTRAINT whatsapp_config_phone_number_id_key` (guardado por `IF EXISTS`, então não falha), mas essa constraint **já não existe** desde `017_account_sharing.sql` — foi substituída por `whatsapp_config_account_id_key` (UNIQUE por conta, não por usuário) quando o repo original ganhou compartilhamento de conta. O bloco é inofensivo mas engana quem ler a migration achando que ainda há risco de duplicidade por `phone_number_id`. Ação: comentário explicando que é defensivo/legado, sem gate.

**G2 — Colunas Meta-only órfãs (documentar, não apagar ainda)**
Nenhuma quebra o sistema — todas nullable e não lidas pelo código atual — mas o plano original não deixava explícito que ficam de propósito (segurança de rollback já mencionada no plano):
- `whatsapp_config`: `waba_id`, `verify_token`, `registered_at`, `subscribed_apps_at`, `last_registration_error` (só faziam sentido no fluxo `POST /{phone_number_id}/register` do Meta, migration 015).
- `message_templates`: `meta_template_id` (a rota `submit/route.ts` grava `null` sempre), `quality_score`, `rejection_reason`, `header_handle`, `submission_error` (migration 014).
- Recomendação: manter por ora; numa migration cosmética futura, adicionar `COMMENT ON COLUMN ... IS 'legacy Meta Cloud API field — unused on Evolution deployments'` (mesmo padrão já usado em 031). Sem gate — é metadado, não altera dado.

**G3 — Verificar aplicação em produção (script ampliado — o original só checava 3 colunas)**
```bash
# 1. Colunas Evolution completas, incluindo evolution_api_key (faltava no script original):
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/whatsapp_config?select=id,evolution_base_url,evolution_instance,evolution_api_key,connection_state&limit=1" \\
  -H "apikey: $NEXT_...KEY" | jq .
# Se erro "column does not exist" -> migration 031 pendente (requer approval pra aplicar)
```
```sql
-- 2. Índice único em evolution_instance (o roteamento do webhook depende disso):
SELECT indexname FROM pg_indexes
WHERE tablename = 'whatsapp_config' AND indexname = 'whatsapp_config_evolution_instance_key';

-- 3. message_templates.category aceita NULL (Evolution não tem categoria Meta):
SELECT is_nullable FROM information_schema.columns
WHERE table_name = 'message_templates' AND column_name = 'category';
-- Esperado: 'YES'
```
- Se houver rows legadas com `phone_number_id != NULL` e `evolution_base_url IS NULL`, **deletar** para limpar (GATE: pede aprovação — é produção).

### Frente H — Habilitar service restart (GATE: Anderson)

- Após Frentes A-F + E2E local: `npx next build` na VPS, depois validar localmente em porta 3001 sem derrubar o serviço produtivo:
```bash
cd /home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI
npx next -p 3001 &   # preview port; só pra voce validar /settings e /inbox
```
**Reiniciar `wacrm.service` (systemd)** só após Anderson aprovar (é produção, QPS live):
```bash
# Gate explícito: "Anderson, dopostor okislocomo wacrm.service?"
sudo systemctl restart wacrm.service
```

---

## Ordem de execução recomendada

1. **Frente D** (desativar gate 24h) — low risk, alto valor UX, não toca na rede
2. **Frente C** (botão Save + QR envolver) — senza o botão Save, você não consegue configurar nada
3. **Frente B** (webhook robustez + token fallback) —Fecha 95% do "não recebe mensagem"
4. **Frente E** (template-manager + template-picker UX) — limpa a UX para refletir Evolution local
5. **Frente A** (cosmético backend) — sem pressa, mantém código limpo
6. **Frente F** (automações/templates lib, presence) — baixo risco
7. **Frente G** (DB check + cleanup) — possui gates; verify antes de aplicar
8. **Frente H** (reiniciar serviço) — gate obrigatório do Anderson

---

## Gates de approvação explícitos (proibido sem OK do Anderson)

- ❌ **git push em qualquer branch** (explicitado) — se algum script de deploy dele automático disparar via git push, **NÃO fazer**
- ❌ **Netlify deploy** (qualquer comando `netlify deploy`, `netlify build --context production`, etc.) — não rodar
- ❌ **Aplicar migration 031 ao Supabase** produtivo (Frente G) se ainda não rodou
- ❌ **DELETE rows legadas em `whatsapp_config`** (Frente G) — produção
- ❌ **Reiniciar `wacrm.service`** via systemd (Frente H)
- ❌ **Enviar mensagem de teste real a partir de número real WhatsApp** (qualquer D4)
- ❌ **Publicar URL pública para o seu CRM** (DNS, Tailscale Funnel público, etc.)

## Gates automáticos (sem approvação)

- ✓ Editar JSDoc/comentários/cosméticos JSX (Frente A, E1-E5)
- ✓ Adicionar botão Save/Test na UI (Frente C1)
- ✓ Trocar gate de sessionExpired (Frente D)
- ✓ Adicionar fallback header no webhook (Frente B2)
- ✓ Try/catch por item (Frente B4)
- ✓ Rodar `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` localmente
- ✓ Rodar `npx next build` local para validar build estático
- ✓ Rodar `npx next -p 3001` em preview isolado (sem tocar no serviço produtivo)
- ✓ Subservice `curl` local no webhook Evoluzione pra testar token (sem clientes reais)

---

## Verificação final pós-todas-as-frentes

```bash
cd /home/hermes/PROJETOS/EMPRESAS/ALL_NEXOR_AI/CRM_NEXOR-AI
npx tsc --noEmit && \\
  npx eslint . && \\
  npx vitest run && \\
  NEXT_TELEMETRY_DISABLED=1 npx next build
# Todos devem passar com 0 erros

# E2E mínimo (GATE: precisa reiniciar serviço e usar números reais WhatsApp):
# 1. /settings → WhatsApp → Save → QR aparece no estado data-URL
# 2. Scan QR via WhatsApp → connection_state=open no DB
# 3. Mensagem do WhatsApp chega no /inbox (webhook inbound B)
# 4. Reply via Inbox chega no WhatsApp (outbound send)
# 5. Broadcast/envio em massa → status enviado → delivered/read rastreavel
# 6. Composer não bloqueia "session expired" (Frente D)
# 7. Template Manager mostra "Save Preset" e "Refresh presets" sem refs a Meta
# 8. Template Picker (inbox) helper atualizado
# 9. Fluxos com botões renderizam "1./2./3." → cliente responde "1" → webhook mapeia como interactive_reply → flow avança
```

---

## Apêndice — Skills de referência carregadas

- `references/wacrm-meta-to-evolution-full-runtime-replacement.md`
- `references/wacrm-evolution-inbound-parity.md`
- `references/wacrm-netlify-evolution-funnel-bridge.md`
- `references/wacrm-evolution-settings-ui-alignment.md`
- `references/wacrm-full-frontend-translation-and-evolution-inbound.md`
- `references/nextjs-whatsapp-provider-extension-evolution.md`
- `references/wacrm-full-codebase-diagnostic-audit.md`
- `references/wacrm-evolution-flows-automations-internal-worker.md`

---

## Chegada final (resumo para Anderson)

- Backend Migration, transport, config route, webhook route, send/automations/flows/broadcast — **já trocados para Evolution**. Está funcional ao nivel de codigo.
- Backend gaps concretos: B1 (token URL), B2 (header fallback Neo), B3 (@lid/@g.us), B4 (try/catch) — P0/P1
- Frontend gaps concretos C1 (botao Save + Test missing), C2 (QR não-data-URL envolver), C3 (defaults dinamicos), C4 (refresh QR) — P1
- Frontend UX gaps D1-D3 (gate 24h Evolution não tem — Bloquea o composer), E1-E5 (template manager cheio de textos Meta) — P1
- Cosmetico A/F — low risk
- DB G — auditadas as 31 migrations linha a linha: schema Evolution (031) está correto e completo para o essencial; achado G1 (bloco morto redundante em 031, inofensivo) e G2 (colunas Meta-only órfãs em whatsapp_config/message_templates, mantidas por segurança de rollback, sem risco). Falta apenas confirmar em produção com o script ampliado (G3) e decidir sobre rows legadas (gate).
- Service restart H — gate do Anderson

## Resposta curta

Sim — Plano atualizado com front-end. Vou executar da seguinte ordem:
1. Frente D (gate 24h off)
2. Frente C (Save button + QR)
3. Frente B (webhook + token)
4. Frente E (template manager texts)
5. Frente A (cosmético backend)
6. Frentes F, G (gates), H (gate)

VPS-only. Zero Git/Netlify. Confirma que posso começar?

## Riscos & Mitigação

| Risco | Impacto | Probabilidade | Mitigação |
|-------|---------|---------------|-----------|
| **Falha ao registrar webhook na Evolution** | Mensagens não chegam no inbox (perda de comunicação) | Médio | Após salvar config, validar via `curl` que a URL contém o token; incluir teste automático no fluxo de `handleSave`. |
| **Token de webhook expulso ou incorreto** | Webhook rejeitado pela Evolution (401/403) | Baixo | Usar variável de ambiente `WHATSAPP_WEBHOOK_TOKEN` e incluir fallback de header `x-evolution-webhook-token` e parâmetro query `?token=`. |
| **Eventos de lid/g.us sendo processados como contatos** | Mensagens de grupos ou mensagens de sistema aparecem no inbox causando ruído | Médio | Filtrar remoteJid que não termina em `@s.whatsapp.net` no normalizador (`webhook/route.ts`). |
| **Exceções não tratadas no loop de `messages.update`** | Um único status malformado pode quebrar o processamento do webhook inteiro | Médio | Envolver cada item em try/catch e registrar erro sem interromper o loop. |
| **Botões Save/Test não renderizados** | Impossível salvar ou testar a configuração → parada total | Alto (se não corrigido) | Inserir os botões no JSX conforme especificação na Frente C1; verificar via teste de renderização. |
| **QR Code não envolvido em data URL** | QR não aparece na tela, impede emparelhamento | Médio | Converter base64/raw para `data:image/png;base64,...` antes de armazenar no estado. |
| **Gate de sessão 24h ainda ativo** | Composer bloqueado após 24h, impedindo respostas | Alto (se mantido) | Substituir cálculo de sessionInfo para sempre retornar `expired: false` quando provider = Evolution. |
| **Textos e tooltips ainda referenciam Meta** | Experiência de usuário confusa, aparência de produto legado | Baixo | Substituir todas as ocorrências de "Meta" por "preset" ou mensagens genéricas conforme Frente E. |
| **Colunas de banco não aplicadas** | Erros ao salvar configuração (coluna inexistente) | Médio (se migration não aplicada) | Verificar schema via Supabase antes de iniciar o serviço; aplicar migration 031 com aprovação do Anderson. |
| **Rows legadas com campos antigos preenchidos e novos nulos** | Inconsistência pode gerar chamadas para API inexistente | Baixo | Executar script de limpeza (ou update) que copia valores antigos para novos campos quando possível, ou define padrão; fazer isso apenas com aprovação explícita. |
| **Reinício do serviço sem validação** | Pode deixar a aplicação indisponível se houver erro de compilação | Médio | Build e teste em porta alternativa (3001) antes de reiniciar o serviço produtivo; somente após confirmação de Anderson. |
| **Uso de variáveis de ambiente não definidas** | Falha ao iniciar (undefined) | Baixo | Validar no início do servidor que `EVOLUTION_API_URL`, `EVOLUTION_INSTANCE`, `EVOLUTION_API_KEY` estão definidos; caso contrário, logar erro claro e não iniciar. |

### Plano de mitigação geral

1. **Teste de regressão automático** após cada frente (build, lint, testes unitários).
2. **Checklist de pré‑produção**: validar variáveis de ambiente, aplicar migration, testar Save/Test, enviar mensagem de teste e verificar webhook inbound.
3. **Feature flags temporárias** (se necessário) para permitir rollback rápido: manter ambas as implementações (meta-api e evolution-api) atrás de uma flag de ambiente; após estabilidade, remover o shim.
4. **Documentação de rollback**: manter branch `feature/evolution-api` e instruções para reverter ao estado anterior apenas removendo as novas colunas e restaurando o shim.

Com essas mitigações, a transição para a Evolution API será feita com risco operacional baixo e garantirá que tanto o frontend quanto o backend estejam totalmente adaptados, incluindo o ajuste das tabelas do Supabase.