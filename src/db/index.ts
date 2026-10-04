import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaMigrationRun?: boolean;
  __arenaMigrationPromise?: Promise<void>;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);

// Columns added after initial release — we add them idempotently on boot so
// upgrades from older MacAttack installs don't break. The historical SQL name
// ping_loss_pct is retained for compatibility; it stores TCP probe failures,
// not IP packet loss.
const JOB_ALTERS = [
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_min_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_avg_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_max_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_stdev_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_loss_pct REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_probes INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_successful INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_probe_ms INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_p50_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_p95_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_window_ms INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_rtts JSONB",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS diagnostics_at TIMESTAMP",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_dns_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_tcp_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_tls_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_ttfb_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_total_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_status_code INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_error TEXT",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_error TEXT",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS server_ip TEXT",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS server_geo_raw JSONB",
  // Filters
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_keywords TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_match_live INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_match_vod INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_match_series INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS expire_filter_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS expire_filter_min_date TEXT",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS expire_filter_include_unlimited INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS quality_check_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS quality_channels INTEGER NOT NULL DEFAULT 3",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS quality_sample_ms INTEGER NOT NULL DEFAULT 8000",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS portal_urls JSONB",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS scan_mode TEXT NOT NULL DEFAULT 'prefix'",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS mac_list JSONB",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS concurrency INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ua_rotation_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS picture_checks_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS thumbnails_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS catch_up_check_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS xtream_username TEXT",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS xtream_password TEXT",
];
const RESULT_ALTERS = [
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS response_time_ms INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS handshake_time_ms INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS account_info_time_ms INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS portal_online TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS last_active TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS stalker_server_path TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_verdict TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_score REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_speed_score REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_quality_score REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_stability_score REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_resolution TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_codec TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_throughput_mbps REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_required_mbps REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_channels_playable INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_channels_probed INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_checked_at TIMESTAMP",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_report JSONB",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_frozen INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_label_mismatch TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_retries INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_throughput_cv REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_catch_up_status TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_catch_up_days REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_thumbnail TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_ewma REAL",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_trend TEXT",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS quality_genre_summary JSONB",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'stalker'",
  // Per-MAC category totals written into every saved result / export.
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS itv_genre_count INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS vod_category_count INTEGER",
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS series_category_count INTEGER",
];

