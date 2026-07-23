import { describe, expect, it } from 'vitest';
import { uniqueReadReceipts } from './read-receipts';

describe('uniqueReadReceipts', () => {
  it('deduplicates transport ids and ignores messages from another instance', () => {
    expect(
      uniqueReadReceipts(
        [
          { message_id: 'same-id', whatsapp_instance: 'primary' },
          { message_id: 'same-id', whatsapp_instance: 'primary' },
          { message_id: 'other-instance', whatsapp_instance: 'secondary' },
          { message_id: 'legacy-id', whatsapp_instance: null },
          { message_id: null, whatsapp_instance: 'primary' },
        ],
        'primary',
        '5511999999999@s.whatsapp.net'
      )
    ).toEqual([
      {
        id: 'same-id',
        remoteJid: '5511999999999@s.whatsapp.net',
        fromMe: false,
      },
      {
        id: 'legacy-id',
        remoteJid: '5511999999999@s.whatsapp.net',
        fromMe: false,
      },
    ]);
  });
});
