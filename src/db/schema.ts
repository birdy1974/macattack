import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  real,
} from "drizzle-orm/pg-core";

export const scanJobs = pgTable("scan_jobs", {
  id: serial("id").primaryKey(),
  portalUrl: text("portal_url").notNull(),
  macPrefix: text("mac_prefix").notNull().default("00:1A:79"),
  status: text("status").notNull().default("pending"), // pending, running, paused, completed, error
  timeoutMs: integer("timeout_ms").notNull().default(5000),
  outputFilename: text("output_filename").notNull().default("mac_results"),
  selectedFields: jsonb("selected_fields").$type<string[]>().notNull(),
  totalTested: integer("total_tested").notNull().default(0),
  totalFound: integer("total_found").notNull().default(0),
  currentMac: text("current_mac"),
  // Home Assistant integration
  haUrl: text("ha_url"),
  haToken: text("ha_token"),
  haEntityId: text("ha_entity_id"),
  blockSize: integer("block_size").notNull().default(8000),

  // ── Portal connectivity diagnostics (one short sample per job) ──
  // TCP connect timing to the portal host:port (not ICMP packet loss)
  pingMinMs: real("ping_min_ms"),
  pingAvgMs: real("ping_avg_ms"),
  pingMaxMs: real("ping_max_ms"),
  pingStdevMs: real("ping_stdev_ms"),
  // Legacy property/SQL name; this stores failed TCP connection attempts, not packet loss.
  pingLossPct: real("ping_loss_pct"),
  pingProbes: integer("ping_probes"),
  pingSuccessful: integer("ping_successful"),
  pingProbeMs: integer("ping_probe_ms"), // delay between probes in ms
  pingP50Ms: real("ping_p50_ms"),
  pingP95Ms: real("ping_p95_ms"),
  pingWindowMs: integer("ping_window_ms"), // actual wall-clock probe window
  pingRtts: jsonb("ping_rtts").$type<Array<number | null>>(), // per-probe connect times; null = failed
  diagnosticsAt: timestamp("diagnostics_at"),
  // Instrumented HTTP waterfall to the handshake endpoint (ms)
  httpDnsMs: real("http_dns_ms"),
  httpTcpMs: real("http_tcp_ms"),
  httpTlsMs: real("http_tls_ms"),
  httpTtfbMs: real("http_ttfb_ms"),
  httpTotalMs: real("http_total_ms"),
  httpStatusCode: integer("http_status_code"),
  httpError: text("http_error"), // non-fatal HTTP timing error
  pingError: text("ping_error"), // non-fatal TCP probe error message

  // Server geolocation (resolved once at start-up)
  serverIp: text("server_ip"),
  serverGeoRaw: jsonb("server_geo_raw"),

  // ── Stream quality check (runs for every MAC that passes the filters) ──
  qualityCheckEnabled: integer("quality_check_enabled").notNull().default(1),
  qualityChannels: integer("quality_channels").notNull().default(3),
  qualitySampleMs: integer("quality_sample_ms").notNull().default(8000),

  // ── Filters (applied at scan time; stored so history/UI can replay them) ──
  genreFilterEnabled: integer("genre_filter_enabled").notNull().default(0), // 0/1 boolean
  genreFilterKeywords: text("genre_filter_keywords").notNull().default(""),
  genreFilterMatchLive: integer("genre_filter_match_live").notNull().default(1),
  genreFilterMatchVod: integer("genre_filter_match_vod").notNull().default(1),
  genreFilterMatchSeries: integer("genre_filter_match_series").notNull().default(1),
  expireFilterEnabled: integer("expire_filter_enabled").notNull().default(0),
  expireFilterMinDate: text("expire_filter_min_date"), // YYYY-MM-DD, null = no filter
  expireFilterIncludeUnlimited: integer("expire_filter_include_unlimited").notNull().default(1),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const scanResults = pgTable("scan_results", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .references(() => scanJobs.id, { onDelete: "cascade" })
    .notNull(),
  macAddress: text("mac_address").notNull(),
  portalUrl: text("portal_url").notNull(),
  expireDate: text("expire_date"),
  serverLocation: text("server_location"),
  tariffPlan: text("tariff_plan"),
  maxConnections: text("max_connections"),
  activeConnections: text("active_connections"),
  createdAt: timestamp("created_at"),
  accountStatus: text("account_status"),
  phoneNumber: text("phone_number"),
  // Network performance for this specific MAC's account_info call (ms)
  responseTimeMs: integer("response_time_ms"),
  handshakeTimeMs: integer("handshake_time_ms"),
  accountInfoTimeMs: integer("account_info_time_ms"),
  // New fields
  timezone: text("timezone"),
  // Device/account activity fields when a portal includes them in a requested
  // profile or account_info response (null when not exposed by that portal).
  portalOnline: text("portal_online"),
  lastActive: text("last_active"),
  username: text("username"),
  password: text("password"),
  playlistGenres: text("playlist_genres"),
  vodCategories: text("vod_categories"),

  // ── Measured stream quality for this MAC (see src/lib/mac-quality.ts) ──
  // Populated right after the MAC is validated and passes the user's filters.
  stalkerServerPath: text("stalker_server_path"),
  qualityVerdict: text("quality_verdict"), // excellent | good | fair | poor | unusable | unknown
  qualityScore: real("quality_score"), // 0-10 aggregate
  qualitySpeedScore: real("quality_speed_score"),
  qualityQualityScore: real("quality_quality_score"),
  qualityStabilityScore: real("quality_stability_score"),
  qualityResolution: text("quality_resolution"), // e.g. "1080p"
  qualityCodec: text("quality_codec"), // e.g. "H.264"
  qualityThroughputMbps: real("quality_throughput_mbps"),
  qualityRequiredMbps: real("quality_required_mbps"),
  qualityChannelsPlayable: integer("quality_channels_playable"),
  qualityChannelsProbed: integer("quality_channels_probed"),
  qualityCheckedAt: timestamp("quality_checked_at"),
  qualityReport: jsonb("quality_report").$type<unknown>(),

  rawData: jsonb("raw_data"),
  foundAt: timestamp("found_at").defaultNow().notNull(),
});

export const scanLogs = pgTable("scan_logs", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .references(() => scanJobs.id, { onDelete: "cascade" })
    .notNull(),
  level: text("level").notNull().default("info"), // info, warning, error, success
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Home Assistant settings (global)
export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
