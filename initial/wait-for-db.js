#!/usr/bin/env node
/**
 * Simple database connectivity check
 * Exit code 0 = database is ready
 * Exit code 1 = database not ready
 */

const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query("SELECT 1")
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch(() => {
    pool.end();
    process.exit(1);
  });
