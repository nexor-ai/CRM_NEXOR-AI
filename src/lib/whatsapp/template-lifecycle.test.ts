import { describe, expect, it } from "vitest";
import { deleteMessageTemplate, editMessageTemplate, submitMessageTemplate } from "./meta-api";

describe("Evolution local template lifecycle compatibility", () => {
  it("submits templates as local approved presets", async () => {
    const result = await submitMessageTemplate({ wabaId: "legacy", accessToken: "x", payload: { name: "hello" } });
    expect(result.status).toBe("APPROVED");
    expect(result.id).toMatch(/^local_/);
  });
  it("edits templates as local DB concern", async () => {
    await expect(editMessageTemplate({ metaTemplateId: "legacy", accessToken: "x", components: [] })).resolves.toEqual({ success: true });
  });
  it("deletes templates as local DB concern", async () => {
    await expect(deleteMessageTemplate({ wabaId: "legacy", accessToken: "x", name: "hello" })).resolves.toBeUndefined();
  });
});
