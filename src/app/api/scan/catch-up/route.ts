import { NextRequest, NextResponse } from "next/server";
import { db, ensureMigrations } from "@/db";
import { scanJobs, scanResults, settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { catchUpFromReport } from "@/lib/catchup-verification";
import { saveCatchUpCheck } from "@/lib/catchup-store";
import { checkMacCatchUp } from "@/lib/mac-quality";
import { checkXtreamCatchUp } from "@/lib/xtream-quality";
import { validateStalkerPortal } from "@/lib/scanner";
import { parseUserAgentList, userAgentSettingKey } from "@/lib/user-agents";
import { hostOf } from "@/lib/parallel";

// Bound each request to a small batch. Results accumulate across batches, not
// across credentials: the MAC and portal always come from the stored result.
const activeChecks = new Set<number>();

export async function POST(request: NextRequest) {
  let body: { resultId?: unknown; channelKey?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON object required" }, { status: 400 });
  const resultId = Number(body.resultId);
  if (!Number.isSafeInteger(resultId) || resultId < 1) {
    return NextResponse.json({ error: "Valid resultId is required" }, { status: 400 });
  }
  if (body.channelKey !== undefined && (typeof body.channelKey !== "string" || !body.channelKey || body.channelKey.length > 512)) {
    return NextResponse.json({ error: "Invalid channelKey" }, { status: 400 });
  }
  if (activeChecks.has(resultId)) return NextResponse.json({ error: "Catch-up check already running for this result" }, { status: 409 });
  activeChecks.add(resultId);
  try {
    await ensureMigrations();
    const [row] = await db.select({ result: scanResults, job: scanJobs }).from(scanResults)
      .innerJoin(scanJobs, eq(scanResults.jobId, scanJobs.id)).where(eq(scanResults.id, resultId)).limit(1);
    if (!row) return NextResponse.json({ error: "Result not found" }, { status: 404 });
    const previous = row.result.qualityCatchUpSummary ?? catchUpFromReport(row.result.qualityReport);
    const hasUntested = previous?.channels?.some((c) => c.status === "untested");
    const channelKeys = typeof body.channelKey === "string" ? [body.channelKey] : undefined;
    const skipCheckedKeys = !channelKeys && hasUntested
      ? previous?.channels?.filter((c) => c.status !== "untested").map((c) => c.key) : undefined;
    // Stop long/offline batches, preserving completed per-channel results.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90000)]);
    let report;
    if (row.result.protocol === "xtream") {
      if (!row.job.xtreamUsername || !row.job.xtreamPassword) {
        return NextResponse.json({ error: "Stored Xtream credentials are missing" }, { status: 409 });
      }
      report = await checkXtreamCatchUp({
        credentials: { base: row.job.portalUrl, username: row.job.xtreamUsername,
          password: row.job.xtreamPassword, endpoint: "player_api" },
        channelKeys, skipCheckedKeys, channelLimit: 3, sampleMs: 3000, timeoutMs: 8000, signal,
      });
    } else {
      const serverPath = row.result.stalkerServerPath ||
        (await validateStalkerPortal(row.job.portalUrl, row.job.timeoutMs || 5000)).serverPath;
      if (!serverPath) return NextResponse.json({ error: "Could not resolve the stored portal endpoint" }, { status: 502 });
      const allSettings = await db.select().from(settings);
      const values = Object.fromEntries(allSettings.map((s) => [s.key, s.value || ""]));
      report = await checkMacCatchUp({
        serverPath, portalBase: `${new URL(serverPath).origin}/c/`, mac: row.result.macAddress,
        userAgents: parseUserAgentList(values.ua_list),
        rememberedUserAgent: values[userAgentSettingKey(hostOf(serverPath))] || null,
        channelKeys, skipCheckedKeys, channelLimit: 3, sampleMs: 3000, timeoutMs: 8000, signal,
      });
    }
    const summary = await saveCatchUpCheck(resultId, report);
    return NextResponse.json({ success: true, qualityCatchUpSummary: summary,
      qualityCatchUpStatus: summary.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Catch-up check failed" }, { status: 502 });
  } finally {
    activeChecks.delete(resultId);
  }
}
