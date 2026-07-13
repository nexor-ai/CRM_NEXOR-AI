import { describe, expect, it } from "vitest";
import { getSubscribedApps, registerPhoneNumber, subscribeWabaToApp } from "./meta-api";

describe("Evolution registration compatibility no-ops", () => {
  it("treats phone registration as QR-pairing compatible no-op", async () => {
    await expect(registerPhoneNumber({ phoneNumberId: "legacy", accessToken: "x", pin: "123456" })).resolves.toEqual({ success: true });
  });
  it("treats WABA subscription as Evolution webhook compatibility no-op", async () => {
    await expect(subscribeWabaToApp({ wabaId: "legacy", accessToken: "x" })).resolves.toEqual({ success: true });
  });
  it("returns no subscribed apps because Evolution has no WABA app catalog", async () => {
    await expect(getSubscribedApps({ wabaId: "legacy", accessToken: "x" })).resolves.toEqual([]);
  });
});
