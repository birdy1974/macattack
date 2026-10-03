import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { qualityProbeRuns, scanJobs, scanResults, settings } from "@/db/schema";
import { validateStalkerPortal } from "@/lib/scanner";
import { checkMacStreamQuality, type MacStreamQualityReport } from "@/lib/mac-quality";
import { detectDegradation, summariseHistory, type ProbeRun } from "@/lib/quality-history";
import { parseProxyList } from "@/lib/proxy";
import { parseUserAgentList, userAgentSettingKey } from "@/lib/user-agents";
import { hostOf } from "@/lib/parallel";
import { checkXtreamAccountQuality } from "@/lib/xtream-quality";

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
  const thumbnail = report.channels.find((channel) => channel.thumbnail);
  return {
    qualityFrozen: report.aggregate.frozenChannels > 0 ? 1 : 0,
    qualityLabelMismatch:
      report.aggregate.labelMismatches > 0 ? `${report.aggregate.labelMismatches} channel(s) mislabeled` : null,
    qualityRetries: measured?.probe?.retryCount ?? 0,
    qualityThroughputCv: measured?.probe?.throughputCoefficientOfVariation ?? null,
    qualityCatchUpStatus: report.catchUp?.status ?? "not_checked",
    qualityCatchUpDays: report.catchUp?.verifiedMinutes ? report.catchUp.verifiedMinutes / (60 * 24) : null,
    qualityThumbnail: thumbnail?.thumbnail ?? null,
    qualityGenreSummary: report.genreGroups,
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

/**
 * Append one probe run and return the EWMA/trend across the stored history.
 */
async function persistMeasurement(
  resultId: number,
  jobId: number,
  mac: string,
  report: MacStreamQualityReport,
  source: "manual" | "monitor" | "scan"
): Promise<{ ewma: number | null; trend: string }> {
  const measured = report.channels.find((channel) => channel.probe);
  try {
    await db.insert(qualityProbeRuns).values({
      resultId,
      jobId,
      macAddress: mac,
      measuredAt: new Date(report.measuredAt),
      overallScore: report.aggregate.overallScore,
      speedScore: report.aggregate.speedScore,
      qualityScore: report.aggregate.qualityScore,
      stabilityScore: report.aggregate.stabilityScore,
      verdict: report.aggregate.verdict,
      throughputMbps: measured?.probe?.sustainedMbps ?? null,
      requiredMbps: measured?.probe?.requiredMbps ?? null,
      channelsPlayable: report.aggregate.channelsPlayable,
      channelsProbed: report.aggregate.channelsProbed,
      frozen: report.aggregate.frozenChannels > 0 ? 1 : 0,
      labelMismatches: report.aggregate.labelMismatches,
      viaProxy: report.portal?.viaProxy ?? null,
      source,
    });
  } catch {
    return { ewma: report.aggregate.overallScore, trend: "insufficient_data" };
  }

  const stored = await db
    .select()
    .from(qualityProbeRuns)
    .where(eq(qualityProbeRuns.resultId, resultId))
    .orderBy(qualityProbeRuns.measuredAt);

  const runs: ProbeRun[] = stored.map((entry) => ({
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

  const summary = summariseHistory(runs);
  return { ewma: summary.ewma, trend: summary.trend };
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
        protocol: scanResults.protocol,
        qualityVerdict: scanResults.qualityVerdict,
        qualityScore: scanResults.qualityScore,
        qualityEwma: scanResults.qualityEwma,
        qualityTrend: scanResults.qualityTrend,
        qualityCheckedAt: scanResults.qualityCheckedAt,
        qualityReport: scanResults.qualityReport,
      })
      .from(scanResults)
      .where(eq(scanResults.id, resultId))
      .limit(1);

    if (!row) return NextResponse.json({ error: "Result not found" }, { status: 404 });

    // Probe history (newest first) so the panel can draw a trend sparkline.
    const history = await db
      .select()
      .from(qualityProbeRuns)
      .where(eq(qualityProbeRuns.resultId, resultId))
      .orderBy(desc(qualityProbeRuns.measuredAt))
      .limit(60);

    return NextResponse.json({
      resultId: row.id,
      macAddress: row.macAddress,
      protocol: row.protocol,
      verdict: row.qualityVerdict,
      score: row.qualityScore,
      ewma: row.qualityEwma,
      trend: row.qualityTrend,
      checkedAt: row.qualityCheckedAt,
      report: row.qualityReport ?? null,
      history: history.map((entry) => ({
        measuredAt: entry.measuredAt.toISOString(),
        overall: entry.overallScore,
        speed: entry.speedScore,
        quality: entry.qualityScore,
        stability: entry.stabilityScore,
        verdict: entry.verdict,
        throughputMbps: entry.throughputMbps,
        frozen: entry.frozen === 1,
        labelMismatches: entry.labelMismatches,
        source: entry.source,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load quality report" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: {
    resultId?: number;
    channels?: number;
    sampleMs?: number;
    pictureChecks?: boolean;
    thumbnails?: boolean;
    catchUp?: boolean;
    viaProxy?: boolean;
  };
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

    const allSettings = await db.select().from(settings);
    const settingsMap = Object.fromEntries(allSettings.map((setting) => [setting.key, setting.value || ""]));
    const proxyPool = parseProxyList(settingsMap.proxy_list);
    const wantedProxy = body.viaProxy ? proxyPool[0] ?? null : null;

    // ── Xtream results take the Xtream path ───────────────────────────
    if (row.result.protocol === "xtream") {
      if (!row.job.xtreamUsername || !row.job.xtreamPassword) {
        return NextResponse.json({ error: "Xtream credentials are missing for this result" }, { status: 409 });
      }
      const { report, error } = await checkXtreamAccountQuality({
        credentials: {
          base: row.job.portalUrl,
          username: row.job.xtreamUsername,
          password: row.job.xtreamPassword,
          endpoint: "player_api",
        },
        channelsToProbe: Math.max(1, Math.min(Number(body.channels) || 3, 8)),
        sampleMs: Math.max(3000, Math.min(Number(body.sampleMs) || 8000, 30000)),
        pictureChecks: body.pictureChecks !== false,
        thumbnails: body.thumbnails !== false,
      });
      if (!report) {
        return NextResponse.json({ error: error || "Xtream check failed" }, { status: 502 });
      }
      const flat = flatten(report);
      const summary = await persistMeasurement(resultId, row.result.jobId, row.result.macAddress, report, "manual");
      await db
        .update(scanResults)
        .set({ ...flat, qualityEwma: summary.ewma, qualityTrend: summary.trend })
        .where(eq(scanResults.id, resultId));
      return NextResponse.json({ success: true, ...flat, ewma: summary.ewma, trend: summary.trend });
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
      userAgents: parseUserAgentList(settingsMap.ua_list),
      rememberedUserAgent: settingsMap[userAgentSettingKey(hostOf(serverPath))] || null,
      proxy: wantedProxy,
      pictureChecks: body.pictureChecks !== false,
      thumbnails: body.thumbnails !== false,
      checkCatchUp: body.catchUp !== false,
      concurrency: 2,
    });

    const flat = flatten(report);
    const summary = await persistMeasurement(resultId, row.result.jobId, row.result.macAddress, report, "manual");
    const degradation = detectDegradation(
      (
        await db
          .select()
          .from(qualityProbeRuns)
          .where(eq(qualityProbeRuns.resultId, resultId))
          .orderBy(qualityProbeRuns.measuredAt)
      ).map((entry) => ({
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
      }))
    );

    await db
      .update(scanResults)
      .set({
        ...flat,
        qualityEwma: summary.ewma,
        qualityTrend: summary.trend,
        stalkerServerPath: row.result.stalkerServerPath || serverPath,
      })
      .where(and(eq(scanResults.id, resultId), eq(scanResults.jobId, row.job.id)));

    return NextResponse.json({
      success: true,
      ...flat,
      ewma: summary.ewma,
      trend: summary.trend,
      degradation,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Quality check failed" },
      { status: 500 }
    );
  }
}
