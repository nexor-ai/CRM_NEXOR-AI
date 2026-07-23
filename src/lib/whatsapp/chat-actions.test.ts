import { describe, expect, it } from 'vitest';

import {
  buildContactVCard,
  buildContactProfilePatch,
  buildInteractiveMessagePayload,
  buildRemoteJid,
  parseWhatsAppNumberValidation,
} from './chat-actions';

describe('WhatsApp chat action helpers', () => {
  it('builds a user remote JID from a formatted phone', () => {
    expect(buildRemoteJid('+55 (11) 99999-9999')).toBe(
      '5511999999999@s.whatsapp.net'
    );
  });

  it('caches provider profile data without overwriting the human contact name', () => {
    expect(
      buildContactProfilePatch({
        pushName: 'Nome do WhatsApp',
        picture: 'https://cdn.example/avatar.jpg',
        status: 'Disponível',
      })
    ).toMatchObject({
      whatsapp_push_name: 'Nome do WhatsApp',
      avatar_url: 'https://cdn.example/avatar.jpg',
      whatsapp_profile_status: 'Disponível',
    });
    expect(
      buildContactProfilePatch({ pushName: 'Nome do WhatsApp' })
    ).not.toHaveProperty('name');
  });

  it('normalizes Evolution number-validation arrays', () => {
    expect(
      parseWhatsAppNumberValidation(
        [{ jid: '5511999999999@s.whatsapp.net', exists: true }],
        '5511999999999'
      )
    ).toEqual({ exists: true, jid: '5511999999999@s.whatsapp.net' });
  });

  it('builds button and list composer payloads with deterministic text fallback', () => {
    expect(
      buildInteractiveMessagePayload(
        'interactive_buttons',
        'Como posso ajudar?',
        'Comercial\nSuporte'
      )
    ).toEqual({
      message_type: 'interactive_buttons',
      content_text: 'Como posso ajudar?',
      content_data: {
        native: false,
        buttons: [
          { id: 'option-1', title: 'Comercial' },
          { id: 'option-2', title: 'Suporte' },
        ],
      },
    });

    expect(
      buildInteractiveMessagePayload(
        'interactive_list',
        'Escolha uma área',
        'Financeiro\nProjetos'
      )
    ).toEqual({
      message_type: 'interactive_list',
      content_text: 'Escolha uma área',
      content_data: {
        native: false,
        buttonLabel: 'Abrir opções',
        sections: [
          {
            title: 'Opções',
            rows: [
              { id: 'option-1', title: 'Financeiro' },
              { id: 'option-2', title: 'Projetos' },
            ],
          },
        ],
      },
    });
  });

  it('rejects interactive drafts outside the safe fallback limits', () => {
    expect(() =>
      buildInteractiveMessagePayload('interactive_buttons', '', 'Comercial')
    ).toThrow('mensagem');
    expect(() =>
      buildInteractiveMessagePayload(
        'interactive_buttons',
        'Escolha',
        'Um\nDois\nTrês\nQuatro'
      )
    ).toThrow('3');
    expect(() =>
      buildInteractiveMessagePayload(
        'interactive_list',
        'Escolha',
        'Título de opção com mais de vinte e quatro caracteres'
      )
    ).toThrow('24');
  });

  it('builds a downloadable vCard without injecting line breaks', () => {
    expect(
      buildContactVCard({
        fullName: 'Ana\nSilva',
        phoneNumber: '+55 (11) 98888-0000',
      })
    ).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana Silva\r\nTEL;TYPE=CELL:+55 (11) 98888-0000\r\nEND:VCARD'
    );
  });
});
