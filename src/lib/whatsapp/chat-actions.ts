type JsonRecord = Record<string, unknown>;

export type InteractiveComposerKind =
  'interactive_buttons' | 'interactive_list';

export type InteractiveComposerPayload = {
  message_type: InteractiveComposerKind;
  content_text: string;
  content_data: Record<string, unknown>;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? (value as JsonRecord) : {};
}

export function buildRemoteJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildContactVCard(contact: {
  fullName: string;
  phoneNumber: string;
}): string {
  const fullName = singleLine(contact.fullName);
  const phoneNumber = singleLine(contact.phoneNumber);
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${fullName}`,
    `TEL;TYPE=CELL:${phoneNumber}`,
    'END:VCARD',
  ].join('\r\n');
}

export function buildInteractiveMessagePayload(
  kind: InteractiveComposerKind,
  bodyText: string,
  optionsText: string
): InteractiveComposerPayload {
  const contentText = bodyText.trim();
  if (!contentText) throw new Error('Informe a mensagem do atendimento.');
  if (contentText.length > 1024)
    throw new Error('A mensagem deve ter no máximo 1024 caracteres.');

  const options = optionsText.split('\n').map(singleLine).filter(Boolean);
  if (options.length === 0) throw new Error('Informe ao menos uma opção.');

  const titleLimit = kind === 'interactive_buttons' ? 20 : 24;
  const optionLimit = kind === 'interactive_buttons' ? 3 : 10;
  if (options.length > optionLimit) {
    throw new Error(`Use no máximo ${optionLimit} opções.`);
  }
  if (options.some((option) => option.length > titleLimit)) {
    throw new Error(`Cada opção deve ter no máximo ${titleLimit} caracteres.`);
  }

  const entries = options.map((title, index) => ({
    id: `option-${index + 1}`,
    title,
  }));

  return kind === 'interactive_buttons'
    ? {
        message_type: kind,
        content_text: contentText,
        content_data: { native: false, buttons: entries },
      }
    : {
        message_type: kind,
        content_text: contentText,
        content_data: {
          native: false,
          buttonLabel: 'Abrir opções',
          sections: [{ title: 'Opções', rows: entries }],
        },
      };
}

export function buildContactProfilePatch(profile: unknown): JsonRecord {
  const data = record(profile);
  const nested = record(data.profile);
  const pushName = data.pushName ?? data.name ?? nested.pushName ?? nested.name;
  const picture =
    data.picture ??
    data.pictureUrl ??
    data.profilePictureUrl ??
    nested.picture ??
    nested.pictureUrl;
  const status = data.status ?? data.about ?? nested.status ?? nested.about;

  return {
    ...(pushName ? { whatsapp_push_name: String(pushName) } : {}),
    ...(picture ? { avatar_url: String(picture) } : {}),
    ...(status ? { whatsapp_profile_status: String(status) } : {}),
    whatsapp_profile_synced_at: new Date().toISOString(),
  };
}

export function parseWhatsAppNumberValidation(
  payload: unknown,
  normalizedNumber: string
): { exists: boolean; jid: string | null } {
  const root = record(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.numbers)
        ? root.numbers
        : [];
  const row = candidates.map(record).find((candidate) => {
    const jid = String(
      candidate.jid ?? candidate.wid ?? candidate.number ?? ''
    );
    return jid.replace(/\D/g, '').startsWith(normalizedNumber);
  });
  return {
    exists: row?.exists === true,
    jid: row?.jid || row?.wid ? String(row.jid ?? row.wid) : null,
  };
}
