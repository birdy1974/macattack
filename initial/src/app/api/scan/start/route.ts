import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs } from "@/db/schema";
import { startScan } from "@/lib/scanner";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      portalUrl?: string;
      macPrefix?: string;
      timeoutMs?: number;
      outputFilename?: string;
      selectedFields?: string[];
      haUrl?: string;
      haToken?: string;
      haEntityId?: string;
      skipVerification?: boolean;
      blockSize?: number;
    };

    const {
      portalUrl,
      macPrefix = "00:1A:79",
      timeoutMs = 5000,
      outputFilename = "mac_results",
      selectedFields = [
        "macAddress",
        "portalUrl",
        "expireDate",
        "serverLocation",
        "tariffPlan",
        "accountStatus",
      ],
      haUrl = "",
      haToken = "",
      haEntityId = "",
      skipVerification = false,
      blockSize = 8000,
    } = body;

    if (!portalUrl) {
      return NextResponse.json(
        { error: "Portal URL is required" },
        { status: 400 }
      );
    }

    // Clamp blockSize to a reasonable range
    const clampedBlockSize = Math.max(100, Math.min(blockSize, 500000));

    const [job] = await db
      .insert(scanJobs)
      .values({
        portalUrl,
        macPrefix,
        timeoutMs,
        outputFilename,
        selectedFields,
        haUrl: haUrl || null,
        haToken: haToken || null,
        haEntityId: haEntityId || null,
        blockSize: clampedBlockSize,
      })
      .returning();

    // Start the scan in the background (non-blocking)
    startScan(job.id, skipVerification).catch(() => {
      // error handling is done inside startScan
    });

    return NextResponse.json({ success: true, jobId: job.id });
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
