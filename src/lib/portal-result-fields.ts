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
  expireDate: string | null;
  phoneNumber: string | null;
  maxConnections: string | null;
  activeConnections: string | null;
  timezone: string | null;
  portalOnline: string | null;
  lastActive: string | null;
  createdAt: Date | null;
  provenance: {
    expireDate: string | null;
    expireDateRaw: unknown;
    phoneNumber: string | null;
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

const ZERO_DATE_PATTERN =
  /^0{2,4}[-./]0{1,2}[-./]0{1,4}(?:[T\s]+0{1,2}:0{1,2}(?::0{1,2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

const PLACEHOLDER_TEXT_PATTERN = /^(0|-1|null|undefined|none|n\/a|na|-+|false)$/i;

const EXPIRY_FIELD_ALIASES = [
  "end_date",
  "endDate",
  "expire_billing_date",
  "expireBillingDate",
  "expire_date",
  "expireDate",
  "exp_date",
  "expDate",
  "expire",
  "expiry",
  "expiration_date",
  "expirationDate",
];

const REAL_PHONE_FIELD_ALIASES = [
  "phone_number",
  "phoneNumber",
  "mobile",
  "contact_phone",
  "contactPhone",
  "telephone",
  "tel",
];

function asRecord(value: unknown): PortalRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PortalRecord)
    : null;
}

function fieldSources(scope: "account" | "profile", value: unknown): FieldSource[] {
  const root = asRecord(value);
  if (!root) return [];

  const sources: FieldSource[] = [{ path: scope, value: root }];
  for (const containerName of [
    "js",
    "data",
    "user_info",
    "account_info",
    "account",
    "profile",
    "stb",
    "device",
  ]) {
    const nested = asRecord(root[containerName]);
    if (nested) sources.push({ path: `${scope}.${containerName}`, value: nested });
  }
  return sources;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim() !== "";
}

/**
 * Determine whether a portal field contains a meaningful expiry value rather
 * than a MySQL/Stalker placeholder such as "0000-00-00 00:00:00", "0", or "".
 */
export function isMeaningfulExpiryValue(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean") {
    return false;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }
  if (typeof value === "object") {
    return false;
  }
  const text = String(value).trim();
  if (!text) return false;
  if (PLACEHOLDER_TEXT_PATTERN.test(text)) return false;
  if (ZERO_DATE_PATTERN.test(text)) return false;
  return true;
}

function findField(
  sources: FieldSource[],
  aliases: string[],
  predicate: (value: unknown) => boolean = isPresent
): FoundField | null {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());

  for (const source of sources) {
    const keys = Object.keys(source.value);
    for (const alias of normalizedAliases) {
      const key = keys.find((candidate) => candidate.toLowerCase() === alias);
      if (!key) continue;
      const value = source.value[key];
      if (predicate(value)) return { value, source: `${source.path}.${key}`, key };
    }
  }

  return null;
}

function toText(value: unknown): string | null {
  if (!isPresent(value)) return null;
  if (typeof value === "string") return value.trim();
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
 * against a plausible timestamp range. Supports ISO YYYY-MM-DD, European
 * DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY, and human-readable English date
 * strings returned in Stalker's `phone` field (e.g. "March 15, 2027, 2:30 pm").
 */
export function parsePortalDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === null || value === undefined || typeof value === "boolean") return null;

  const text = String(value).trim();
  if (!text || PLACEHOLDER_TEXT_PATTERN.test(text) || ZERO_DATE_PATTERN.test(text)) {
    return null;
  }

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

  // If the string carries an explicit timezone offset (Z or +/-HH:MM), let
  // Date.parse honor that offset.
  if (
    /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i.test(
      text
    )
  ) {
    const timestamp = Date.parse(text.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T"));
    if (Number.isFinite(timestamp)) {
      const candidate = new Date(timestamp);
      const year = candidate.getUTCFullYear();
      if (year >= 1970 && year <= 2200) return candidate;
    }
  }

  // YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD (optionally with HH:MM[:SS], or embedded in text)
  const ymd =
    /(?:^|\b)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\b|$)/.exec(
      text
    );
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    const hour = ymd[4] ? Number(ymd[4]) : 0;
    const minute = ymd[5] ? Number(ymd[5]) : 0;
    const second = ymd[6] ? Number(ymd[6]) : 0;
    if (year >= 1970 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      if (Number.isFinite(candidate.getTime())) return candidate;
    }
  }

  // DD-MM-YYYY, DD.MM.YYYY, DD/MM/YYYY (or MM/DD/YYYY when the second part > 12)
  const dmy =
    /(?:^|\b)(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\b|$)/.exec(
      text
    );
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    const year = Number(dmy[3]);
    const hour = dmy[4] ? Number(dmy[4]) : 0;
    const minute = dmy[5] ? Number(dmy[5]) : 0;
    const secondPart = dmy[6] ? Number(dmy[6]) : 0;
    const day = second > 12 && first <= 12 ? second : first;
    const month = second > 12 && first <= 12 ? first : second;
    if (year >= 1970 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, secondPart));
      if (Number.isFinite(candidate.getTime())) return candidate;
    }
  }

  const timestamp = Date.parse(text);
  if (Number.isFinite(timestamp)) {
    const candidate = new Date(timestamp);
    const year = candidate.getUTCFullYear();
    if (year >= 1970 && year <= 2200) return candidate;
  }
  return null;
}

