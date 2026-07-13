import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendInteractiveButtons, sendInteractiveList } from "./meta-api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ key: { id: "evo-1" } }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("Evolution interactive fallbacks", () => {
  it("sends buttons as deterministic text fallback through Evolution", async () => {
    const result = await sendInteractiveButtons({
      baseUrl: "https://evo.example",
      apiKey: "key",
      instanceName: "inst",
      to: "5511999999999",
      bodyText: "Choose",
      footerText: "Footer",
      buttons: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    });
    expect(result.messageId).toBe("evo-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo.example/message/sendText/inst");
    expect(init.headers.apikey).toBe("key");
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999999999",
      text: "Choose\n\n1. A\n2. B\n\nFooter",
    });
  });

  it("sends list rows as text fallback through Evolution", async () => {
    await sendInteractiveList({
      baseUrl: "https://evo.example/",
      apiKey: "key",
      instanceName: "inst",
      to: "+55 (11) 99999-9999",
      bodyText: "Pick one",
      buttonLabel: "Open",
      sections: [{ title: "Main", rows: [{ id: "r1", title: "Row 1" }] }],
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999999999",
      text: "Pick one\n\n1. Row 1",
    });
  });
});
