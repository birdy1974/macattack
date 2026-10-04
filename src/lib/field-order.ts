/** Move one item to the position occupied by another item. */
export function moveItem<T>(items: readonly T[], item: T, target: T): T[] {
  const fromIndex = items.indexOf(item);
  const targetIndex = items.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
    return [...items];
  }

  const reordered = [...items];
  reordered.splice(fromIndex, 1);
  reordered.splice(targetIndex, 0, item);
  return reordered;
}

/**
 * Merge a preferred order with the full list of known keys.
 *
 * The preferred order wins for keys it mentions; keys the caller knows about
 * but the preference does not are appended in their canonical order so newly
 * added fields never disappear. Unknown keys (e.g. from an older release) are
 * dropped.
 */
export function mergeOutputFieldOrder(
  allKeys: readonly string[],
  preferred: readonly string[]
): string[] {
  const known = new Set(allKeys);
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const key of preferred) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  for (const key of allKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  return merged;
}

/**
 * Settings key holding the user's preferred Output Fields order, so a drag
 * survives a reload and applies to the next scan's table and CSV/TXT export.
 * Stored as a JSON array of field keys in the `settings` table.
 */
export const OUTPUT_FIELD_ORDER_SETTING_KEY = "output_field_order";

const MAX_FIELD_KEYS = 100;
const MAX_FIELD_KEY_LENGTH = 64;

/** Reduce an arbitrary value to a clean, duplicate-free list of field keys. */
export function sanitizeOutputFieldOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const order: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!key || key.length > MAX_FIELD_KEY_LENGTH) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
    if (order.length >= MAX_FIELD_KEYS) break;
  }
  return order;
}

/**
 * Read the stored setting. The canonical form is a JSON array; a whitespace or
 * comma separated list is also accepted so hand-edited values keep working.
 */
export function parseOutputFieldOrderSetting(raw: unknown): string[] {
  if (typeof raw !== "string") return [];

  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith("[")) {
    try {
      return sanitizeOutputFieldOrder(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return sanitizeOutputFieldOrder(text.split(/[\s,]+/));
}

/** Serialise the order for the `settings` table (never throws). */
export function serializeOutputFieldOrder(order: readonly string[]): string {
  return JSON.stringify(sanitizeOutputFieldOrder(order));
}
