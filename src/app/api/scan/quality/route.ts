import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scanJobs, scanResults } from "@/db/schema";
import { validateStalkerPortal } from "@/lib/scanner";
import { checkMacStreamQuality, type MacStreamQualityReport } from "@/lib/mac-quality";

/**
 * Stream quality / speed / stability for one stored result.
 *
 *   GET  ?resultId=42            → the stored report (if the scan measured one)
 *   POST { resultId, channels?, sampleMs? } → measure (again) on demand
 *
 * The scan runs this automatically for every MAC that passes the filters; this
 * endpoint exists so a result can be re-measured later (streams change) and so
 * the UI can open the full report without bloating the status poll.
 */

async function loadResult(resultId: number) {
  const [row] = await db
    .select({
      result: scanResults,
      job: scanJobs,
    })
    .from(scanResults)
    .innerJoin(scanJobs, eq(scanResults.jobId, scanJobs.id))
    .where(eq(scanResults.id, resultId))
    .limit(1);
  return row ?? null;
}

async function resolveServerPath(
  portalUrl: string,
  stored: string | null,
  timeoutMs: number
): Promise<string | null> {
  if (stored) return stored;
  const validation = await validateStalkerPortal(portalUrl, timeoutMs);
  return validation.valid ? validation.serverPath ?? null : null;
}

function flatten(report: MacStreamQualityReport) {
  const measured = report.channels.find((channel) => channel.probe);
  return {
    qualityVerdict: report.aggregate.verdict,
    qualityScore: report.aggregate.overallScore,
    qualitySpeedScore: report.aggregate.speedScore,
    qualityQualityScore: report.aggregate.qualityScore,
    qualityStabilityScore: report.aggregate.stabilityScore,
    qualityResolution: measured?.probe?.resolution?.label ?? null,
    qualityCodec: measured?.probe?.videoCodec ?? null,
    qualityThroughputMbps: measured?.probe?.sustainedMbps ?? null,
    qualityRequiredMbps: measured?.probe?.requiredMbps ?? null,
    qualityChannelsPlayable: report.aggregate.channelsPlayable,
    qualityChannelsProbed: report.aggregate.channelsProbed,
    qualityCheckedAt: new Date(report.measuredAt),
    qualityReport: report,
  };
}

export async function GET(request: NextRequest) {
  const resultId = Number(request.nextUrl.searchParams.get("resultId"));
  if (!Number.isSafeInteger(resultId) || resultId < 1) {
    return NextResponse.json({ error: "Valid resultId is required" }, { status: 400 });
  }

  try {
    const [row] = await db
      .select({
        id: scanResults.id,
        macAddress: scanResults.macAddress,
        qualityVerdict: scanResults.qualityVerdict,
        qualityScore: scanResults.qualityScore,
        qualityCheckedAt: scanResults.qualityCheckedAt,
        qualityReport: scanResults.qualityReport,
      })
      .from(scanResults)
      .where(eq(scanResults.id, resultId))
      .limit(1);

    if (!row) return NextResponse.json({ error: "Result not found" }, { status: 404 });

    return NextResponse.json({
      resultId: row.id,
      macAddress: row.macAddress,
      verdict: row.qualityVerdict,
      score: row.qualityScore,
      checkedAt: row.qualityCheckedAt,
      report: row.qualityReport ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load quality report" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: { resultId?: number; channels?: number; sampleMs?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const resultId = Number(body.resultId);
  if (!Number.isSafeInteger(resultId) || resultId < 1) {
    return NextResponse.json({ error: "Valid resultId is required" }, { status: 400 });
  }

  try {
    const row = await loadResult(resultId);
    if (!row) return NextResponse.json({ error: "Result not found" }, { status: 404 });
    if (!row.job || row.result.jobId !== row.job.id) {
      return NextResponse.json({ error: "Result/job mismatch" }, { status: 409 });
    }

    const serverPath = await resolveServerPath(
      row.job.portalUrl,
      row.result.stalkerServerPath,
      row.job.timeoutMs || 5000
    );
    if (!serverPath) {
      return NextResponse.json(
        { error: "Could not resolve a Stalker endpoint for this portal" },
        { status: 502 }
      );
    }

    const portalBase = row.result.stalkerServerPath
      ? new URL(row.result.stalkerServerPath).origin + "/c/"
      : new URL(serverPath).origin + "/c/";

    const report = await checkMacStreamQuality({
      serverPath,
      portalBase,
      mac: row.result.macAddress,
      timeoutMs: Math.max(row.job.timeoutMs || 5000, 8000),
      channelsToProbe: Math.max(1, Math.min(Number(body.channels) || row.job.qualityChannels || 3, 8)),
      sampleMs: Math.max(3000, Math.min(Number(body.sampleMs) || row.job.qualitySampleMs || 8000, 30000)),
    });

    const flat = flatten(report);
    await db
      .update(scanResults)
      .set({ ...flat, stalkerServerPath: row.result.stalkerServerPath || serverPath })
      .where(and(eq(scanResults.id, resultId), eq(scanResults.jobId, row.job.id)));

    return NextResponse.json({ success: true, ...flat });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Quality check failed" },
      { status: 500 }
    );
  }
}
