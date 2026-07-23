export interface SafeInteractiveOption {
  id: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safePollValues(contentData: unknown): string[] {
  if (!isRecord(contentData) || !Array.isArray(contentData.values)) return [];
  return contentData.values.filter(
    (value): value is string => typeof value === 'string'
  );
}

export function safeInteractiveOptions(
  contentData: unknown
): SafeInteractiveOption[] {
  if (!isRecord(contentData)) return [];

  const candidates: unknown[] = [];
  if (Array.isArray(contentData.buttons)) {
    candidates.push(...contentData.buttons);
  }
  if (Array.isArray(contentData.sections)) {
    for (const section of contentData.sections) {
      if (isRecord(section) && Array.isArray(section.rows)) {
        candidates.push(...section.rows);
      }
    }
  }

  return candidates.flatMap((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.title !== 'string') return [];
    const title = candidate.title.trim();
    if (!title) return [];
    return [
      {
        id:
          typeof candidate.id === 'string' && candidate.id.length > 0
            ? candidate.id
            : `option-${index}`,
        title,
      },
    ];
  });
}