/**
 * Extract the subscription expiration date from Stalker `get_profile` and
 * `get_main_info` payloads.
 *
 * In Stalker/Ministra middleware the `phone` field (returned by
 * `type=account_info&action=get_main_info`, and sometimes present in
 * `get_profile`) contains the subscription expiration date, while
 * `get_profile.expire_billing_date` / `end_date` is frequently left at the
 * MySQL zero-date default `"0000-00-00 00:00:00"`.
 *
 * Priority order:
 *   1. `account.phone` (primary Stalker account_info expiry field)
 *   2. `profile.phone` (fallback if `get_main_info` omitted `phone`)
 *   3. Other expiry fields (`end_date`, `expire_billing_date`, `expire`,
 *      `expiry`, `endDate`, `exp_date`, ...) in `account`, then `profile`
 *
 * Placeholder values (`""`, `"0"`, `"0000-00-00 00:00:00"`, etc.) are skipped
 * at every step so they never shadow the real expiration date.
 */
export function extractPortalExpiry(profile: unknown, account: unknown): string {
  return extractPortalFields(profile, account).expireDate ?? "";
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

  // Prioritize the `phone` field (which in Stalker holds the subscription
  // expiration date and was the original source of the date shown in the old
  // "Phone Number" column) before checking `end_date` / `expire_billing_date`,
  // and skip zero-date placeholders such as "0000-00-00 00:00:00".
  const expiryCandidate =
    findField(accountSources, ["phone"], isMeaningfulExpiryValue) ??
    findField(profileSources, ["phone"], isMeaningfulExpiryValue) ??
    findField(accountSources, EXPIRY_FIELD_ALIASES, isMeaningfulExpiryValue) ??
    findField(profileSources, EXPIRY_FIELD_ALIASES, isMeaningfulExpiryValue);

  const expireDate = expiryCandidate ? toText(expiryCandidate.value) : null;

  const rawPhoneCandidate = findField(accountThenProfile, REAL_PHONE_FIELD_ALIASES);
  const rawPhoneText = rawPhoneCandidate ? toText(rawPhoneCandidate.value) : null;
  const phoneNumber =
    rawPhoneText &&
    rawPhoneText !== expireDate &&
    parsePortalDate(rawPhoneText) === null &&
    !ZERO_DATE_PATTERN.test(rawPhoneText)
      ? rawPhoneText
      : null;

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
    expireDate,
    phoneNumber,
    maxConnections: max ? toText(max.value) : null,
    activeConnections: active ? toText(active.value) : null,
    timezone: timezone ? toText(timezone.value) : null,
    portalOnline: online ? toText(online.value) : null,
    lastActive: lastActive ? toText(lastActive.value) : null,
    createdAt: created ? parsePortalDate(created.value) : null,
    provenance: {
      expireDate: expiryCandidate?.source ?? null,
      expireDateRaw: expiryCandidate?.value ?? null,
      phoneNumber: phoneNumber ? (rawPhoneCandidate?.source ?? null) : null,
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
