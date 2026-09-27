import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs, scanResults, scanLogs } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const jobId = request.nextUrl.searchParams.get("jobId");

    if (!jobId) {
      return NextResponse.json(
        { error: "Job ID is required" },
        { status: 400 }
      );
    }

    const [job] = await db
      .select()
      .from(scanJobs)
      .where(eq(scanJobs.id, parseInt(jobId)))
      .limit(1);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const results = await db
      .select()
      .from(scanResults)
      .where(eq(scanResults.jobId, parseInt(jobId)))
      .orderBy(desc(scanResults.foundAt));

    const logs = await db
      .select()
      .from(scanLogs)
      .where(eq(scanLogs.jobId, parseInt(jobId)))
      .orderBy(desc(scanLogs.createdAt))
      .limit(100);

    return NextResponse.json({
      job,
      results,
      logs: logs.reverse(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get status",
      },
      { status: 500 }
    );
  }
}
