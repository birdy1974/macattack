import { NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs } from "@/db/schema";
import { inArray, desc } from "drizzle-orm";

// Get the currently active/running scan job
export async function GET() {
  try {
    // A scan waiting for its next allowed schedule window is still active.
    const [runningJob] = await db
      .select()
      .from(scanJobs)
      .where(inArray(scanJobs.status, ["running", "scheduled_paused"]))
      .orderBy(desc(scanJobs.updatedAt))
      .limit(1);

    if (runningJob) {
      return NextResponse.json({ active: true, job: runningJob });
    }

    // If no running job, get the most recent job
    const [recentJob] = await db
      .select()
      .from(scanJobs)
      .orderBy(desc(scanJobs.updatedAt))
      .limit(1);

    return NextResponse.json({ 
      active: false, 
      job: recentJob || null 
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get active scan",
      },
      { status: 500 }
    );
  }
}
