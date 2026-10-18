/** Browser-safe formatting: do not import the server-side media probe here. */
import type { CatchUpVerification } from "@/lib/catchup-verification";

export function formatCatchUpInventory(report: CatchUpVerification | null | undefined): string {
  if (!report?.channels) return "No saved channel inventory — re-check catch-up";
  if (report.channels.length === 0) return "No archive channels advertised in fetched catalogue";
  return report.channels.map((c) => `${c.genreTitle} / ${c.channelName} [${c.channelId ?? c.key}]: ${c.status === "playable" ? "archive media playable" : c.status === "failed" ? "sampled checks failed" : "advertised, untested"}${c.advertisedDays === null ? "" : ` (${c.advertisedDays} days advertised)`}`).join("; ");
}
