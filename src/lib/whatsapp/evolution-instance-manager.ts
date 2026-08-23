export type EvolutionInstanceSnapshot = {
  name: string;
  state: string;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function nameFrom(value: unknown): string | null {
  const item = record(value);
  const nested = record(item.instance);
  const raw =
    item.instanceName ??
    item.name ??
    nested.instanceName ??
    nested.name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  return name || null;
}

function stateFrom(value: unknown): string {
  const item = record(value);
  const nested = record(item.instance);
  const raw =
    item.state ??
    item.status ??
    item.connectionStatus ??
    nested.state ??
    nested.status ??
    nested.connectionStatus;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'unknown';
}

/**
 * Normalizes Evolution v2 list payloads without relying on one Manager build's
 * envelope. It accepts the observed array response and the common `{ instances }`
 * or `{ data }` wrappers, returning only safe public instance metadata.
 */
export function normalizeEvolutionInstanceList(payload: unknown): EvolutionInstanceSnapshot[] {
  const root = record(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(root.instances)
      ? root.instances
      : Array.isArray(root.data)
        ? root.data
        : [];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const name = nameFrom(candidate);
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{ name, state: stateFrom(candidate) }];
  });
}
