import { describe, expect, it } from "vitest";
import { ensureImageHeaderHandle } from "./template-header-handle";

describe("Evolution template header handles", () => {
  it("keeps local media URL and clears no existing direct URL", async () => {
    const payload = { name: "p", category: "Marketing" as const, language: "en_US", header_type: "image" as const, header_media_url: "https://cdn/x.png", header_handle: "legacy", body_text: "Hi" };
    await ensureImageHeaderHandle(payload, "tok");
    expect(payload.header_media_url).toBe("https://cdn/x.png");
    expect(payload.header_handle).toBeUndefined();
  });
});