// Tables added after the initial release (probe history, playlist tokens,
// monitoring, proxy pool). Created idempotently so upgrades need no tooling.
const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS quality_probe_runs (
     id SERIAL PRIMARY KEY,
     result_id INTEGER NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE,
     job_id INTEGER,
     mac_address TEXT NOT NULL,
     measured_at TIMESTAMP NOT NULL DEFAULT NOW(),
     overall_score REAL,
     speed_score REAL,
     quality_score REAL,
     stability_score REAL,
     verdict TEXT,
     throughput_mbps REAL,
     required_mbps REAL,
     channels_playable INTEGER,
     channels_probed INTEGER,
     frozen INTEGER DEFAULT 0,
     label_mismatches INTEGER DEFAULT 0,
     via_proxy TEXT,
     source TEXT NOT NULL DEFAULT 'scan',
     created_at TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS quality_probe_runs_result_idx ON quality_probe_runs (result_id, measured_at)`,
  `CREATE TABLE IF NOT EXISTS playlist_tokens (
     id SERIAL PRIMARY KEY,
     result_id INTEGER NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE,
     token TEXT NOT NULL UNIQUE,
     limit_count INTEGER NOT NULL DEFAULT 200,
     revoked INTEGER NOT NULL DEFAULT 0,
     fetch_count INTEGER NOT NULL DEFAULT 0,
     last_fetched_at TIMESTAMP,
     created_at TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS monitors (
     id SERIAL PRIMARY KEY,
     result_id INTEGER NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE,
     enabled INTEGER NOT NULL DEFAULT 1,
     interval_minutes INTEGER NOT NULL DEFAULT 360,
     alert_on TEXT NOT NULL DEFAULT 'degrading,poor,unusable',
     channels INTEGER NOT NULL DEFAULT 3,
     sample_ms INTEGER NOT NULL DEFAULT 8000,
     last_run_at TIMESTAMP,
     last_verdict TEXT,
     last_score REAL,
     last_trend TEXT,
     last_alert_at TIMESTAMP,
     last_alert_reason TEXT,
     created_at TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS proxies (
     id SERIAL PRIMARY KEY,
     value TEXT NOT NULL,
     display TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     last_ok INTEGER,
     last_latency_ms INTEGER,
     last_error TEXT,
     last_checked_at TIMESTAMP,
     created_at TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
];

// ============================================================================
// ONE-TIME DATA FIXUP
// ============================================================================
// In Stalker middleware the JSON field named "phone" actually contains the
// subscription EXPIRATION DATE (YYYY-MM-DD), not a real telephone number.
// A previous bug caused that value to be stored in BOTH expire_date AND
// phone_number. This migration repairs existing rows:
//
//   1. Ensure any new columns exist.
//   2. If expire_date is empty/null but phone_number looks like a date
//      (YYYY-MM-DD), copy it into expire_date.
//   3. Clear phone_number whenever it holds a date-shaped value (since it
//      never was a phone number to begin with).
//
// We guard with a sentinel key on globalThis so the fix runs at most once
// per process lifetime.
// ============================================================================
async function runMigrations(): Promise<void> {
  if (globalForDb.__arenaMigrationRun) return;
  globalForDb.__arenaMigrationRun = true;

  try {
    // 0. Ensure new columns and tables exist (safe to run every boot).
    for (const stmt of [...JOB_ALTERS, ...RESULT_ALTERS]) {
      try {
        await pool.query(stmt);
      } catch {
        // Table may not exist on first boot.
      }
    }
    for (const stmt of TABLE_DDL) {
      try {
        await pool.query(stmt);
      } catch (err) {
        console.warn(
          `[db] Could not create an auxiliary table: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Match zero-date / empty placeholders such as "0000-00-00 00:00:00" or "0".
    const placeholderPattern =
      "^(0|-1|null|undefined|none|n/a|na|-+|false|0{2,4}[-./]0{1,2}[-./]0{1,4}([T\\s]+0{1,2}:0{1,2}(:0{1,2}(\\.\\d+)?)?(\\s*(Z|[+-]\\d{2}:?\\d{2}))?)?)$";

    // 1. Repair expire_date from Stalker's `phone` field in raw_data (or
    //    legacy phone_number / other non-placeholder expiry fields) whenever
    //    expire_date is empty, a zero-date placeholder ("0000-00-00 00:00:00"),
    //    or out of sync with the portal's `phone` expiry field.
    const backfillResult = await pool.query(
      `WITH extracted AS (
         SELECT
           id,
           COALESCE(
             CASE WHEN BTRIM(raw_data->'account'->>'phone') <> '' AND BTRIM(raw_data->'account'->>'phone') !~* $1 THEN BTRIM(raw_data->'account'->>'phone') END,
             CASE WHEN BTRIM(raw_data->'portalResponses'->'accountInfo'->'response'->'body'->'js'->>'phone') <> '' AND BTRIM(raw_data->'portalResponses'->'accountInfo'->'response'->'body'->'js'->>'phone') !~* $1 THEN BTRIM(raw_data->'portalResponses'->'accountInfo'->'response'->'body'->'js'->>'phone') END,
             CASE WHEN BTRIM(raw_data->'profile'->>'phone') <> '' AND BTRIM(raw_data->'profile'->>'phone') !~* $1 THEN BTRIM(raw_data->'profile'->>'phone') END,
             CASE WHEN BTRIM(raw_data->'portalResponses'->'profile'->'response'->'body'->'js'->>'phone') <> '' AND BTRIM(raw_data->'portalResponses'->'profile'->'response'->'body'->'js'->>'phone') !~* $1 THEN BTRIM(raw_data->'portalResponses'->'profile'->'response'->'body'->'js'->>'phone') END
           ) AS phone_expiry,
           COALESCE(
             CASE WHEN BTRIM(phone_number) <> '' AND BTRIM(phone_number) !~* $1 THEN BTRIM(phone_number) END,
             CASE WHEN BTRIM(raw_data->'account'->>'end_date') <> '' AND BTRIM(raw_data->'account'->>'end_date') !~* $1 THEN BTRIM(raw_data->'account'->>'end_date') END,
             CASE WHEN BTRIM(raw_data->'account'->>'expire_billing_date') <> '' AND BTRIM(raw_data->'account'->>'expire_billing_date') !~* $1 THEN BTRIM(raw_data->'account'->>'expire_billing_date') END,
             CASE WHEN BTRIM(raw_data->'account'->>'expire') <> '' AND BTRIM(raw_data->'account'->>'expire') !~* $1 THEN BTRIM(raw_data->'account'->>'expire') END,
             CASE WHEN BTRIM(raw_data->'account'->>'expiry') <> '' AND BTRIM(raw_data->'account'->>'expiry') !~* $1 THEN BTRIM(raw_data->'account'->>'expiry') END,
             CASE WHEN BTRIM(raw_data->'profile'->>'end_date') <> '' AND BTRIM(raw_data->'profile'->>'end_date') !~* $1 THEN BTRIM(raw_data->'profile'->>'end_date') END,
             CASE WHEN BTRIM(raw_data->'profile'->>'expire_billing_date') <> '' AND BTRIM(raw_data->'profile'->>'expire_billing_date') !~* $1 THEN BTRIM(raw_data->'profile'->>'expire_billing_date') END,
             CASE WHEN BTRIM(raw_data->'profile'->>'expire') <> '' AND BTRIM(raw_data->'profile'->>'expire') !~* $1 THEN BTRIM(raw_data->'profile'->>'expire') END,
             CASE WHEN BTRIM(raw_data->'profile'->>'expiry') <> '' AND BTRIM(raw_data->'profile'->>'expiry') !~* $1 THEN BTRIM(raw_data->'profile'->>'expiry') END
           ) AS fallback_expiry
         FROM scan_results
       ),
       target AS (
         SELECT
           sr.id,
           CASE
             WHEN ex.phone_expiry IS NOT NULL THEN ex.phone_expiry
             WHEN (sr.expire_date IS NULL OR BTRIM(sr.expire_date) = '' OR BTRIM(sr.expire_date) ~* $1) AND ex.fallback_expiry IS NOT NULL THEN ex.fallback_expiry
             WHEN sr.expire_date IS NOT NULL AND BTRIM(sr.expire_date) ~* $1 THEN ''
             ELSE sr.expire_date
           END AS next_expire_date
         FROM scan_results sr
         JOIN extracted ex ON ex.id = sr.id
       )
       UPDATE scan_results sr
          SET expire_date = target.next_expire_date
         FROM target
        WHERE sr.id = target.id
          AND sr.expire_date IS DISTINCT FROM target.next_expire_date`,
      [placeholderPattern]
    );

    // 2. Clear phone_number whenever it duplicates expire_date or holds a date/placeholder.
    const dateLikePattern =
      "^(\\d{4}[-./]\\d{1,2}[-./]\\d{1,2}|\\d{1,2}[-./]\\d{1,2}[-./]\\d{4}|[A-Za-z]+\\s+\\d{1,2},\\s*\\d{4}|\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4})";
    const clearResult = await pool.query(
      `UPDATE scan_results
          SET phone_number = NULL
        WHERE phone_number IS NOT NULL
          AND phone_number <> ''
          AND (
            BTRIM(phone_number) = COALESCE(BTRIM(expire_date), '')
            OR BTRIM(phone_number) ~* $1
            OR BTRIM(phone_number) ~* $2
          )`,
      [placeholderPattern, dateLikePattern]
    );

    const fixed = (backfillResult.rowCount ?? 0) + (clearResult.rowCount ?? 0);
    if (fixed > 0) {
      console.log(
        `[db] Fixed ${backfillResult.rowCount ?? 0} expire_date values and ` +
          `cleared ${clearResult.rowCount ?? 0} date-shaped phone_number rows ` +
          `(Stalker 'phone' field stores expiry date, not phone number).`
      );
    }
  } catch (err) {
    // The table may not exist yet on first boot — that's fine, just skip.
    console.warn(
      `[db] Migration skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export function ensureMigrations(): Promise<void> {
  if (!globalForDb.__arenaMigrationPromise) {
    globalForDb.__arenaMigrationPromise = runMigrations();
  }
  return globalForDb.__arenaMigrationPromise;
}

// Kick off the migration without blocking exports.
void ensureMigrations();
