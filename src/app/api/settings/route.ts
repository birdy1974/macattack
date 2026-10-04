import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseScheduleSettings, validateScheduleSettings } from "@/lib/schedule";
import { parseProxyList } from "@/lib/proxy";
import {
  OUTPUT_FIELD_ORDER_SETTING_KEY,
  parseOutputFieldOrderSetting,
  sanitizeOutputFieldOrder,
  serializeOutputFieldOrder,
} from "@/lib/field-order";

async function saveSetting(key: string, value: string) {
  const [existing] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
}

export async function GET() {
  try {
    const allSettings = await db.select().from(settings);
    const settingsMap: Record<string, string> = {};
    for (const setting of allSettings) {
      settingsMap[setting.key] = setting.value || "";
    }

    const schedule = parseScheduleSettings(
      settingsMap.schedule_enabled,
      settingsMap.schedule_timezone,
      settingsMap.schedule_days
    );

    return NextResponse.json({
      haUrl: settingsMap.ha_url || "",
      haToken: settingsMap.ha_token || "",
      haEntityId: settingsMap.ha_entity_id || "",
      scheduleEnabled: schedule.enabled,
      scheduleTimezone: settingsMap.schedule_timezone || "",
      scheduleDays: schedule.days,
      // Remembered Output Fields order (empty = never customised).
      outputFieldOrder: parseOutputFieldOrderSetting(
        settingsMap[OUTPUT_FIELD_ORDER_SETTING_KEY]
      ),
      // Optional add-ons (blank = built-in defaults)
      uaList: settingsMap.ua_list || "",
      proxyList: settingsMap.proxy_list || "",
      // Per-portal remembered user agents (ua_winner:<host>), for the UI panel.
      userAgentWinners: Object.fromEntries(
        Object.entries(settingsMap)
          .filter(([key]) => key.startsWith("ua_winner:"))
          .map(([key, value]) => [key.replace("ua_winner:", ""), value])
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get settings",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      haUrl?: string;
      haToken?: string;
      haEntityId?: string;
      scheduleEnabled?: boolean;
      scheduleTimezone?: string;
      scheduleDays?: unknown;
      uaList?: string;
      proxyList?: string;
      /** Full Output Fields order (all keys, selected or not). */
      outputFieldOrder?: unknown;
    };

    // Save only settings included in the request so the independent settings
    // panels can be updated without overwriting each other.
    if ("haUrl" in body) await saveSetting("ha_url", body.haUrl || "");
    if ("uaList" in body) {
      // One user agent per line; reject lines with control characters.
      const cleaned = String(body.uaList || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.length <= 200 && !/[\x00-\x1f]/.test(line))
        .slice(0, 20)
        .join("\n");
      await saveSetting("ua_list", cleaned);
    }
    if ("proxyList" in body) {
      const parsedProxies = parseProxyList(String(body.proxyList || ""));
      // Store the raw lines so credentials survive a re-save, but never expose
      // them back to the browser unmasked (see GET).
      await saveSetting(
        "proxy_list",
        String(body.proxyList || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 50)
          .join("\n")
      );
      if (String(body.proxyList || "").trim() && parsedProxies.length === 0) {
        return NextResponse.json(
          { error: "No valid proxies found (expected host:port or user:pass@host:port)" },
          { status: 400 }
        );
      }
    }
    if ("haToken" in body) await saveSetting("ha_token", body.haToken || "");
    if ("haEntityId" in body) await saveSetting("ha_entity_id", body.haEntityId || "");

    // Output Fields order: stored so it survives reloads and seeds the column
    // order (results table and CSV/TXT export) of the next scan.
    if ("outputFieldOrder" in body) {
      await saveSetting(
        OUTPUT_FIELD_ORDER_SETTING_KEY,
        serializeOutputFieldOrder(sanitizeOutputFieldOrder(body.outputFieldOrder))
      );
    }

    if (
      "scheduleEnabled" in body ||
      "scheduleTimezone" in body ||
      "scheduleDays" in body
    ) {
      const existing = await db.select().from(settings);
      const settingsMap = Object.fromEntries(existing.map((row) => [row.key, row.value || ""]));
      const current = parseScheduleSettings(
        settingsMap.schedule_enabled,
        settingsMap.schedule_timezone,
        settingsMap.schedule_days
      );
      const validated = validateScheduleSettings({
        enabled: body.scheduleEnabled ?? current.enabled,
        timezone: body.scheduleTimezone ?? current.timezone,
        days: body.scheduleDays ?? current.days,
      });

      if (!validated.settings) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }

      await Promise.all([
        saveSetting("schedule_enabled", String(validated.settings.enabled)),
        saveSetting("schedule_timezone", validated.settings.timezone),
        saveSetting("schedule_days", JSON.stringify(validated.settings.days)),
      ]);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to save settings",
      },
      { status: 500 }
    );
  }
}
