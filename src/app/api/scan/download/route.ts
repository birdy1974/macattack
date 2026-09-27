import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scanJobs, scanResults } from "@/db/schema";
import { eq } from "drizzle-orm";

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

    const fieldMap: Record<string, string> = {
      macAddress: "MAC Address",
      portalUrl: "Portal URL",
      expireDate: "Expire Date",
      serverLocation: "Server Location",
      tariffPlan: "Tariff Plan",
      maxConnections: "Max Connections",
      activeConnections: "Active Connections",
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
        case "tariffPlan":
          return result.tariffPlan || "";
        case "maxConnections":
          return result.maxConnections || "";
        case "activeConnections":
          return result.activeConnections || "";
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
