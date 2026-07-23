export interface TransportMessageRow {
  message_id: string | null;
  whatsapp_instance?: string | null;
}

export function uniqueReadReceipts(
  messages: TransportMessageRow[],
  activeInstance: string,
  remoteJid: string
): Array<{ id: string; remoteJid: string; fromMe: false }> {
  const seen = new Set<string>();
  const receipts: Array<{ id: string; remoteJid: string; fromMe: false }> = [];

  for (const message of messages) {
    const id = message.message_id?.trim();
    if (!id || seen.has(id)) continue;
    if (message.whatsapp_instance && message.whatsapp_instance !== activeInstance) continue;
    seen.add(id);
    receipts.push({ id, remoteJid, fromMe: false });
  }

  return receipts;
}
