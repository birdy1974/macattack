import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs } from "@/db/schema";
import { startScan } from "@/lib/scanner";
import { parseMacList } from "@/lib/mac-list";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      portalUrl?: string;
      /** Extra portals for one job (multi-portal mode). */
      portalUrls?: string[];
      /** "prefix" (enumerate a MAC prefix) or "list" (check the supplied MAC list). */
      scanMode?: "prefix" | "list";
      macList?: string;
      macPrefix?: string;
      timeoutMs?: number;
      outputFilename?: string;
      selectedFields?: string[];
      haUrl?: string;
      haToken?: string;
      haEntityId?: string;
      skipVerification?: boolean;
      blockSize?: number;
      concurrency?: number;
      // Filters
      genreFilterEnabled?: boolean;
      genreFilterKeywords?: string;
      genreFilterMatchLive?: boolean;
      genreFilterMatchVod?: boolean;
      genreFilterMatchSeries?: boolean;
      expireFilterEnabled?: boolean;
      expireFilterMinDate?: string | null;
      expireFilterIncludeUnlimited?: boolean;
      // Stream quality / speed / stability check
      qualityCheckEnabled?: boolean;
      qualityChannels?: number;
      qualitySampleMs?: number;
      uaRotationEnabled?: boolean;
      pictureChecksEnabled?: boolean;
      thumbnailsEnabled?: boolean;
      catchUpCheckEnabled?: boolean;
    };

    const {
      portalUrl,
      portalUrls = [],
      scanMode = "prefix",
      macList = "",
      macPrefix = "00:1A:79",
      timeoutMs = 5000,
      outputFilename = "mac_results",
      selectedFields = [
        "macAddress",
        "portalUrl",
        "expireDate",
        "quality",
        "serverLocation",
        "responseTimeMs",
        "portalCheckStatus",
        "playbackStability",
        "tariffPlan",
        "maxConnections",
        "activeConnections",
        "portalOnline",
        "lastActive",
        "accountStatus",
        "timezone",
        "createdAt",
      ],
      haUrl = "",
      haToken = "",
      haEntityId = "",
      skipVerification = false,
      blockSize = 8000,
      concurrency = 1,
      genreFilterEnabled = false,
      genreFilterKeywords = "",
      genreFilterMatchLive = true,
      genreFilterMatchVod = true,
      genreFilterMatchSeries = true,
      expireFilterEnabled = false,
      expireFilterMinDate = null,
      expireFilterIncludeUnlimited = true,
      qualityCheckEnabled = true,
      qualityChannels = 3,
      qualitySampleMs = 8000,
      uaRotationEnabled = true,
      pictureChecksEnabled = true,
      thumbnailsEnabled = true,
      catchUpCheckEnabled = true,
    } = body;

    if (!portalUrl) {
      return NextResponse.json(
        { error: "Portal URL is required" },
        { status: 400 }
      );
    }

    // ── Bulk MAC list mode ─────────────────────────────────────────────
    const listMode = scanMode === "list";
    const parsedList = listMode ? parseMacList(macList) : { macs: [], foreignPortalEntries: [], invalid: [] };
    if (listMode && parsedList.macs.length === 0) {
      return NextResponse.json(
        { error: "No valid MAC addresses found in the list (expected lines like 00:1A:79:12:34:56)" },
        { status: 400 }
      );
    }

    // ── Multi-portal mode ─────────────────────────────────────────────
    // The first portal becomes the job's portal; the rest are queued and the
    // scanner rotates through them per block so one dead server cannot stall
    // a whole run (and valid MACs get a second chance on another portal).
    const extraPortals = portalUrls
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0 && value !== portalUrl)
      .slice(0, 20);

    // Clamp blockSize to a reasonable range
    const clampedBlockSize = Math.max(100, Math.min(blockSize, 500000));

    const [job] = await db
      .insert(scanJobs)
      .values({
        portalUrl,
        portalUrls: extraPortals.length > 0 ? extraPortals : null,
        scanMode: listMode ? "list" : "prefix",
        macList: listMode ? parsedList.macs : null,
        macPrefix: listMode ? "00:1A:79" : macPrefix,
        concurrency: Math.max(1, Math.min(Number(concurrency) || 1, 8)),
        timeoutMs,
        outputFilename,
        selectedFields,
        haUrl: haUrl || null,
        haToken: haToken || null,
        haEntityId: haEntityId || null,
        blockSize: clampedBlockSize,
        genreFilterEnabled: genreFilterEnabled ? 1 : 0,
        genreFilterKeywords: genreFilterKeywords || "",
        genreFilterMatchLive: genreFilterMatchLive ? 1 : 0,
        genreFilterMatchVod: genreFilterMatchVod ? 1 : 0,
        genreFilterMatchSeries: genreFilterMatchSeries ? 1 : 0,
        expireFilterEnabled: expireFilterEnabled ? 1 : 0,
        expireFilterMinDate: expireFilterMinDate || null,
        expireFilterIncludeUnlimited: expireFilterIncludeUnlimited ? 1 : 0,
        qualityCheckEnabled: qualityCheckEnabled ? 1 : 0,
        qualityChannels: Math.max(1, Math.min(Number(qualityChannels) || 3, 8)),
        qualitySampleMs: Math.max(3000, Math.min(Number(qualitySampleMs) || 8000, 30000)),
        uaRotationEnabled: uaRotationEnabled ? 1 : 0,
        pictureChecksEnabled: pictureChecksEnabled ? 1 : 0,
        thumbnailsEnabled: thumbnailsEnabled ? 1 : 0,
        catchUpCheckEnabled: catchUpCheckEnabled ? 1 : 0,
      })
      .returning();

    // Start the scan in the background (non-blocking)
    startScan(job.id, skipVerification).catch(() => {
      // error handling is done inside startScan
    });

    return NextResponse.json({
      success: true,
      jobId: job.id,
      // Feedback so the UI can show what was actually queued.
      macCount: listMode ? parsedList.macs.length : null,
      skippedEntries: listMode ? parsedList.invalid.length : 0,
      foreignPortalEntries: listMode ? parsedList.foreignPortalEntries.length : 0,
      extraPortals: extraPortals.length,
      concurrency: job.concurrency,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to start scan",
      },
      { status: 500 }
    );
  }
}
