import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scanResults } from "@/db/schema";

export async function GET(request: NextRequest) {
  const jobId = Number(request.nextUrl.searchParams.get("jobId"));
  const resultId = Number(request.nextUrl.searchParams.get("resultId"));

  if (!Number.isSafeInteger(jobId) || jobId < 1 || !Number.isSafeInteger(resultId) || resultId < 1) {
    return NextResponse.json(
      { error: "Valid jobId and resultId are required" },
      { status: 400 }
    );
  }

  try {
    const [result] = await db
      .select({
        id: scanResults.id,
        jobId: scanResults.jobId,
        macAddress: scanResults.macAddress,
        rawData: scanResults.rawData,
      })
      .from(scanResults)
      .where(and(eq(scanResults.id, resultId), eq(scanResults.jobId, jobId)))
      .limit(1);

    if (!result) {
      return NextResponse.json({ error: "Result not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: result.id,
      jobId: result.jobId,
      macAddress: result.macAddress,
      rawData: result.rawData,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to retrieve result data",
      },
      { status: 500 }
    );
  }
}
