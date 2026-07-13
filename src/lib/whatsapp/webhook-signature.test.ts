import { describe, expect, it, vi, afterEach } from "vitest";
import { verifyEvolutionWebhookToken } from "./webhook-signature";

afterEach(() => vi.unstubAllEnvs());

describe("Evolution webhook token", () => {
  it("accepts matching query token", () => {
    vi.stubEnv("WHATSAPP_WEBHOOK_TOKEN", "secret");
    const req = new Request("https://crm.test/api/whatsapp/webhook?token=secret");
    expect(verifyEvolutionWebhookToken(req)).toBe(true);
  });

  it("accepts matching header token", () => {
    vi.stubEnv("WHATSAPP_WEBHOOK_TOKEN", "secret");
    const req = new Request("https://crm.test/api/whatsapp/webhook", { headers: { "x-wacrm-webhook-token": "secret" } });
    expect(verifyEvolutionWebhookToken(req)).toBe(true);
  });

  it("fails closed without configured token", () => {
    vi.stubEnv("WHATSAPP_WEBHOOK_TOKEN", "");
    const req = new Request("https://crm.test/api/whatsapp/webhook?token=secret");
    expect(verifyEvolutionWebhookToken(req)).toBe(false);
  });
});
