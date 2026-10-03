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

    // The complete raw portal response can be sizeable. Keep frequent status
    // polling lean; the UI loads rawData on demand from /api/scan/result-data,
    // while the full JSON export reads it directly from the database.
    const results = await db
      .select({
        id: scanResults.id,
        jobId: scanResults.jobId,
        macAddress: scanResults.macAddress,
        portalUrl: scanResults.portalUrl,
        expireDate: scanResults.expireDate,
        serverLocation: scanResults.serverLocation,
        tariffPlan: scanResults.tariffPlan,
        maxConnections: scanResults.maxConnections,
        activeConnections: scanResults.activeConnections,
        createdAt: scanResults.createdAt,
        accountStatus: scanResults.accountStatus,
        phoneNumber: scanResults.phoneNumber,
        responseTimeMs: scanResults.responseTimeMs,
        handshakeTimeMs: scanResults.handshakeTimeMs,
        accountInfoTimeMs: scanResults.accountInfoTimeMs,
        timezone: scanResults.timezone,
        portalOnline: scanResults.portalOnline,
        lastActive: scanResults.lastActive,
        username: scanResults.username,
        password: scanResults.password,
        playlistGenres: scanResults.playlistGenres,
        vodCategories: scanResults.vodCategories,
        qualityVerdict: scanResults.qualityVerdict,
        qualityScore: scanResults.qualityScore,
        qualitySpeedScore: scanResults.qualitySpeedScore,
        qualityQualityScore: scanResults.qualityQualityScore,
        qualityStabilityScore: scanResults.qualityStabilityScore,
        qualityResolution: scanResults.qualityResolution,
        qualityCodec: scanResults.qualityCodec,
        qualityThroughputMbps: scanResults.qualityThroughputMbps,
        qualityRequiredMbps: scanResults.qualityRequiredMbps,
        qualityChannelsPlayable: scanResults.qualityChannelsPlayable,
        qualityChannelsProbed: scanResults.qualityChannelsProbed,
        qualityCheckedAt: scanResults.qualityCheckedAt,
        qualityFrozen: scanResults.qualityFrozen,
        qualityLabelMismatch: scanResults.qualityLabelMismatch,
        qualityRetries: scanResults.qualityRetries,
        qualityThroughputCv: scanResults.qualityThroughputCv,
        qualityCatchUpStatus: scanResults.qualityCatchUpStatus,
        qualityCatchUpDays: scanResults.qualityCatchUpDays,
        qualityThumbnail: scanResults.qualityThumbnail,
        qualityEwma: scanResults.qualityEwma,
        qualityTrend: scanResults.qualityTrend,
        qualityGenreSummary: scanResults.qualityGenreSummary,
        protocol: scanResults.protocol,
        foundAt: scanResults.foundAt,
      })
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
