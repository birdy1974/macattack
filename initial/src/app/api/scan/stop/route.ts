import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs, scanLogs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { stopScan } from "@/lib/scanner";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { jobId?: number };
    const { jobId } = body;

    if (!jobId) {
      return NextResponse.json(
        { error: "Job ID is required" },
        { status: 400 }
      );
    }

    // Stop the scan (this also resets HA entity to 0)
    const wasStopped = await stopScan(jobId);

    // Update job status in database
    await db
      .update(scanJobs)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(scanJobs.id, jobId));

    // Add log entry
    await db.insert(scanLogs).values({
      jobId,
      level: "info",
      message: "Scan stopped by user",
    });

    return NextResponse.json({ success: true, wasStopped });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to stop scan",
      },
      { status: 500 }
    );
  }
}
