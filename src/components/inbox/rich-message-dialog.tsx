'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  buildContactVCard,
  buildInteractiveMessagePayload,
} from '@/lib/whatsapp/chat-actions';

export type RichMessagePayload = {
  message_type:
    | 'location'
    | 'contact'
    | 'sticker'
    | 'poll'
    | 'interactive_buttons'
    | 'interactive_list';
  content_text?: string;
  media_url?: string;
  content_data?: Record<string, unknown>;
};

export function RichMessageDialog({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (payload: RichMessagePayload) => Promise<void>;
}) {
  const [kind, setKind] =
    useState<RichMessagePayload['message_type']>('location');
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!open) {
      setPrimary('');
      setSecondary('');
      setLabel('');
      setAddress('');
      setBusy(false);
      setValidationError('');
    }
  }, [open]);

  const submit = async () => {
    let payload: RichMessagePayload;
    setValidationError('');
    try {
      if (kind === 'location') {
        const latitude = Number(primary.replace(',', '.'));
        const longitude = Number(secondary.replace(',', '.'));
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          throw new Error('Informe latitude e longitude válidas.');
        }
        if (!label.trim() || !address.trim()) {
          throw new Error('Informe o nome e o endereço do local.');
        }
        payload = {
          message_type: kind,
          content_text: label.trim(),
          content_data: {
            latitude,
            longitude,
            name: label.trim(),
            address: address.trim(),
          },
        };
      } else if (kind === 'contact') {
        const fullName = primary.trim();
        const phoneNumber = secondary.trim();
        if (!fullName || phoneNumber.replace(/\D/g, '').length < 10)
          throw new Error('Informe nome e telefone válido com DDD.');
        payload = {
          message_type: kind,
          content_text: fullName,
          content_data: {
            contacts: [{ fullName, phoneNumber }],
            displayName: fullName,
            vcard: buildContactVCard({ fullName, phoneNumber }),
          },
        };
      } else if (kind === 'sticker') {
        if (!primary.trim())
          throw new Error('Informe a URL pública do sticker.');
        payload = { message_type: kind, media_url: primary.trim() };
      } else if (kind === 'poll') {
        const values = secondary
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean);
        if (!primary.trim() || values.length < 2)
          throw new Error('Informe a pergunta e ao menos duas opções.');
        if (values.length > 10)
          throw new Error('A enquete aceita no máximo dez opções.');
        if (new Set(values).size !== values.length)
          throw new Error('As opções da enquete devem ser únicas.');
        payload = {
          message_type: kind,
          content_text: primary.trim(),
          content_data: { name: primary.trim(), values, selectableCount: 1 },
        };
      } else {
        payload = buildInteractiveMessagePayload(kind, primary, secondary);
      }
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : 'Revise os campos informados.'
      );
      return;
    }
    setBusy(true);
    try {
      await onSend(payload);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const labels = {
    location: ['Latitude', 'Longitude', 'Nome do local (opcional)'],
    contact: ['Nome do contato', 'Telefone', ''],
    sticker: ['URL pública do sticker WebP', '', ''],
    poll: ['Pergunta', 'Opções (uma por linha)', ''],
    interactive_buttons: ['Mensagem', 'Botões (um por linha, até 3)', ''],
    interactive_list: ['Mensagem', 'Itens da lista (um por linha, até 10)', ''],
  }[kind];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mensagem rica</DialogTitle>
          <DialogDescription>
            Envie mídia rica. Botões e listas usam fallback textual seguro por
            padrão.
          </DialogDescription>
        </DialogHeader>
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as RichMessagePayload['message_type']);
            setPrimary('');
            setSecondary('');
            setLabel('');
            setAddress('');
          }}
          className="border-border bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="location">Localização</option>
          <option value="contact">Contato / vCard</option>
          <option value="sticker">Figurinha</option>
          <option value="poll">Enquete</option>
          <option value="interactive_buttons">Botões com fallback</option>
          <option value="interactive_list">Lista com fallback</option>
        </select>
        <Input
          value={primary}
          onChange={(event) => setPrimary(event.target.value)}
          placeholder={labels[0]}
        />
        {labels[1] &&
          (kind === 'poll' ||
          kind === 'interactive_buttons' ||
          kind === 'interactive_list' ? (
            <textarea
              value={secondary}
              onChange={(event) => setSecondary(event.target.value)}
              placeholder={labels[1]}
              rows={4}
              className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            />
          ) : (
            <Input
              value={secondary}
              onChange={(event) => setSecondary(event.target.value)}
              placeholder={labels[1]}
            />
          ))}
        {labels[2] && (
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={labels[2]}
          />
        )}
        {kind === 'location' && (
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Endereço do local"
          />
        )}
        {validationError && (
          <p className="text-destructive text-sm">{validationError}</p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? 'Enviando…' : 'Enviar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
