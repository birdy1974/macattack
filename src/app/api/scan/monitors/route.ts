import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { monitors, qualityProbeRuns, scanJobs, scanResults, settings } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { checkMacStreamQuality } from "@/lib/mac-quality";
import { detectDegradation, summariseHistory, type ProbeRun } from "@/lib/quality-history";
import { parseProxyList } from "@/lib/proxy";
import { parseUserAgentList } from "@/lib/user-agents";

/**
 * Scheduled monitoring of already-found MACs.
 *
 *   GET    /api/scan/monitors?resultId=42 → list monitors
 *   POST   /api/scan/monitors             → create/update a monitor
 *   PUT    /api/scan/monitors             → run due monitors now (also used by cron)
 *   DELETE /api/scan/monitors?id=7        → remove a monitor
 *
 * There is no background daemon: the app is a single Next.js process on a NAS.
 * Due monitors are executed whenever PUT is called (the UI's "run due checks"
 * button, or an external cron hitting the same endpoint). Alerts are surfaced
 * as dashboard state + logs; nothing is sent to third parties.
 */

const MIN_INTERVAL_MINUTES = 15;

function isDue(lastRunAt: Date | null, intervalMinutes: number): boolean {
  if (!lastRunAt) return true;
  return Date.now() - lastRunAt.getTime() >= intervalMinutes * 60 * 1000;
}

