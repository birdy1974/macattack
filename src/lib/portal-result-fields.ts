type PortalRecord = Record<string, unknown>;

interface FieldSource {
  path: string;
  value: PortalRecord;
}

interface FoundField {
  value: unknown;
  source: string;
  key: string;
}

export interface ExtractedPortalFields {
  maxConnections: string | null;
  activeConnections: string | null;
  timezone: string | null;
  portalOnline: string | null;
  lastActive: string | null;
  createdAt: Date | null;
  provenance: {
    maxConnections: string | null;
    activeConnections: string | null;
    timezone: string | null;
    portalOnline: string | null;
    lastActive: string | null;
    createdAt: string | null;
    createdAtScope: string | null;
    createdAtRaw: unknown;
  };
}

function asRecord(value: unknown): PortalRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PortalRecord)
    : null;
}

function fieldSources(scope: "account" | "profile", value: unknown): FieldSource[] {
  const root = asRecord(value);
  if (!root) return [];

  const sources: FieldSource[] = [{ path: scope, value: root }];
  for (const containerName of ["user_info", "account", "profile", "stb", "device"]) {
    const nested = asRecord(root[containerName]);
    if (nested) sources.push({ path: `${scope}.${containerName}`, value: nested });
  }
  return sources;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim() !== "";
}

function findField(sources: FieldSource[], aliases: string[]): FoundField | null {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());

  for (const source of sources) {
    const keys = Object.keys(source.value);
    for (const alias of normalizedAliases) {
      const key = keys.find((candidate) => candidate.toLowerCase() === alias);
      if (!key) continue;
      const value = source.value[key];
      if (isPresent(value)) return { value, source: `${source.path}.${key}`, key };
    }
  }

  return null;
}

function toText(value: unknown): string | null {
  if (!isPresent(value)) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Parse portal timestamps without assuming every provider uses the same shape.
 * Numeric epoch values with up to 10 digits are treated as seconds; 12–13
 * digits are treated as milliseconds. Ambiguous 11-digit values are checked
 * against a plausible timestamp range. The original value and source are
 * retained in the result's rawData regardless of whether parsing succeeds.
 */
export function parsePortalDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text || text === "0") return null;

  if (/^\d{9,13}$/.test(text)) {
    const numeric = Number(text);
    const candidateTimes =
      text.length >= 12
        ? [numeric, numeric * 1000]
        : text.length <= 10
          ? [numeric * 1000, numeric]
          : [numeric * 1000, numeric];

    for (const timestamp of candidateTimes) {
      const candidate = new Date(timestamp);
      const year = candidate.getUTCFullYear();
      if (Number.isFinite(candidate.getTime()) && year >= 1970 && year <= 2200) {
        return candidate;
      }
    }
    return null;
  }

  // Preserve date-only values as UTC midnight. For timestamps with an explicit
  // timezone, Date.parse respects that offset. Legacy space-separated portal
  // values are accepted as-is; the raw server value remains available too.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00.000Z`
    : text.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

/**
 * Extract a small set of useful, common fields from the portal responses.
 * The original responses are also kept separately in rawData, so fields not
 * known to this mapper are never discarded.
 */
export function extractPortalFields(
  profile: unknown,
  account: unknown
): ExtractedPortalFields {
  const profileSources = fieldSources("profile", profile);
  const accountSources = fieldSources("account", account);
  const accountThenProfile = [...accountSources, ...profileSources];

  const max = findField(accountThenProfile, [
    "max_connections",
    "max_con",
    "max_conn",
    "max_sessions",
    "max_playback_sessions",
  ]);
  const active = findField(accountThenProfile, [
    "active_cons",
    "active_connections",
    "active_sessions",
    "active_playback_sessions",
    "current_connections",
    "current_sessions",
  ]);
  const timezone =
    findField([...profileSources, ...accountSources], ["timezone", "time_zone"]) ??
    findField([...profileSources, ...accountSources], ["default_timezone"]);
  const online = findField([...profileSources, ...accountSources], [
    "online",
    "is_online",
    "device_online",
  ]);
  const lastActive = findField([...profileSources, ...accountSources], [
    "last_active",
    "lastActive",
    "last_activity",
    "lastActivity",
  ]);

  const createdCandidates = [
    findField(accountSources, ["created_at", "createdAt", "created_date", "registration_date"]),
    findField(profileSources, ["created_at", "createdAt", "created_date", "registration_date"]),
    findField(profileSources, ["created"]),
    findField(accountSources, ["created"]),
  ].filter((field): field is FoundField => field !== null);
  // Ignore placeholder/unparseable dates when another response supplies a
  // usable creation time, but keep the first raw candidate for provenance if
  // none of the candidates can be interpreted as a date.
  const created =
    createdCandidates.find((field) => parsePortalDate(field.value) !== null) ??
    createdCandidates[0] ??
    null;

  const createdAtScope = !created
    ? null
    : created.source.startsWith("profile.") && created.key.toLowerCase() === "created"
      ? "stb_record"
      : created.source.startsWith("account.")
        ? "account_or_provider_record"
        : "unknown_record";

  return {
    maxConnections: max ? toText(max.value) : null,
    activeConnections: active ? toText(active.value) : null,
    timezone: timezone ? toText(timezone.value) : null,
    portalOnline: online ? toText(online.value) : null,
    lastActive: lastActive ? toText(lastActive.value) : null,
    createdAt: created ? parsePortalDate(created.value) : null,
    provenance: {
      maxConnections: max?.source ?? null,
      activeConnections: active?.source ?? null,
      timezone: timezone?.source ?? null,
      portalOnline: online?.source ?? null,
      lastActive: lastActive?.source ?? null,
      createdAt: created?.source ?? null,
      createdAtScope,
      createdAtRaw: created?.value ?? null,
    },
  };
}
