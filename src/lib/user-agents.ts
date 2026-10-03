/**
 * User-agent rotation.
 *
 * Some Stalker portals reject the "canonical" MAG user-agent (or answer it
 * differently), which makes a working portal look dead. The scanner therefore
 * tries a small, ordered list of user agents and remembers the winner per
 * portal host in the settings table.
 */

export const MAG_USER_AGENT =
  process.env.MACATTACK_STB_USER_AGENT ||
  "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";

/** Ordered candidates: the canonical MAG UA first, then common alternates. */
export const DEFAULT_USER_AGENTS: string[] = [
  MAG_USER_AGENT,
  "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 2 rev: 250 Safari/533.3",
  "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 stbapp ver: 4 rev: 272 Safari/533.3",
  "VLC/3.0.20 LibVLC/3.0.20",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
];

export const UA_SETTING_PREFIX = "ua_winner:";

/** Parse a user-supplied UA list (one per line); empty input keeps the defaults. */
export function parseUserAgentList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 8)
    .slice(0, 10);
}

/**
 * Build the ordered candidate list for a portal host: the remembered winner
 * first (if any), then the configured/default list without duplicates.
 */
export function buildUserAgentCandidates(
  remembered: string | null | undefined,
  configured: string[] | null | undefined
): string[] {
  const list = configured && configured.length > 0 ? configured : DEFAULT_USER_AGENTS;
  const candidates = [remembered, ...list].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return Array.from(new Set(candidates));
}

export function userAgentSettingKey(portalHost: string): string {
  return `${UA_SETTING_PREFIX}${portalHost.toLowerCase()}`;
}
