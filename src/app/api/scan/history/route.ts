import { NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const jobs = await db
      .select()
      .from(scanJobs)
      .orderBy(desc(scanJobs.createdAt))
      .limit(20);

    return NextResponse.json({ jobs });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch history",
      },
      { status: 500 }
    );
  }
}
