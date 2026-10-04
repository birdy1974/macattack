#!/usr/bin/env node
/**
 * ============================================================================
 * MacAttack - Database Schema Initialization
 * ============================================================================
 * This script:
 * 1. Waits for the database to be ready
 * 2. Creates the required MacAttack tables if they don't exist
 *
 * Run manually:   node init-schema.js
 * Auto-run:       Executed on Docker container start via CMD
 * ============================================================================
 */

const { Pool } = require("pg");

async function waitForDatabase(maxRetries) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[init-schema] Database connection OK");
      await pool.end();
      return true;
    } catch (err) {
      console.log(
        "[init-schema] Waiting for database... (" +
          (i + 1) +
          "/" +
          maxRetries +
          ") " +
          err.message
      );
      await new Promise(function (resolve) {
        setTimeout(resolve, 2000);
      });
    }
  }

  console.log("[init-schema] ERROR: Could not connect to database");
  await pool.end();
  return false;
}

async function createSchema() {
  var pool = new Pool({ connectionString: process.env.DATABASE_URL });

  var schema =
    "CREATE TABLE IF NOT EXISTS scan_jobs (" +
    "  id SERIAL PRIMARY KEY," +
    "  portal_url TEXT NOT NULL," +
    "  mac_prefix TEXT NOT NULL DEFAULT '00:1A:79'," +
    "  status TEXT NOT NULL DEFAULT 'pending'," +
    "  timeout_ms INTEGER NOT NULL DEFAULT 5000," +
    "  output_filename TEXT NOT NULL DEFAULT 'mac_results'," +
    "  selected_fields JSONB NOT NULL," +
    "  total_tested INTEGER NOT NULL DEFAULT 0," +
    "  total_found INTEGER NOT NULL DEFAULT 0," +
    "  current_mac TEXT," +
    "  ha_url TEXT," +
    "  ha_token TEXT," +
    "  ha_entity_id TEXT," +
    "  block_size INTEGER NOT NULL DEFAULT 8000," +
    "  ping_min_ms REAL," +
    "  ping_avg_ms REAL," +
    "  ping_max_ms REAL," +
    "  ping_stdev_ms REAL," +
    "  ping_loss_pct REAL," +
    "  ping_probes INTEGER," +
    "  ping_probe_ms INTEGER," +
    "  http_dns_ms REAL," +
    "  http_tcp_ms REAL," +
    "  http_tls_ms REAL," +
    "  http_ttfb_ms REAL," +
    "  http_total_ms REAL," +
    "  http_status_code INTEGER," +
    "  ping_error TEXT," +
    "  server_ip TEXT," +
    "  server_geo_raw JSONB," +
    "  genre_filter_enabled INTEGER NOT NULL DEFAULT 0," +
    "  genre_filter_keywords TEXT NOT NULL DEFAULT ''," +
    "  genre_filter_match_live INTEGER NOT NULL DEFAULT 1," +
    "  genre_filter_match_vod INTEGER NOT NULL DEFAULT 1," +
    "  genre_filter_match_series INTEGER NOT NULL DEFAULT 1," +
    "  expire_filter_enabled INTEGER NOT NULL DEFAULT 0," +
    "  expire_filter_min_date TEXT," +
    "  expire_filter_include_unlimited INTEGER NOT NULL DEFAULT 1," +
    "  created_at TIMESTAMP DEFAULT NOW() NOT NULL," +
    "  updated_at TIMESTAMP DEFAULT NOW() NOT NULL" +
    ");" +
    "CREATE TABLE IF NOT EXISTS scan_results (" +
    "  id SERIAL PRIMARY KEY," +
    "  job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE," +
    "  mac_address TEXT NOT NULL," +
    "  portal_url TEXT NOT NULL," +
    "  expire_date TEXT," +
    "  server_location TEXT," +
    "  tariff_plan TEXT," +
    "  max_connections TEXT," +
    "  active_connections TEXT," +
    "  created_at TIMESTAMP," +
    "  account_status TEXT," +
    "  phone_number TEXT," +
    "  response_time_ms INTEGER," +
    "  timezone TEXT," +
    "  username TEXT," +
    "  password TEXT," +
    "  playlist_genres TEXT," +
    "  vod_categories TEXT," +
    "  itv_genre_count INTEGER," +
    "  vod_category_count INTEGER," +
    "  series_category_count INTEGER," +
    "  raw_data JSONB," +
    "  found_at TIMESTAMP DEFAULT NOW() NOT NULL" +
    ");" +
    "CREATE TABLE IF NOT EXISTS scan_logs (" +
    "  id SERIAL PRIMARY KEY," +
    "  job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE," +
    "  level TEXT NOT NULL DEFAULT 'info'," +
    "  message TEXT NOT NULL," +
    "  created_at TIMESTAMP DEFAULT NOW() NOT NULL" +
    ");" +
    "CREATE TABLE IF NOT EXISTS settings (" +
    "  id SERIAL PRIMARY KEY," +
    "  key TEXT NOT NULL UNIQUE," +
    "  value TEXT," +
    "  updated_at TIMESTAMP DEFAULT NOW() NOT NULL" +
    ");";

  try {
    await pool.query(schema);
    console.log("[init-schema] All MacAttack tables created/verified");

    // Idempotently add any newly-introduced columns so upgrades from older
    // versions of MacAttack don't fail.
    var jobAlters = [
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
    var resultAlters = [
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
      "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS itv_genre_count INTEGER",
      "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS vod_category_count INTEGER",
      "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS series_category_count INTEGER",
    ];
    var tableDdl = [
      "CREATE TABLE IF NOT EXISTS quality_probe_runs (" +
        " id SERIAL PRIMARY KEY," +
        " result_id INTEGER NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE," +
        " job_id INTEGER, mac_address TEXT NOT NULL," +
        " measured_at TIMESTAMP NOT NULL DEFAULT NOW()," +
        " overall_score REAL, speed_score REAL, quality_score REAL, stability_score REAL," +
        " verdict TEXT, throughput_mbps REAL, required_mbps REAL," +
        " channels_playable INTEGER, channels_probed INTEGER," +
        " frozen INTEGER DEFAULT 0, label_mismatches INTEGER DEFAULT 0," +
        " via_proxy TEXT, source TEXT NOT NULL DEFAULT 'scan'," +
        " created_at TIMESTAMP NOT NULL DEFAULT NOW())",
      "CREATE INDEX IF NOT EXISTS quality_probe_runs_result_idx ON quality_probe_runs (result_id, measured_at)",
      "CREATE TABLE IF NOT EXISTS playlist_tokens (" +
        " id SERIAL PRIMARY KEY," +
        " result_id INTEGER NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE," +
        " token TEXT NOT NULL UNIQUE, limit_count INTEGER NOT NULL DEFAULT 200," +
        " revoked INTEGER NOT NULL DEFAULT 0, fetch_count INTEGER NOT NULL DEFAULT 0," +
        " last_fetched_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT NOW())",
      "CREATE TABLE IF NOT EXISTS monitors (" +
        " id SERIAL PRIMARY KEY," +
        " result_id INTEGER NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE," +
        " enabled INTEGER NOT NULL DEFAULT 1, interval_minutes INTEGER NOT NULL DEFAULT 360," +
        " alert_on TEXT NOT NULL DEFAULT 'degrading,poor,unusable'," +
        " channels INTEGER NOT NULL DEFAULT 3, sample_ms INTEGER NOT NULL DEFAULT 8000," +
        " last_run_at TIMESTAMP, last_verdict TEXT, last_score REAL, last_trend TEXT," +
        " last_alert_at TIMESTAMP, last_alert_reason TEXT," +
        " created_at TIMESTAMP NOT NULL DEFAULT NOW())",
      "CREATE TABLE IF NOT EXISTS proxies (" +
        " id SERIAL PRIMARY KEY, value TEXT NOT NULL, display TEXT NOT NULL," +
        " enabled INTEGER NOT NULL DEFAULT 1, last_ok INTEGER, last_latency_ms INTEGER," +
        " last_error TEXT, last_checked_at TIMESTAMP," +
        " created_at TIMESTAMP NOT NULL DEFAULT NOW())",
    ];
    for (var i = 0; i < jobAlters.length; i++) {
      try { await pool.query(jobAlters[i]); } catch (e) { /* ignore */ }
    }
    for (var j = 0; j < resultAlters.length; j++) {
      try { await pool.query(resultAlters[j]); } catch (e) { /* ignore */ }
    }
    for (var k = 0; k < tableDdl.length; k++) {
      try { await pool.query(tableDdl[k]); } catch (e) { /* ignore */ }
    }

    // Repair expire_date from Stalker's `phone` field in raw_data (or legacy
    // phone_number / non-placeholder expiry fields) when expire_date is empty,
    // a zero-date placeholder ("0000-00-00 00:00:00"), or out of sync with the
    // portal's `phone` expiry field.
    var placeholderPattern =
      "^(0|-1|null|undefined|none|n/a|na|-+|false|0{2,4}[-./]0{1,2}[-./]0{1,4}([T\\s]+0{1,2}:0{1,2}(:0{1,2}(\\.\\d+)?)?(\\s*(Z|[+-]\\d{2}:?\\d{2}))?)?)$";
    var dateLikePattern =
      "^(\\d{4}[-./]\\d{1,2}[-./]\\d{1,2}|\\d{1,2}[-./]\\d{1,2}[-./]\\d{4}|[A-Za-z]+\\s+\\d{1,2},\\s*\\d{4}|\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4})";
    try {
      await pool.query(
        "WITH extracted AS (" +
          " SELECT id," +
          " COALESCE(" +
          "   CASE WHEN BTRIM(raw_data->'account'->>'phone') <> '' AND BTRIM(raw_data->'account'->>'phone') !~* $1 THEN BTRIM(raw_data->'account'->>'phone') END," +
          "   CASE WHEN BTRIM(raw_data->'portalResponses'->'accountInfo'->'response'->'body'->'js'->>'phone') <> '' AND BTRIM(raw_data->'portalResponses'->'accountInfo'->'response'->'body'->'js'->>'phone') !~* $1 THEN BTRIM(raw_data->'portalResponses'->'accountInfo'->'response'->'body'->'js'->>'phone') END," +
          "   CASE WHEN BTRIM(raw_data->'profile'->>'phone') <> '' AND BTRIM(raw_data->'profile'->>'phone') !~* $1 THEN BTRIM(raw_data->'profile'->>'phone') END," +
          "   CASE WHEN BTRIM(raw_data->'portalResponses'->'profile'->'response'->'body'->'js'->>'phone') <> '' AND BTRIM(raw_data->'portalResponses'->'profile'->'response'->'body'->'js'->>'phone') !~* $1 THEN BTRIM(raw_data->'portalResponses'->'profile'->'response'->'body'->'js'->>'phone') END" +
          " ) AS phone_expiry," +
          " COALESCE(" +
          "   CASE WHEN BTRIM(phone_number) <> '' AND BTRIM(phone_number) !~* $1 THEN BTRIM(phone_number) END," +
          "   CASE WHEN BTRIM(raw_data->'account'->>'end_date') <> '' AND BTRIM(raw_data->'account'->>'end_date') !~* $1 THEN BTRIM(raw_data->'account'->>'end_date') END," +
          "   CASE WHEN BTRIM(raw_data->'account'->>'expire_billing_date') <> '' AND BTRIM(raw_data->'account'->>'expire_billing_date') !~* $1 THEN BTRIM(raw_data->'account'->>'expire_billing_date') END," +
          "   CASE WHEN BTRIM(raw_data->'account'->>'expire') <> '' AND BTRIM(raw_data->'account'->>'expire') !~* $1 THEN BTRIM(raw_data->'account'->>'expire') END," +
          "   CASE WHEN BTRIM(raw_data->'account'->>'expiry') <> '' AND BTRIM(raw_data->'account'->>'expiry') !~* $1 THEN BTRIM(raw_data->'account'->>'expiry') END," +
          "   CASE WHEN BTRIM(raw_data->'profile'->>'end_date') <> '' AND BTRIM(raw_data->'profile'->>'end_date') !~* $1 THEN BTRIM(raw_data->'profile'->>'end_date') END," +
          "   CASE WHEN BTRIM(raw_data->'profile'->>'expire_billing_date') <> '' AND BTRIM(raw_data->'profile'->>'expire_billing_date') !~* $1 THEN BTRIM(raw_data->'profile'->>'expire_billing_date') END," +
          "   CASE WHEN BTRIM(raw_data->'profile'->>'expire') <> '' AND BTRIM(raw_data->'profile'->>'expire') !~* $1 THEN BTRIM(raw_data->'profile'->>'expire') END," +
          "   CASE WHEN BTRIM(raw_data->'profile'->>'expiry') <> '' AND BTRIM(raw_data->'profile'->>'expiry') !~* $1 THEN BTRIM(raw_data->'profile'->>'expiry') END" +
          " ) AS fallback_expiry" +
          " FROM scan_results" +
          "), target AS (" +
          " SELECT sr.id," +
          " CASE" +
          "   WHEN ex.phone_expiry IS NOT NULL THEN ex.phone_expiry" +
          "   WHEN (sr.expire_date IS NULL OR BTRIM(sr.expire_date) = '' OR BTRIM(sr.expire_date) ~* $1) AND ex.fallback_expiry IS NOT NULL THEN ex.fallback_expiry" +
          "   WHEN sr.expire_date IS NOT NULL AND BTRIM(sr.expire_date) ~* $1 THEN ''" +
          "   ELSE sr.expire_date" +
          " END AS next_expire_date" +
          " FROM scan_results sr JOIN extracted ex ON ex.id = sr.id" +
          ") UPDATE scan_results sr SET expire_date = target.next_expire_date" +
          " FROM target WHERE sr.id = target.id AND sr.expire_date IS DISTINCT FROM target.next_expire_date",
        [placeholderPattern]
      );
      await pool.query(
        "UPDATE scan_results SET phone_number = NULL" +
          " WHERE phone_number IS NOT NULL AND phone_number <> ''" +
          " AND (BTRIM(phone_number) = COALESCE(BTRIM(expire_date), '') OR BTRIM(phone_number) ~* $1 OR BTRIM(phone_number) ~* $2)",
        [placeholderPattern, dateLikePattern]
      );
    } catch (e) {
      /* ignore */
    }
  } catch (err) {
    console.log("[init-schema] Schema note: " + err.message);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log("========================================");
  console.log(" MacAttack - Database Initialization");
  console.log("========================================");

  var dbReady = await waitForDatabase(30);

  if (dbReady) {
    await createSchema();
    console.log("[init-schema] Done");
  } else {
    console.log("[init-schema] WARNING: Starting without schema - tables may be missing");
  }
}

main().catch(function (err) {
  console.error("[init-schema] Fatal: " + err.message);
});
