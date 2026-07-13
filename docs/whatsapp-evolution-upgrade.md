# WhatsApp transport upgrade: Meta Cloud API → Evolution API

WACRM now uses Evolution API as the WhatsApp transport.

## What changed

- No runtime code calls `graph.facebook.com`.
- `phone_number_id`, `waba_id`, Meta registration PIN and WABA subscription are legacy-only columns.
- `message_templates` are local presets. They are not submitted for Meta approval.
- Webhooks are Evolution payloads (`messages.upsert`, `messages.update`, `connection.update`) protected by `WHATSAPP_WEBHOOK_TOKEN`.
- Connection state comes from `GET /instance/connectionState/{instance}` and is connected when state is `open`.

## Required environment

```env
ENCRYPTION_KEY=64-hex-char-key
NEXT_PUBLIC_SITE_URL=https://crm.example.com
WHATSAPP_WEBHOOK_TOKEN=long-random-token
# optional defaults
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=server-global-apikey
```

## Database migration

Run the new migration:

```sql
supabase/migrations/031_evolution_api_transport.sql
```

It adds:

- `whatsapp_config.evolution_base_url`
- `whatsapp_config.evolution_instance`
- `whatsapp_config.evolution_api_key` encrypted with AES-256-GCM
- `whatsapp_config.connection_state`

Legacy Meta columns are kept nullable for non-destructive upgrade.

## Setup flow

1. Run Evolution API v2 and open its manager or API endpoint.
2. In WACRM Settings → WhatsApp connection, enter:
   - Evolution Base URL
   - Instance name
   - API key (`apikey` header value)
3. Click Connect.
4. Scan the QR/pairing payload with WhatsApp.
5. Wait until state becomes `open`.
6. Evolution webhook should point to:
   `/api/whatsapp/webhook?token=<WHATSAPP_WEBHOOK_TOKEN>`

## Operational notes

- Text, media, audio, reactions, broadcasts, automations and flows route through Evolution.
- Interactive buttons/lists use a text fallback because Baileys button/list support varies by Evolution build.
- Incoming media is stored as the URL/base64 provided by Evolution. The old Graph media lookup route returns 410.
