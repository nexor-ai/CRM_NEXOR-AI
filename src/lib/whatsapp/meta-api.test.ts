import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveChat,
  deleteMessageForEveryone,
  editMessage,
  fetchProfile,
  fetchInstanceWebhook,
  findMessages,
  markChatUnread,
  markMessagesAsRead,
  sendContactMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendLocationMessage,
  sendPollMessage,
  sendPresence,
  sendStickerMessage,
  setInstanceWebhook,
  sendTextMessage,
  validateWhatsAppNumbers,
} from "./meta-api";

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
  it("reads the live webhook configuration", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, url: "https://crm.example/webhook" }), { status: 200 }),
    );
    const result = await fetchInstanceWebhook({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://evo.example/webhook/find/inst");
    expect(result).toMatchObject({ enabled: true });
  });

  it("marks transport messages as read with full WhatsApp keys", async () => {
    await markMessagesAsRead({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      messages: [{ id: "wa-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }],
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      readMessages: [{ id: "wa-1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }],
    });
  });

  it("sends bounded composing presence", async () => {
    await sendPresence({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      to: "+55 11 99999-9999", presence: "composing", delay: 1200,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      number: "5511999999999", presence: "composing", delay: 1200,
    });
  });

  it("queries message history and validates numbers", async () => {
    await findMessages({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", where: { remoteJid: "5511@s.whatsapp.net" }, limit: 50 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ where: { key: { remoteJid: "5511@s.whatsapp.net" } }, offset: 50, page: 1 });
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    await validateWhatsAppNumbers({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", numbers: ["+55 11 99999-9999"] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ numbers: ["5511999999999"] });
  });

  it("uses native location/contact and archive contracts", async () => {
    await sendLocationMessage({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", to: "5511", latitude: -23.5, longitude: -46.6, name: "Cliente" });
    expect(fetchMock.mock.calls[0][0]).toContain("/message/sendLocation/inst");
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ key: { id: "contact-1" } }), { status: 200 }));
    await sendContactMessage({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", to: "5511", contacts: [{ fullName: "Ana", phoneNumber: "+55 11 98888-0000" }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).contact[0]).toMatchObject({ fullName: "Ana", phoneNumber: "+55 11 98888-0000" });
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await archiveChat({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", remoteJid: "5511@s.whatsapp.net", archive: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat: "5511@s.whatsapp.net", archive: true });
  });

  it("uses the Evolution 2.3 webhook property names", async () => {
    await setInstanceWebhook({
      baseUrl: "https://evo.example",
      apiKey: "key",
      instanceName: "inst",
      url: "https://crm.example/api/whatsapp/webhook",
      webhookScopeId: "account-1",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).webhook).toMatchObject({
      byEvents: false,
      base64: true,
    });
    expect(JSON.parse(init.body).webhook).not.toHaveProperty("webhookByEvents");
    expect(JSON.parse(init.body).webhook).not.toHaveProperty("webhookBase64");
  });

  it("sends a quoted reply using Evolution's quoted key contract", async () => {
    await sendTextMessage({
      baseUrl: "https://evo.example",
      apiKey: "key",
      instanceName: "inst",
      to: "5511999999999",
      text: "Resposta",
      contextMessageId: "parent-wa-id",
      contextFromMe: false,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999999999",
      text: "Resposta",
      quoted: {
        key: {
          remoteJid: "5511999999999@s.whatsapp.net",
          fromMe: false,
          id: "parent-wa-id",
        },
      },
    });
  });

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

  it("uses the native Evolution 2.3.7 button contract only when explicitly enabled", async () => {
    await sendInteractiveButtons({
      baseUrl: "https://evo.example",
      apiKey: "key",
      instanceName: "inst",
      to: "5511999999999",
      bodyText: "Escolha",
      headerText: "Atendimento",
      footerText: "NEXOR",
      native: true,
      buttons: [{ id: "sales", title: "Comercial" }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo.example/message/sendButtons/inst");
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999999999",
      title: "Atendimento",
      description: "Escolha",
      footer: "NEXOR",
      buttons: [{ type: "reply", id: "sales", displayText: "Comercial" }],
    });
  });

  it("uses the native Evolution 2.3.7 list contract only when explicitly enabled", async () => {
    await sendInteractiveList({
      baseUrl: "https://evo.example",
      apiKey: "key",
      instanceName: "inst",
      to: "5511999999999",
      bodyText: "Escolha",
      headerText: "Atendimento",
      footerText: "NEXOR",
      buttonLabel: "Abrir",
      native: true,
      sections: [{ title: "Áreas", rows: [{ id: "support", title: "Suporte", description: "Ajuda técnica" }] }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo.example/message/sendList/inst");
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999999999",
      title: "Atendimento",
      description: "Escolha",
      footerText: "NEXOR",
      buttonText: "Abrir",
      sections: [{ title: "Áreas", rows: [{ rowId: "support", title: "Suporte", description: "Ajuda técnica" }] }],
    });
  });

  it("sends sticker and poll with the pinned Evolution 2.3.7 payloads", async () => {
    await sendStickerMessage({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      to: "5511", sticker: "https://cdn.example/sticker.webp",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/message/sendSticker/inst");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ number: "5511", sticker: "https://cdn.example/sticker.webp" });

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ key: { id: "poll-1" } }), { status: 201 }));
    await sendPollMessage({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      to: "5511", name: "Melhor horário?", selectableCount: 1, values: ["Manhã", "Tarde"],
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/message/sendPoll/inst");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      number: "5511", name: "Melhor horário?", selectableCount: 1, values: ["Manhã", "Tarde"],
    });
  });

  it("fetches profile and sends audited edit/delete chat contracts", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "Push name", picture: "https://cdn.example/avatar.jpg" }), { status: 200 }));
    await fetchProfile({ baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", to: "+55 11 99999-9999" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://evo.example/chat/fetchProfile/inst");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ number: "5511999999999" });

    fetchMock.mockClear();
    await editMessage({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst", to: "5511",
      key: { id: "wa-1", remoteJid: "5511@s.whatsapp.net", fromMe: true }, text: "corrigida",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/chat/updateMessage/inst");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      number: "5511", key: { id: "wa-1", remoteJid: "5511@s.whatsapp.net", fromMe: true }, text: "corrigida",
    });

    fetchMock.mockClear();
    await deleteMessageForEveryone({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      key: { id: "wa-1", remoteJid: "5511@s.whatsapp.net", fromMe: true },
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/chat/deleteMessageForEveryone/inst");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "wa-1", remoteJid: "5511@s.whatsapp.net", fromMe: true });
  });

  it("includes the last-message key for archive and unread synchronization", async () => {
    const lastMessage = { key: { id: "wa-last", remoteJid: "5511@s.whatsapp.net", fromMe: false }, messageTimestamp: 123 };
    await archiveChat({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      remoteJid: "5511@s.whatsapp.net", archive: true, lastMessage,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat: "5511@s.whatsapp.net", archive: true, lastMessage,
    });

    fetchMock.mockClear();
    await markChatUnread({
      baseUrl: "https://evo.example", apiKey: "key", instanceName: "inst",
      remoteJid: "5511@s.whatsapp.net", lastMessage,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat: "5511@s.whatsapp.net", lastMessage });
  });
});
