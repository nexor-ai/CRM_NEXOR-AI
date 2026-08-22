import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { startManualFlow } from "@/lib/flows/engine";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: flowId } = await params;
    const ctx = await requireRole("agent");
    const body = await request.json().catch(() => null);
    const conversationId =
      typeof body?.conversation_id === "string" ? body.conversation_id.trim() : "";
    if (!conversationId) {
      return NextResponse.json({ error: "conversation_id é obrigatório" }, { status: 400 });
    }

    const { data: conversation, error } = await ctx.supabase
      .from("conversations")
      .select("id, contact_id")
      .eq("id", conversationId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (error) throw error;
    if (!conversation?.contact_id) {
      return NextResponse.json({ error: "Conversa não encontrada" }, { status: 404 });
    }

    const result = await startManualFlow({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      flowId,
      contactId: conversation.contact_id,
      conversationId,
    });
    if (!result.consumed) {
      return NextResponse.json(
        { error: "Flow manual ativo não encontrado ou contato já está em um Flow" },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
