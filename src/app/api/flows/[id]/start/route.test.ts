import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  startManualFlow: vi.fn(),
  conversation: {
    data: { id: "conv-1", contact_id: "contact-1" } as {
      id: string;
      contact_id: string;
    } | null,
    error: null as unknown,
  },
}));

function conversationQuery() {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) builder[method] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => h.conversation);
  return builder;
}

vi.mock("@/lib/auth/account", () => ({
  requireRole: h.requireRole,
  toErrorResponse: (error: unknown) =>
    Response.json({ error: error instanceof Error ? error.message : "error" }, { status: 500 }),
}));

vi.mock("@/lib/flows/engine", () => ({ startManualFlow: h.startManualFlow }));

import { POST } from "./route";

const request = () =>
  new Request("https://crm.test/api/flows/flow-1/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: "conv-1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.conversation = { data: { id: "conv-1", contact_id: "contact-1" }, error: null };
  h.requireRole.mockResolvedValue({
    accountId: "account-1",
    userId: "user-1",
    supabase: { from: vi.fn(() => conversationQuery()) },
  });
  h.startManualFlow.mockResolvedValue({ consumed: true, flow_run_id: "run-1", outcome: "started" });
});

describe("POST /api/flows/[id]/start", () => {
  it("starts a flow only for a conversation visible in the caller account", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "flow-1" }) });

    expect(response.status).toBe(200);
    expect(h.startManualFlow).toHaveBeenCalledWith({
      accountId: "account-1",
      actorUserId: "user-1",
      flowId: "flow-1",
      contactId: "contact-1",
      conversationId: "conv-1",
    });
  });

  it("returns 404 without starting when the conversation is outside scope", async () => {
    h.conversation = { data: null, error: null };
    const response = await POST(request(), { params: Promise.resolve({ id: "flow-1" }) });

    expect(response.status).toBe(404);
    expect(h.startManualFlow).not.toHaveBeenCalled();
  });

  it("rejects missing conversation_id", async () => {
    const response = await POST(
      new Request("https://crm.test/api/flows/flow-1/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "flow-1" }) },
    );
    expect(response.status).toBe(400);
    expect(h.startManualFlow).not.toHaveBeenCalled();
  });
});
