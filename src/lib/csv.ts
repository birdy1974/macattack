/**
 * Minimal RFC 4180 CSV writing for the scan-result download.
 *
 * Every cell — including the header row — goes through the same quoting:
 * a value is wrapped in double quotes and embedded double quotes are
 * doubled. Quoting the values but not the headers was the bug behind
 * misaligned exports: one header ("Stream Time to First Byte (ms, median)")
 * contained a comma, so a CSV reader saw an extra header cell and every
 * column after it shifted by one.
 *
 * Project rule that goes with this helper (enforced by wave-tests): header
 * texts themselves must not contain commas, quotes or line breaks. Proper
 * quoting would survive a comma, but parsers/tools that split naively on
 * "," would not — so headers stay comma-free *and* correctly quoted.
 */

/** Escape one CSV cell. Non-strings are coerced; null/undefined become "". */
export function escapeCsvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Serialise one row (header or data) with every cell escaped alike. */
export function toCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvField).join(",");
}

/** Serialise a header row plus data rows into a complete CSV document. */
export function buildCsv(headers: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  return [toCsvRow(headers), ...rows.map(toCsvRow)].join("\n");
}

/**
 * True when a header text is safe to use as a CSV column header under the
 * project rule above: no comma (the delimiter), quote, CR or LF.
 */
export function isCsvSafeHeader(header: string): boolean {
  return !/[",\r\n]/.test(header);
}
