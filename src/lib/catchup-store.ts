/** Keep archive evidence durable across live-only monitors and targeted rechecks. */
import { db, ensureMigrations } from "@/db";
import { scanResults } from "@/db/schema";
import { eq } from "drizzle-orm";
import { catchUpFromReport, mergeCatchUpVerification, type CatchUpVerification } from "@/lib/catchup-verification";
import type { MacStreamQualityReport } from "@/lib/mac-quality";

/** Save a full quality run, merging archive evidence under a short row lock. */
export async function saveQualityWithCatchUp(resultId: number, report: MacStreamQualityReport,
  values: Partial<typeof scanResults.$inferInsert>) {
  await ensureMigrations();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ summary: scanResults.qualityCatchUpSummary, report: scanResults.qualityReport })
      .from(scanResults).where(eq(scanResults.id, resultId)).for("update");
    if (!row) throw new Error("Result no longer exists");
    const catchUp = mergeCatchUpVerification(row.summary ?? catchUpFromReport(row.report), report.catchUp);
    const qualityReport = { ...report, catchUp };
    await tx.update(scanResults).set({ ...values, qualityReport,
      qualityCatchUpSummary: catchUp, qualityCatchUpStatus: catchUp.status,
    }).where(eq(scanResults.id, resultId));
    return { qualityReport, qualityCatchUpSummary: catchUp, qualityCatchUpStatus: catchUp.status };
  });
}

/** Archive-only updates must not erase the stream quality scores or report. */
export async function saveCatchUpCheck(resultId: number, incoming: CatchUpVerification) {
  await ensureMigrations();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ summary: scanResults.qualityCatchUpSummary, report: scanResults.qualityReport })
      .from(scanResults).where(eq(scanResults.id, resultId)).for("update");
    if (!row) throw new Error("Result no longer exists");
    const catchUp = mergeCatchUpVerification(row.summary ?? catchUpFromReport(row.report), incoming);
    const qualityReport = row.report && typeof row.report === "object" && !Array.isArray(row.report)
      ? { ...row.report, catchUp } : row.report;
    await tx.update(scanResults).set({ qualityCatchUpSummary: catchUp,
      qualityCatchUpStatus: catchUp.status, qualityCatchUpDays: null, qualityReport,
    }).where(eq(scanResults.id, resultId));
    return catchUp;
  });
}
