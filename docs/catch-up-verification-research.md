# Catch-up/archive verification: research and implementation

Research date: **18 October 2026**. Scope: public provider documentation, maintained
player implementations and verification tools. No third-party IPTV accounts were
tested. Use these checks only with accounts/portals you are authorized to access.

## Main finding: archive support is per channel, not per account or genre

Ministra exposes archive configuration on each channel, including archive type,
archive storage and recording address. Consequently, a genre can contain a mix of
archived and live-only channels; a working archive on News does not establish
anything about Sports, and failure on Sports does not disprove News archives.
[11](https://wiki.infomir.eu/eng/ministra-tv-platform/administrative-panel/iptv-channels/how-to-set-the-tv-archive-on-the-channel)

Xtream likewise supplies `tv_archive` and `tv_archive_duration` on individual live
stream items. These are advertisements, not playback results.
[21](https://deepwiki.com/northernpowerhouse/pvr.dispatcharr/6.1-xtream-codes-api)

**Design implication:** inspect archive metadata across the fetched catalogue,
then select archive candidates independently of the live-quality sample or watch
list. Round-robin genres/categories and preserve each attempted channel's outcome.
A bounded catalogue fetch must never be described as a complete provider audit.

## The different playback/verification paths

| Family | Discovery and request | Important differences | MacAttack status |
| --- | --- | --- | --- |
| Native Stalker/Ministra programme archive | Channel archive flags; `type=epg&action=get_simple_data_table&ch_id=…&date=…`; finished programme ID; `type=tv_archive&action=create_link&cmd=auto /media/<programme-id>.mpg` | Programme ID is not channel ID. Check `mark_archive` when present and programme timestamps. Use portal-request timezone for the day. | Implemented, bounded to two EPG pages per requested window. |
| Stalker timestamp-window compatibility | `type=itv&action=create_link`, channel command plus `start`/`end` | Not a universal native Ministra API contract. Some portals support it, others ignore the timestamps and return live media. | Retained as a fallback; an unchanged known live URL is rejected. |
| Xtream Codes | Per-channel `tv_archive`; `/timeshift/<user>/<pass>/<duration-minutes>/<YYYY-MM-DD:HH-MM>/<stream-id>.ts` | Wall-clock start should use `server_info.timezone`, not scanner/browser local time. Duration units differ from some other implementations. | Standard minute-based `.ts` path implemented; invalid reported timezones are a diagnostic failure, absent timezone uses UTC with an explicit limitation. |
| M3U `default` | Expand full `catchup-source` template | Provider defines the template, placeholders, encoding and timestamp convention. | Researched; not implemented as a new M3U input pipeline. |
| M3U `append` | Expand source fragment and append to live URL | Preserve authentication/query parameters; do not blindly replace the path. | Researched; not implemented. |
| SIPTV `shift` | Common convention appends `utc=<start>&lutc=<now>` | Legacy `timeshift` tags may combine availability and retention. Must be explicitly declared/configured, not guessed for every URL. | Researched; not implemented. |
| Flussonic | Fixed archive range (`archive-<start>-<duration>.*`) or absolute/relative timeshift paths | Epoch seconds; HLS/TS/DASH variants differ. Session reuse affects repeated absolute HLS requests. | Researched; no blind URL rewriting of arbitrary Stalker links. |
| Other player dialects | `xc60`, `vod`, `archive`, `timeshift` and provider-specific templates | Different units and EPG identifiers; not interchangeable with similarly named endpoints. | Documented follow-up, not claimed as supported. |

The native Stalker programme flow is visible in e2iplayer's channel → day →
programme implementation (including `mark_archive`, the channel ID for EPG lookup
and the programme ID for archive playback):
[12](https://github.com/oe-mirrors/e2iplayer/pull/675).
The implementation inspected is
[1](https://github.com/oe-mirrors/e2iplayer/blob/master/IPTVPlayer/hosts/hoststalker.py).
Older middleware request traces independently show `type=tv_archive` with an
`auto /media/…mpg` command:
[2](https://groups.google.com/g/stalker-middleware/c/zCI1BpkEUHI).

Kodi IPTV Simple documents channel-level `catchup`, `catchup-source`,
`catchup-days`, `catchup-correction`, full-source vs appended-source semantics,
Flussonic/Xtream automatic modes, and legacy SIPTV conventions:
[1](https://github.com/kodi-pvr/pvr.iptvsimple).
OTT Navigator documents additional dialects and substitutions; this is evidence
of player/provider conventions, not one universal IPTV standard:
[26](https://ottnav.github.io/faq.html).

Xtream timezone problems are not hypothetical: IPTVChecker and IPTVnator report
fixes for using the panel's timezone rather than the client's timezone:
[11](https://github.com/kristofferR/IPTVChecker/pull/232)
[29](https://4gray.github.io/iptvnator/blog/v0-24-release-notes/).

Flussonic's own manual distinguishes fixed ranges and open-ended timeshift:
[4](https://flussonic.com/doc/digital-video-recording-dvr/dvr-playback/).
Its documentation also warns that repeated absolute HLS timeshift requests can
reuse a session and produce unexpected chunks:
[5](https://flussonic.com/en-us/doc/digital-video-recording-dvr/recording-broadcasts-catchup-tv/).
This is a reason to avoid treating a simple URL comparison as content proof.

### Retention units are not universal

Ministra's documented archive configuration is expressed as hourly parts
(`168` parts for a week). The inspected Stalker player also notes hours in native
Ministra, with heuristics for nonstandard panels reporting days.
[10](https://wiki.infomir.eu/eng/ministra-tv-platform/ministra-installation-guide/configuration-file)
[1](https://github.com/oe-mirrors/e2iplayer/blob/master/IPTVPlayer/hosts/hoststalker.py)

MacAttack now normalizes native Stalker durations from **hours to days**; Xtream
continues to interpret durations as **days**. It intentionally does not guess
whether a small Stalker number is an undocumented day-based variant. Such portals
need a future explicit per-provider unit override rather than a universal
heuristic. Unknown/zero retention stays unknown; it is not proof of no archive.

## What counts as verification?

Use an evidence ladder rather than one undifferentiated “catch-up supported” flag:

1. **Advertised:** metadata says the channel has an archive.
2. **Resolvable:** an archive request produces an archive-specific playback URL.
3. **Media playable:** a real media probe reads media from that URL (not merely an
   HTTP 200 page or playlist body).
4. **Historical time corroborated:** trustworthy broadcast timestamps correspond
   to the requested programme/window. For HLS, `EXT-X-PROGRAM-DATE-TIME` is useful
   when provided; Flussonic shows it in its media playlists.
   [6](https://flussonic.com/en-us/doc/video-playback/hls-playback/)
5. **Content corroborated:** programme/content or an appropriate live-vs-archive
   comparison corroborates the past broadcast. A different signed URL is not
   enough: a provider can change tokens and still return the live feed.
6. **Retention sampled:** several independent, in-window points across days and
   channels are playable. A success one hour ago does not prove seven days.

**Implemented evidence stops at level 3.** For compatibility, stored status
`verified` remains, but reports identify `evidence: archive_url_and_media`, and the
UI says **archive media playable (spot check)**. Timestamp/content corroboration,
frame/audio comparison and a full day-by-day retention audit are not implemented.
No decoder/decryption guarantee is made by a transport media probe.

IPTVChecker's public implementation uses archive spot probes (a recent point and
advertised depth) and explicitly separates discovery, URL building and playback.
Its PR states that the feature was unit-tested, not live-tested at that point:
[5](https://github.com/kristofferR/IPTVChecker/pull/233).
That is useful comparative design evidence, not independent proof that every
provider supports those formats.

## Changes made in MacAttack

- Candidate source: all fetched Stalker channels / Xtream streams, not the live
  sample. Catalogue limits still apply (Stalker fallback visits bounded genres
  and pages); “not advertised” means **not found in the fetched catalogue**.
- Recognize `enable_tv_archive`, existing archive flag aliases and positive
  Stalker archive duration metadata.
- At most **3 unique channels**, selected round-robin across genres/categories.
- Try windows ending **60 and 240 minutes ago**, with a 30-minute clip; skip
  windows extending beyond known retention. Shorter archives get a more recent
  in-retention window when a 30-minute clip fits.
- Stalker: try native programme resolution before timestamp-window compatibility.
- Xtream: standard `.ts` timeshift URL using provider timezone.
- Continue after link/media failures; a broken first candidate does not terminate
  the account's checks. Stop further windows for a channel after its first success,
  but retain other channels' successes/failures in the report.
- Preserve channel, genre, request method, window, link result, media byte count
  and failure reason per attempt; include advertised/tested channel and genre
  counts, limited-sample indicator and evidence level.
- Cancellation is respected. Background monitors do not run archive checks.
- Do not export a recent successful spot-check offset as “verified retention days”.
  `qualityCatchUpDays` is left null for these new spot checks; see the report's
  `advertisedDays` and `verifiedMinutes` for the separate pieces of evidence.

### Known compatibility limits / next steps

- Native EPG lookup is intentionally bounded. Programme tables with many pages,
  missing timestamps or different endpoint shapes may fail the sampled native
  path even when their archive works. Broader adaptive paging is a follow-up.
- Xtream alternate formats (`.m3u8`, `timeshift.php`, second-based variants) need
  provider-aware fallback rather than unconditional URL guessing.
- M3U templates/Flussonic inputs need explicit metadata parsing and validated
  template substitution; existing Stalker commands must not be blindly rewritten.
- Native Stalker retention units and cookie timezone may need per-provider
  overrides for nonstandard deployments.
- Success on one candidate and failure on another is partial channel coverage,
  not a contradiction or a portal-wide capability guarantee.
- Paid rights, regional restrictions, recording gaps and provider outages require
  real authorized-provider testing; local fixtures cannot establish compatibility.

## New-search lifecycle and live dashboard

Starting a **new** search clears generated JPEGs from configured and fallback
thumbnail caches, resets browser result/detail/history/monitor/playlist-URL display
caches, and prevents in-flight old measurements from saving frames after the reset.
It does **not** delete durable job/result history, saved account/settings data,
monitor definitions or issued subscription tokens. Those are not temporary files.
Old reports can retain historical thumbnail filenames, but the corresponding
images are gone; re-check an old result to capture a new image. Unrelated data files
and directories in the thumbnail directory are not recursively deleted.

Concurrent active searches are rejected before cache deletion. Deletion failures
fail the new-search request instead of silently claiming an empty cache. Browser
thumbnail responses use `no-store`. Thumbnail cache reset is not a user-content
wipe or a browser-history purge.

The quality dashboard derives from compact result fields returned by the existing
**1.5-second status poll**, independently of console auto-refresh. It shows found /
checked / awaiting measurements, score averages, verdict distribution, sampled
channel availability, first-byte latency, picture warnings, archive outcomes,
highest-scoring addresses and sampled genre summaries. Null measurements are not
zeros. Newly saved addresses are published before their slower quality checks
finish; manual rechecks also refresh the dashboard, even after scan polling stops.

## Validation

- `npm run test:scan-quality`: offline dashboard maths, archive candidate diversity,
  retries/partial success/live-URL rejection/cancellation, Xtream timezone URL
  formatting and primary/fallback cache lifecycle, including in-flight writes.
- `npm run test:quality` against local fixtures: native Stalker EPG/archive flow,
  archive discovery outside a Sports-only live watchlist, normalized hours/days.
- `npm run test:xtream` against local fixtures: standard timeshift media check.
- `npm run test:waves`: existing picture/thumbnail/store and other unit regressions.
- TypeScript and active-source ESLint checks. Full repository lint also scans an
  unchanged `initial/` starter whose pre-existing React hook errors remain.


## Per-MAC channel/genre persistence

The result now has a durable `quality_catch_up_summary` JSONB column, mirrored
inside the full quality report's `catchUp` field. It stores the advertised channel
inventory (IDs, names, genre IDs/titles, retention) alongside per-channel outcomes,
check timestamps and attempts. Genre rollups count playable, failed and untested
channels separately. Duplicate channel names do not combine distinct channel IDs.

`POST /api/scan/catch-up` accepts `{ resultId, channelKey? }`. Credentials, MAC and
portal are loaded from the saved result, never supplied by this request. With a
channel key it checks that channel; without one it discovers/checks an initial
sample or the next untested batch, up to three channels. It refreshes the catalogue
and skips already-tested channels when extending coverage. Each request has a
90-second cancellation budget; interrupted checks do not turn untested channels
into negative capability claims.

Short PostgreSQL row locks merge concurrent completed batches without holding a
transaction open during media/network requests. Latest per-channel timestamps win;
live-only/disabled archive checks preserve existing archive evidence. Archive-only
updates do not change live scores, live measurement timestamps or thumbnail files.
The saved inventory is included in status/detail responses and JSON exports; an
optional result/CSV/TXT field formats the channel/genre outcomes for reading.

Additional validation:

- `npm run test:catchup`: stable identities, mixed genre outcomes, JSON round-trip,
  cumulative/failed/stale rechecks, disabled-monitor preservation and UI markup.
- `DATABASE_URL=postgresql://.../<disposable-local-name>_test npm run test:catchup-db`:
  requires a pre-initialized disposable local PostgreSQL database and local media
  fixtures. Exercises actual persistence, the catch-up POST, status/detail reloads,
  CSV export, MAC isolation, live-score preservation and concurrent batch merging.
  The script rejects non-local databases and names not ending in `_test`, creates
  only its own temporary job/results, then deletes those records.
