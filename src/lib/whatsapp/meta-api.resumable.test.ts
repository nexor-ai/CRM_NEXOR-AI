import { describe, expect, it } from "vitest";
import { uploadResumableMedia } from "./meta-api";

describe("Evolution template media handles", () => {
  it("does not support Meta resumable uploads", async () => {
    await expect(uploadResumableMedia()).rejects.toThrow(/does not support remote template media-handle uploads/);
  });
});