export async function GET(request: NextRequest) {
  try {
    const resultIdRaw = request.nextUrl.searchParams.get("resultId");
    const resultId = resultIdRaw ? Number(resultIdRaw) : null;

    const base = db
      .select({
        monitor: monitors,
        macAddress: scanResults.macAddress,
        portalUrl: scanResults.portalUrl,
        protocol: scanResults.protocol,
        resultScore: scanResults.qualityScore,
        resultEwma: scanResults.qualityEwma,
        resultTrend: scanResults.qualityTrend,
      })
      .from(monitors)
      .innerJoin(scanResults, eq(monitors.resultId, scanResults.id));

    const rows =
      resultId && Number.isSafeInteger(resultId)
        ? await base.where(eq(monitors.resultId, resultId)).orderBy(desc(monitors.createdAt)).limit(200)
        : await base.orderBy(desc(monitors.createdAt)).limit(500);

    return NextResponse.json({
      monitors: rows.map((row) => ({
        ...row.monitor,
        macAddress: row.macAddress,
        portalUrl: row.portalUrl,
        protocol: row.protocol,
        resultScore: row.resultScore,
        resultEwma: row.resultEwma,
        resultTrend: row.resultTrend,
        due: row.monitor.enabled === 1 && isDue(row.monitor.lastRunAt, row.monitor.intervalMinutes),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load monitors" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      resultId?: number;
      enabled?: boolean;
      intervalMinutes?: number;
      alertOn?: string;
      channels?: number;
      sampleMs?: number;
    };

    const resultId = Number(body.resultId);
    if (!Number.isSafeInteger(resultId) || resultId < 1) {
      return NextResponse.json({ error: "Valid resultId is required" }, { status: 400 });
    }

    const [result] = await db
      .select({ id: scanResults.id })
      .from(scanResults)
      .where(eq(scanResults.id, resultId))
      .limit(1);
    if (!result) {
      return NextResponse.json({ error: "Result not found" }, { status: 404 });
    }

    const values = {
      resultId,
      enabled: body.enabled === false ? 0 : 1,
      intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.min(Number(body.intervalMinutes) || 360, 10080)),
      alertOn: (body.alertOn || "degrading,poor,unusable").slice(0, 120),
      channels: Math.max(1, Math.min(Number(body.channels) || 3, 8)),
      sampleMs: Math.max(3000, Math.min(Number(body.sampleMs) || 8000, 30000)),
    };

    const [existing] = await db.select().from(monitors).where(eq(monitors.resultId, resultId)).limit(1);
    const [row] = existing
      ? await db.update(monitors).set(values).where(eq(monitors.id, existing.id)).returning()
      : await db.insert(monitors).values(values).returning();

    return NextResponse.json({ success: true, monitor: row });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save monitor" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) {
      return NextResponse.json({ error: "Valid id is required" }, { status: 400 });
    }
    await db.delete(monitors).where(eq(monitors.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete monitor" },
      { status: 500 }
    );
  }
}

/**
 * Run every due monitor once. `?force=1` ignores the interval (used by the
 * "check now" button), `?limit=` caps how many run in one request.
 */
export async function PUT(request: NextRequest) {
  try {
    const force = request.nextUrl.searchParams.get("force") === "1";
    const limit = Math.max(1, Math.min(Number(request.nextUrl.searchParams.get("limit")) || 3, 10));

    const allSettings = await db.select().from(settings);
    const settingsMap = Object.fromEntries(allSettings.map((row) => [row.key, row.value || ""]));
    const userAgents = parseUserAgentList(settingsMap.ua_list);
    const proxyPool = parseProxyList(settingsMap.proxy_list);

    const candidates = await db
      .select({ monitor: monitors, result: scanResults, job: scanJobs })
      .from(monitors)
      .innerJoin(scanResults, eq(monitors.resultId, scanResults.id))
      .leftJoin(scanJobs, eq(scanResults.jobId, scanJobs.id))
      .where(eq(monitors.enabled, 1))
      .orderBy(monitors.lastRunAt)
      .limit(50);

    const due = candidates
      .filter((row) => force || isDue(row.monitor.lastRunAt, row.monitor.intervalMinutes))
      .slice(0, limit);

    const outcomes: Array<{
      monitorId: number;
      resultId: number;
      macAddress: string;
      score: number | null;
      verdict: string | null;
      trend: string;
      alert: boolean;
      reason: string | null;
      error: string | null;
    }> = [];

    for (const row of due) {
      const { monitor, result, job } = row;
      const error = await runMonitorCheck({ monitor, result, job, userAgents, proxyPool });
      const [refreshed] = await db.select().from(monitors).where(eq(monitors.id, monitor.id)).limit(1);

      outcomes.push({
        monitorId: monitor.id,
        resultId: result.id,
        macAddress: result.macAddress,
        score: refreshed?.lastScore ?? null,
        verdict: refreshed?.lastVerdict ?? null,
        trend: refreshed?.lastTrend ?? "insufficient_data",
        alert: !!refreshed?.lastAlertReason,
        reason: refreshed?.lastAlertReason ?? null,
        error,
      });
    }

    return NextResponse.json({ success: true, ran: outcomes.length, skipped: Math.max(0, candidates.length - due.length), outcomes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run monitors" },
      { status: 500 }
    );
  }
}

async function runMonitorCheck(args: {
  monitor: typeof monitors.$inferSelect;
  result: typeof scanResults.$inferSelect;
  job: typeof scanJobs.$inferSelect | null;
  userAgents: string[];
  proxyPool: ReturnType<typeof parseProxyList>;
}): Promise<string | null> {
  const { monitor, result, job } = args;
  const checkedAt = new Date();

  try {
    // Xtream results are re-checked through their own client.
    if (result.protocol === "xtream" && job?.xtreamUsername && job?.xtreamPassword) {
      const { checkXtreamAccountQuality } = await import("@/lib/xtream-quality");
      const { report, error } = await checkXtreamAccountQuality({
        credentials: {
          base: job.portalUrl,
          username: job.xtreamUsername,
          password: job.xtreamPassword,
          endpoint: "player_api",
        },
        channelsToProbe: monitor.channels,
        sampleMs: monitor.sampleMs,
      });
      if (!report) throw new Error(error || "Xtream check failed");
      await persistMonitorOutcome(monitor, result, report, checkedAt, args.proxyPool);
      return null;
    }

    if (!result.stalkerServerPath) throw new Error("No Stalker endpoint stored for this result");

    const serverPath = result.stalkerServerPath;
    const portalBase = `${new URL(serverPath).origin}/c/`;
    const report = await checkMacStreamQuality({
      serverPath,
      portalBase,
      mac: result.macAddress,
      timeoutMs: Math.max(job?.timeoutMs || 5000, 8000),
      channelsToProbe: monitor.channels,
      sampleMs: monitor.sampleMs,
      userAgents: args.userAgents,
      rememberedUserAgent: null,
      proxy: args.proxyPool[0] ?? null,
      checkCatchUp: false,
      pictureChecks: true,
      thumbnails: false,
      concurrency: 2,
    });
    await persistMonitorOutcome(monitor, result, report, checkedAt, args.proxyPool);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Monitor check failed";
    await db
      .update(monitors)
      .set({ lastRunAt: checkedAt, lastAlertReason: `Check failed: ${message}` })
      .where(eq(monitors.id, monitor.id));
    return message;
  }
}

async function persistMonitorOutcome(
  monitor: typeof monitors.$inferSelect,
  result: typeof scanResults.$inferSelect,
  report: Awaited<ReturnType<typeof checkMacStreamQuality>>,
  checkedAt: Date,
  proxyPool: ReturnType<typeof parseProxyList>
): Promise<void> {
  const measuredChannel = report.channels.find((channel) => channel.probe);

  await db.insert(qualityProbeRuns).values({
    resultId: result.id,
    jobId: result.jobId,
    macAddress: result.macAddress,
    measuredAt: checkedAt,
    overallScore: report.aggregate.overallScore,
    speedScore: report.aggregate.speedScore,
    qualityScore: report.aggregate.qualityScore,
    stabilityScore: report.aggregate.stabilityScore,
    verdict: report.aggregate.verdict,
    throughputMbps: measuredChannel?.probe?.sustainedMbps ?? null,
    requiredMbps: measuredChannel?.probe?.requiredMbps ?? null,
    channelsPlayable: report.aggregate.channelsPlayable,
    channelsProbed: report.aggregate.channelsProbed,
    frozen: report.aggregate.frozenChannels > 0 ? 1 : 0,
    labelMismatches: report.aggregate.labelMismatches,
    viaProxy: proxyPool[0] ? `${proxyPool[0].host}:${proxyPool[0].port}` : null,
    source: "monitor",
  });

  const stored = await db
    .select()
    .from(qualityProbeRuns)
    .where(eq(qualityProbeRuns.resultId, result.id))
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
  const degradation = detectDegradation(runs);

  const alertOn = monitor.alertOn.split(",").map((value) => value.trim()).filter(Boolean);
  const reasons: string[] = [];
  if (degradation.degraded) reasons.push(`score dropped to ${degradation.latest?.toFixed(1)} (avg ${degradation.ewma?.toFixed(1)})`);
  if (report.aggregate.verdict && alertOn.includes(report.aggregate.verdict)) {
    reasons.push(`verdict is ${report.aggregate.verdict}`);
  }
  if (alertOn.includes("degrading") && summary.trend === "degrading") reasons.push("trend is degrading");

  await db
    .update(scanResults)
    .set({
      qualityScore: report.aggregate.overallScore,
      qualityVerdict: report.aggregate.verdict,
      qualityEwma: summary.ewma,
      qualityTrend: summary.trend,
      qualityCheckedAt: checkedAt,
      qualityReport: report,
      qualityFrozen: report.aggregate.frozenChannels > 0 ? 1 : 0,
      qualityLabelMismatch:
        report.aggregate.labelMismatches > 0 ? `${report.aggregate.labelMismatches} channel(s) mislabeled` : null,
      qualityThroughputCv: measuredChannel?.probe?.throughputCoefficientOfVariation ?? null,
      qualityGenreSummary: report.genreGroups,
    })
    .where(eq(scanResults.id, result.id));

  await db
    .update(monitors)
    .set({
      lastRunAt: checkedAt,
      lastVerdict: report.aggregate.verdict,
      lastScore: report.aggregate.overallScore,
      lastTrend: summary.trend,
      lastAlertAt: reasons.length > 0 ? checkedAt : monitor.lastAlertAt,
      lastAlertReason: reasons.length > 0 ? reasons.join("; ") : null,
    })
    .where(eq(monitors.id, monitor.id));
}
