import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const allSettings = await db.select().from(settings);
    
    const settingsMap: Record<string, string> = {};
    for (const s of allSettings) {
      settingsMap[s.key] = s.value || "";
    }

    return NextResponse.json({
      haUrl: settingsMap.ha_url || "",
      haToken: settingsMap.ha_token || "",
      haEntityId: settingsMap.ha_entity_id || "",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get settings",
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
    };

    const { haUrl = "", haToken = "", haEntityId = "" } = body;

    // Upsert settings
    const settingsToSave = [
      { key: "ha_url", value: haUrl },
      { key: "ha_token", value: haToken },
      { key: "ha_entity_id", value: haEntityId },
    ];

    for (const setting of settingsToSave) {
      const existing = await db
        .select()
        .from(settings)
        .where(eq(settings.key, setting.key))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(settings)
          .set({ value: setting.value, updatedAt: new Date() })
          .where(eq(settings.key, setting.key));
      } else {
        await db.insert(settings).values(setting);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save settings",
      },
      { status: 500 }
    );
  }
}
