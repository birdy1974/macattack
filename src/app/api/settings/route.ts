import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseScheduleSettings, validateScheduleSettings } from "@/lib/schedule";

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
    };

    // Save only settings included in the request so the independent settings
    // panels can be updated without overwriting each other.
    if ("haUrl" in body) await saveSetting("ha_url", body.haUrl || "");
    if ("haToken" in body) await saveSetting("ha_token", body.haToken || "");
    if ("haEntityId" in body) await saveSetting("ha_entity_id", body.haEntityId || "");

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
