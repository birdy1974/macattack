import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { proxies, settings } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { parseProxyList, redactProxy, validateProxies } from "@/lib/proxy";

const SETTINGS_KEY = "proxy_list";

/** Persist the pool in settings (source of truth) + sync the validation table. */
async function savePool(lines: string): Promise<void> {
  const [existing] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (existing) {
    await db.update(settings).set({ value: lines, updatedAt: new Date() }).where(eq(settings.key, SETTINGS_KEY));
  } else {
    await db.insert(settings).values({ key: SETTINGS_KEY, value: lines });
  }
}

async function loadPool(): Promise<string> {
  const [existing] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (existing?.value) return existing.value;
  const rows = await db.select().from(proxies);
  return rows.map((row) => row.value).join("\n");
}

/**
 * Proxy pool management + validation.
 *
 *   GET    /api/scan/proxies               → stored proxies + their last results
 *   POST   /api/scan/proxies { list }       → replace the pool (parses/validates syntax)
 *   PUT    /api/scan/proxies               → re-validate every enabled proxy now
 *   DELETE /api/scan/proxies?id=3          → remove one proxy
 *
 * Validation connects through each proxy to a tiny neutral endpoint and records
 * latency, so a user can tell a working egress apart from a dead one BEFORE a
 * scan depends on it. Proxies are never required: the scanner only uses the
 * first enabled working entry, and only for stream probes/quality checks.
 */

const VALIDATION_TARGET = "http://cp.cloudflare.com/generate_204";

export async function GET() {
  try {
    const rows = await db
      .select({
        id: proxies.id,
        display: proxies.display,
        enabled: proxies.enabled,
        lastOk: proxies.lastOk,
        lastLatencyMs: proxies.lastLatencyMs,
        lastError: proxies.lastError,
        lastCheckedAt: proxies.lastCheckedAt,
        createdAt: proxies.createdAt,
      })
      .from(proxies)
      .orderBy(desc(proxies.createdAt))
      .limit(200);

    return NextResponse.json({ proxies: rows, target: VALIDATION_TARGET });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load proxies" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { list?: string };
    const parsed = parseProxyList(body.list || "");
    const usable = parsed.filter((proxy): proxy is NonNullable<typeof proxy> => !!proxy);

    if (usable.length === 0) {
      return NextResponse.json({ error: "No valid proxies found (expected host:port or user:pass@host:port)" }, { status: 400 });
    }

    // Settings hold the pool the scanner actually uses; the table mirrors it so
    // validation results survive restarts.
    const lines = usable.map((proxy) => proxy.raw).join("\n");
    await savePool(lines);

    const existing = await db.select({ id: proxies.id }).from(proxies);
    for (const row of existing) {
      await db.delete(proxies).where(eq(proxies.id, row.id));
    }

    const inserted = [];
    for (const proxy of usable) {
      const [row] = await db
        .insert(proxies)
        .values({
          value: proxy.raw,
          display: redactProxy(proxy),
          enabled: 1,
        })
        .returning();
      inserted.push(row);
    }

    return NextResponse.json({
      success: true,
      added: inserted.length,
      skipped: parsed.length - usable.length,
      proxies: inserted.map((row) => ({
        id: row.id,
        display: row.display,
        enabled: row.enabled,
        lastOk: row.lastOk,
        lastLatencyMs: row.lastLatencyMs,
        lastError: row.lastError,
        lastCheckedAt: row.lastCheckedAt,
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save proxies" },
      { status: 500 }
    );
  }
}

/** Re-validate every enabled proxy (latency + pass/fail), updating rows. */
export async function PUT() {
  try {
    // Validate whatever is currently configured (settings win; the table is a
    // fallback for pools saved before the settings key existed).
    const pool = await loadPool();
    const configs = parseProxyList(pool);
    if (configs.length === 0) {
      return NextResponse.json({ success: true, checked: 0, results: [] });
    }

    const rows = await db.select().from(proxies).where(eq(proxies.enabled, 1));
    const results = await validateProxies(configs, { targetUrl: VALIDATION_TARGET, timeoutMs: 6000, concurrency: 5 });

    const response = [];
    for (let index = 0; index < results.length; index += 1) {
      const row = rows[index];
      const result = results[index];
      if (!row) {
        response.push({ id: null, display: result.proxy, ok: result.ok, latencyMs: result.latencyMs, error: result.error });
        continue;
      }
      await db
        .update(proxies)
        .set({
          lastOk: result.ok ? 1 : 0,
          lastLatencyMs: result.latencyMs,
          lastError: result.error,
          lastCheckedAt: new Date(),
        })
        .where(eq(proxies.id, row.id));
      response.push({ id: row.id, display: row.display, ok: result.ok, latencyMs: result.latencyMs, error: result.error });
    }

    return NextResponse.json({
      success: true,
      checked: response.length,
      working: response.filter((entry) => entry.ok).length,
      results: response,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proxy validation failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) {
      return NextResponse.json({ error: "Valid id is required" }, { status: 400 });
    }
    await db.delete(proxies).where(eq(proxies.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete proxy" },
      { status: 500 }
    );
  }
}
