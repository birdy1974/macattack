import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs, scanResults } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildQualityReport } from "@/lib/quality-report";

function extractDomainFromUrl(url: string): string {
  try {
    // Remove protocol
    let domain = url.replace(/^https?:\/\//, "");
    // Get the part before : or /
    const colonIdx = domain.indexOf(":");
    const slashIdx = domain.indexOf("/");
    if (colonIdx > 0 && (slashIdx < 0 || colonIdx < slashIdx)) {
      domain = domain.substring(0, colonIdx);
    } else if (slashIdx > 0) {
      domain = domain.substring(0, slashIdx);
    }
    // Clean up any remaining special chars
    return domain.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "unknown";
  }
}

function formatDateForFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}`;
}

export async function GET(request: NextRequest) {
  try {
    const jobId = request.nextUrl.searchParams.get("jobId");
    const format = request.nextUrl.searchParams.get("format") || "csv";

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
      .where(eq(scanResults.jobId, parseInt(jobId)));

    const selectedFields = (job.selectedFields as string[]) || [
      "macAddress",
      "portalUrl",
      "expireDate",
    ];
    const qualityReportCache = new Map<number, ReturnType<typeof buildQualityReport>>();
    const getQualityReport = (result: (typeof results)[number]) => {
      const cached = qualityReportCache.get(result.id);
      if (cached) return cached;
      const report = buildQualityReport(job, result);
      qualityReportCache.set(result.id, report);
      return report;
    };

    const fieldMap: Record<string, string> = {
      macAddress: "MAC Address",
      portalUrl: "Portal URL",
      expireDate: "Expire Date",
      serverLocation: "Server Location",
      responseTimeMs: "Portal Check Response (ms)",
      handshakeTimeMs: "Portal Handshake (ms)",
      accountInfoTimeMs: "Account Info Request (ms)",
      portalCheckStatus: "Portal Check Status (not playback)",
      playbackStability: "Playback Stability",
      qualityConfidence: "Quality Test Scope/Confidence",
      qualityReport: "Detailed Quality Report (JSON)",
      qualityVerdict: "Stream Quality Verdict (measured)",
      qualityScore: "Stream Quality Score (0-10)",
      qualitySpeedScore: "Stream Speed Score (0-10)",
      qualityQualityScore: "Stream Picture/Quality Score (0-10)",
      qualityStabilityScore: "Stream Stability Score (0-10)",
      qualityResolution: "Stream Resolution (measured)",
      qualityCodec: "Stream Video Codec (measured)",
      qualityThroughputMbps: "Stream Throughput (Mbps, measured)",
      qualityRequiredMbps: "Stream Required Bitrate (Mbps)",
      qualityChannels: "Stream Channels Playable/Probed",
      qualityMeasured: "Stream Quality Measured At",
      tariffPlan: "Tariff Plan",
      maxConnections: "Max Connections",
      activeConnections: "Active Connections",
      portalOnline: "Portal Online State",
      lastActive: "Last Active",
      accountStatus: "Account Status",
      phoneNumber: "Phone Number",
      createdAt: "Created At",
      timezone: "Timezone",
      username: "Username",
      password: "Password",
      playlistGenres: "Playlist/Genres",
      vodCategories: "VOD Categories",
    };

    const getFieldValue = (
      result: (typeof results)[0],
      field: string
    ): string => {
      switch (field) {
        case "macAddress":
          return result.macAddress || "";
        case "portalUrl":
          return result.portalUrl || "";
        case "expireDate":
          return result.expireDate || "";
        case "serverLocation":
          return result.serverLocation || "";
        case "responseTimeMs":
          return result.responseTimeMs !== null && result.responseTimeMs !== undefined
            ? String(result.responseTimeMs)
            : "";
        case "handshakeTimeMs":
          return result.handshakeTimeMs !== null && result.handshakeTimeMs !== undefined
            ? String(result.handshakeTimeMs)
            : "";
        case "accountInfoTimeMs":
          return result.accountInfoTimeMs !== null && result.accountInfoTimeMs !== undefined
            ? String(result.accountInfoTimeMs)
            : "";
        case "portalCheckStatus":
          return getQualityReport(result).portal.label;
        case "playbackStability":
          return getQualityReport(result).playback.label;
        case "qualityConfidence":
          return getQualityReport(result).confidence.label;
        case "qualityReport":
          return result.qualityReport ? JSON.stringify(result.qualityReport) : JSON.stringify(getQualityReport(result));
        case "qualityVerdict":
          return result.qualityVerdict || "not_measured";
        case "qualityScore":
          return result.qualityScore !== null && result.qualityScore !== undefined
            ? String(result.qualityScore)
            : "";
        case "qualitySpeedScore":
          return result.qualitySpeedScore !== null && result.qualitySpeedScore !== undefined
            ? String(result.qualitySpeedScore)
            : "";
        case "qualityQualityScore":
          return result.qualityQualityScore !== null && result.qualityQualityScore !== undefined
            ? String(result.qualityQualityScore)
            : "";
        case "qualityStabilityScore":
          return result.qualityStabilityScore !== null && result.qualityStabilityScore !== undefined
            ? String(result.qualityStabilityScore)
            : "";
        case "qualityResolution":
          return result.qualityResolution || "";
        case "qualityCodec":
          return result.qualityCodec || "";
        case "qualityThroughputMbps":
          return result.qualityThroughputMbps !== null && result.qualityThroughputMbps !== undefined
            ? String(result.qualityThroughputMbps)
            : "";
        case "qualityRequiredMbps":
          return result.qualityRequiredMbps !== null && result.qualityRequiredMbps !== undefined
            ? String(result.qualityRequiredMbps)
            : "";
        case "qualityChannels":
          return result.qualityChannelsProbed !== null && result.qualityChannelsProbed !== undefined
            ? `${result.qualityChannelsPlayable ?? 0}/${result.qualityChannelsProbed}`
            : "";
        case "qualityMeasured":
          return result.qualityCheckedAt ? result.qualityCheckedAt.toISOString() : "";
        case "tariffPlan":
          return result.tariffPlan || "";
        case "maxConnections":
          return result.maxConnections ?? "";
        case "activeConnections":
          return result.activeConnections ?? "";
        case "portalOnline":
          return result.portalOnline ?? "";
        case "lastActive":
          return result.lastActive ?? "";
        case "accountStatus":
          return result.accountStatus || "";
        case "phoneNumber":
          return result.phoneNumber || "";
        case "createdAt":
          return result.createdAt?.toISOString() || "";
        case "timezone":
          return result.timezone || "";
        case "username":
          return result.username || "";
        case "password":
          return result.password || "";
        case "playlistGenres":
          return result.playlistGenres || "";
        case "vodCategories":
          return result.vodCategories || "";
        default:
          return "";
      }
    };

    // Generate filename: mac_result_<domain>_<date>
    const domain = extractDomainFromUrl(job.portalUrl);
    const dateStr = formatDateForFilename();
    const filename = `mac_result_${domain}_${dateStr}`;

    if (format === "json") {
      // Export every normalized result plus rawData (the complete response
      // bodies from the portal calls made for that saved result). Project the
      // job object explicitly so unrelated secrets such as the Home Assistant
      // bearer token are never included in the export.
      const fullExport = {
        exportedAt: new Date().toISOString(),
        job: {
          id: job.id,
          portalUrl: job.portalUrl,
          macPrefix: job.macPrefix,
          status: job.status,
          timeoutMs: job.timeoutMs,
          blockSize: job.blockSize,
          selectedFields: job.selectedFields,
          totalTested: job.totalTested,
          totalFound: job.totalFound,
          serverIp: job.serverIp,
          serverGeoRaw: job.serverGeoRaw,
          diagnostics: {
            pingMinMs: job.pingMinMs,
            pingAvgMs: job.pingAvgMs,
            pingMaxMs: job.pingMaxMs,
            pingStdevMs: job.pingStdevMs,
            pingFailurePct: job.pingLossPct,
            pingProbes: job.pingProbes,
            pingSuccessful: job.pingSuccessful,
            pingProbeMs: job.pingProbeMs,
            pingP50Ms: job.pingP50Ms,
            pingP95Ms: job.pingP95Ms,
            pingWindowMs: job.pingWindowMs,
            pingRtts: job.pingRtts,
            diagnosticsAt: job.diagnosticsAt,
            pingError: job.pingError,
            httpError: job.httpError,
            httpDnsMs: job.httpDnsMs,
            httpTcpMs: job.httpTcpMs,
            httpTlsMs: job.httpTlsMs,
            httpTtfbMs: job.httpTtfbMs,
            httpTotalMs: job.httpTotalMs,
            httpStatusCode: job.httpStatusCode,
          },
          filters: {
            genreFilterEnabled: job.genreFilterEnabled,
            genreFilterKeywords: job.genreFilterKeywords,
            genreFilterMatchLive: job.genreFilterMatchLive,
            genreFilterMatchVod: job.genreFilterMatchVod,
            genreFilterMatchSeries: job.genreFilterMatchSeries,
            expireFilterEnabled: job.expireFilterEnabled,
            expireFilterMinDate: job.expireFilterMinDate,
            expireFilterIncludeUnlimited: job.expireFilterIncludeUnlimited,
          },
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        },
        results: results.map((result) => ({
          ...result,
          qualityReport: getQualityReport(result),
        })),
      };

      return new NextResponse(JSON.stringify(fullExport, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}.json"`,
        },
      });
    }

    if (format === "csv") {
      const headers = selectedFields.map((f) => fieldMap[f] || f);
      const csvLines = [headers.join(",")];

      for (const result of results) {
        const values = selectedFields.map((f) => {
          const val = getFieldValue(result, f);
          // Escape CSV values
          return `"${val.replace(/"/g, '""')}"`;
        });
        csvLines.push(values.join(","));
      }

      const csvContent = csvLines.join("\n");

      return new NextResponse(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${filename}.csv"`,
        },
      });
    } else {
      // TXT format
      const txtLines: string[] = [];
      txtLines.push(`MacAttack Scan Results`);
      txtLines.push(`Portal: ${job.portalUrl}`);
      txtLines.push(`MAC Prefix: ${job.macPrefix}`);
      txtLines.push(`Date: ${new Date().toISOString()}`);
      txtLines.push(`Total Found: ${results.length}`);
      txtLines.push("=".repeat(80));
      txtLines.push("");

      for (const result of results) {
        for (const field of selectedFields) {
          const val = getFieldValue(result, field);
          if (val) {
            txtLines.push(`${fieldMap[field] || field}: ${val}`);
          }
        }
        txtLines.push("-".repeat(40));
        txtLines.push("");
      }

      const txtContent = txtLines.join("\n");

      return new NextResponse(txtContent, {
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": `attachment; filename="${filename}.txt"`,
        },
      });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to download",
      },
      { status: 500 }
    );
  }
}
