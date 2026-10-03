import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { qualityProbeRuns, scanResults } from "@/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";
import { summariseHistory, type ProbeRun } from "@/lib/quality-history";

/**
 * Probe history for one found result.
 *
 *   GET /api/scan/history?resultId=123&days=30
 *
 * Returns every stored probe run plus the EWMA/trend summary, so the UI can
 * show "trust over time" instead of a single spot check.
 */
export async function GET(request: NextRequest) {
  try {
    const resultIdRaw = request.nextUrl.searchParams.get("resultId");
    const resultId = Number(resultIdRaw);
    if (!resultIdRaw || !Number.isFinite(resultId)) {
      return NextResponse.json({ error: "resultId is required" }, { status: 400 });
    }

    const days = Math.max(1, Math.min(Number(request.nextUrl.searchParams.get("days")) || 90, 365));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [result] = await db
      .select({
        id: scanResults.id,
        macAddress: scanResults.macAddress,
        portalUrl: scanResults.portalUrl,
        protocol: scanResults.protocol,
        qualityEwma: scanResults.qualityEwma,
        qualityTrend: scanResults.qualityTrend,
      })
      .from(scanResults)
      .where(eq(scanResults.id, resultId))
      .limit(1);

    if (!result) {
      return NextResponse.json({ error: "Result not found" }, { status: 404 });
    }

    const rows = await db
      .select()
      .from(qualityProbeRuns)
      .where(and(eq(qualityProbeRuns.resultId, resultId), gte(qualityProbeRuns.measuredAt, since)))
      .orderBy(desc(qualityProbeRuns.measuredAt))
      .limit(500);

    const chronological: ProbeRun[] = rows
      .slice()
      .reverse()
      .map((entry) => ({
        id: entry.id,
        resultId: entry.resultId,
        measuredAt: entry.measuredAt.toISOString(),
        overall: entry.overallScore,
        speed: entry.speedScore,
        quality: entry.qualityScore,
        stability: entry.stabilityScore,
        verdict: entry.verdict,
        throughputMbps: entry.throughputMbps,
        requiredMbps: entry.requiredMbps,
        channelsPlayable: entry.channelsPlayable,
        channelsProbed: entry.channelsProbed,
      }));

    const summary = summariseHistory(chronological);

    // Merge the extra evidence fields back in (newest first for display).
    const byId = new Map(chronological.map((run) => [run.id, run]));
    const runs = rows.map((row) => ({
      ...(byId.get(row.id) as ProbeRun),
      frozen: row.frozen === 1,
      labelMismatches: row.labelMismatches ?? 0,
      viaProxy: row.viaProxy,
      source: row.source,
    }));

    return NextResponse.json({ result, summary, runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load history" },
      { status: 500 }
    );
  }
}
