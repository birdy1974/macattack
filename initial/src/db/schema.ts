import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
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
  // New fields
  timezone: text("timezone"),
  username: text("username"),
  password: text("password"),
  playlistGenres: text("playlist_genres"),
  vodCategories: text("vod_categories"),
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
