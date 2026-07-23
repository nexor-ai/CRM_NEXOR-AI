import { describe, expect, it } from 'vitest';
import {
  safeInteractiveOptions,
  safePollValues,
} from './message-content-normalize';

describe('safePollValues', () => {
  it('returns only valid string values', () => {
    expect(safePollValues({ values: ['Sim', null, 2, 'Não'] })).toEqual([
      'Sim',
      'Não',
    ]);
  });

  it('returns an empty list for malformed payloads', () => {
    expect(safePollValues({ values: {} })).toEqual([]);
    expect(safePollValues(null)).toEqual([]);
  });
});

describe('safeInteractiveOptions', () => {
  it('combines valid buttons and section rows', () => {
    expect(
      safeInteractiveOptions({
        buttons: [{ id: 'yes', title: 'Sim' }],
        sections: [
          { rows: [{ id: 'sales', title: 'Comercial' }] },
        ],
      })
    ).toEqual([
      { id: 'yes', title: 'Sim' },
      { id: 'sales', title: 'Comercial' },
    ]);
  });

  it('ignores malformed sections, rows and options without crashing', () => {
    expect(
      safeInteractiveOptions({
        buttons: 'invalid',
        sections: [
          null,
          { rows: null },
          { rows: [null, { title: '  Opção válida  ' }, { id: 'x' }] },
        ],
      })
    ).toEqual([{ id: 'option-1', title: 'Opção válida' }]);
  });
});
