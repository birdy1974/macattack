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
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_keywords TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_match_live INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_match_vod INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS genre_filter_match_series INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS expire_filter_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS expire_filter_min_date TEXT",
      "ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS expire_filter_include_unlimited INTEGER NOT NULL DEFAULT 1",
    ];
    var resultAlters = [
      "ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS response_time_ms INTEGER",
    ];
    for (var i = 0; i < jobAlters.length; i++) {
      try { await pool.query(jobAlters[i]); } catch (e) { /* ignore */ }
    }
    for (var j = 0; j < resultAlters.length; j++) {
      try { await pool.query(resultAlters[j]); } catch (e) { /* ignore */ }
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
