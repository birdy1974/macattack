import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaMigrationRun?: boolean;
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
// upgrades from older MacAttack installs don't break.
const JOB_ALTERS = [
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_min_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_avg_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_max_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_stdev_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_loss_pct REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_probes INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS ping_probe_ms INTEGER",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_dns_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_tcp_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_tls_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_ttfb_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_total_ms REAL",
  "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS http_status_code INTEGER",
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
];
const RESULT_ALTERS = [
  "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS response_time_ms INTEGER",
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
    // 0. Ensure new columns exist (safe to run every boot).
    for (const stmt of [...JOB_ALTERS, ...RESULT_ALTERS]) {
      try {
        await pool.query(stmt);
      } catch {
        // Table may not exist on first boot.
      }
    }

    // Match Stalker-style dates: YYYY-MM-DD (optionally with HH:MM:SS).
    const dateLikePattern = "^\\d{4}-\\d{2}-\\d{2}(\\s\\d{2}:\\d{2}(:\\d{2})?)?$";

    // 1. Back-fill expire_date from phone_number when expire_date is empty.
    const backfillResult = await pool.query(
      `UPDATE scan_results
         SET expire_date = phone_number
       WHERE (expire_date IS NULL OR expire_date = '')
         AND phone_number IS NOT NULL
         AND phone_number ~ $1`,
      [dateLikePattern]
    );

    // 2. Clear phone_number whenever it holds a date (it was never a phone).
    const clearResult = await pool.query(
      `UPDATE scan_results
         SET phone_number = NULL
       WHERE phone_number ~ $1`,
      [dateLikePattern]
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

// Kick off the migration without blocking exports.
void runMigrations();
