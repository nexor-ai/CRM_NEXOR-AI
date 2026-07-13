import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaMessage } from "./meta-api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ key: { id: "media-1" } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Evolution sendMedia payloads", () => {
  it("sends image with caption", async () => {
    await sendMediaMessage({ baseUrl: "https://evo", apiKey: "k", instanceName: "i", to: "123", kind: "image", link: "https://cdn/x.png", caption: "hi" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo/message/sendMedia/i");
    expect(JSON.parse(init.body)).toMatchObject({ number: "123", mediatype: "image", media: "https://cdn/x.png", caption: "hi" });
  });

  it("sends document with filename", async () => {
    await sendMediaMessage({ baseUrl: "https://evo", apiKey: "k", instanceName: "i", to: "123", kind: "document", link: "https://cdn/x.pdf", filename: "x.pdf" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ mediatype: "document", fileName: "x.pdf" });
  });

  it("sends audio through the WhatsApp audio endpoint", async () => {
    await sendMediaMessage({ baseUrl: "https://evo", apiKey: "k", instanceName: "i", to: "123", kind: "audio", link: "https://cdn/a.ogg" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo/message/sendWhatsAppAudio/i");
    expect(JSON.parse(init.body)).toEqual({ number: "123", audio: "https://cdn/a.ogg" });
  });
});
