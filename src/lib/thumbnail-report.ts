/**
 * Thumbnail capture bookkeeping shared by the Stalker and Xtream quality paths.
 *
 * A thumbnail that never appears on disk is impossible to debug from the scan
 * log today, so every capture records an outcome: the file name and directory
 * on success, or the concrete ffmpeg/storage reason on failure. The same
 * summary also detects an unusable data directory (a bind mount the app user
 * cannot write) and names the fallback directory the files actually went to.
 */

import { captureThumbnail } from "@/lib/ffmpeg-tools";
import {
  lastThumbnailWriteDir,
  saveThumbnail,
  thumbnailStoreError,
  thumbnailStoreInfo,
} from "@/lib/thumbnail-store";

export interface ThumbnailOutcome {
  channel: string;
  /** Stored file name when a frame was captured. */
  name: string | null;
  ok: boolean;
  /** Where it was written, or why it could not be captured. */
  detail: string;
}

export interface MacThumbnailReport {
  /** False when the scan was started with thumbnails switched off. */
  enabled: boolean;
  /** Directory the files were written to (null when nothing was captured). */
  dir: string | null;
  outcomes: ThumbnailOutcome[];
  /** Set when the configured directory is unusable (files went to the fallback). */
  storeWarning: string | null;
}

/**
 * Capture one frame and store it, returning the file name (or null) plus the
 * outcome to log. Never throws.
 */
export async function captureChannelThumbnail(params: {
  key: string;
  channel: string;
  url: string;
  userAgent?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ThumbnailOutcome> {
  const capture = await captureThumbnail(params.url, {
    userAgent: params.userAgent,
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? 20000,
  });

  if (!capture.ok || !capture.jpeg) {
    return {
      channel: params.channel,
      name: null,
      ok: false,
      detail: capture.error ?? "no frame captured",
    };
  }

  const name = await saveThumbnail(params.key, capture.jpeg);
  if (!name) {
    return {
      channel: params.channel,
      name: null,
      ok: false,
      detail: thumbnailStoreError() ?? "the JPEG could not be written to the data directory",
    };
  }

  return {
    channel: params.channel,
    name,
    ok: true,
    detail: `${name} in ${lastThumbnailWriteDir() ?? "the thumbnail directory"}`,
  };
}

/**
 * Summarise the outcomes and check where the files live. `attempted` is false
 * when thumbnails were switched off or ffmpeg is unavailable, so a report does
 * not promise files that were never captured.
 */
export async function summariseThumbnails(
  enabled: boolean,
  attempted: boolean,
  outcomes: ThumbnailOutcome[]
): Promise<MacThumbnailReport> {
  if (!attempted) {
    return { enabled, dir: null, outcomes, storeWarning: null };
  }

  const info = await thumbnailStoreInfo();
  const storeWarning = info.writable
    ? null
    : `${info.dir} is not writable by the app user (uid 1001) — thumbnails are written to ${info.fallbackDir} instead and are lost when the container is recreated` +
      (info.lastError ? ` (${info.lastError})` : "");

  return {
    enabled,
    dir: info.writable ? info.dir : info.fallbackDir,
    outcomes,
    storeWarning,
  };
}

/**
 * Scan-log lines describing the thumbnail captures: how many were saved and
 * where, and one warning per failure with the ffmpeg/storage reason.
 */
export function thumbnailLogLines(
  thumbnails: MacThumbnailReport
): Array<{ level: string; message: string }> {
  const lines: Array<{ level: string; message: string }> = [];
  const saved = thumbnails.outcomes.filter((outcome) => outcome.ok);
  const failed = thumbnails.outcomes.filter((outcome) => !outcome.ok);

  if (thumbnails.storeWarning) {
    lines.push({ level: "warning", message: `  ⚠ ${thumbnails.storeWarning}` });
  }

  if (!thumbnails.enabled) {
    lines.push({ level: "info", message: "Thumbnails are switched off for this scan" });
    return lines;
  }

  if (saved.length > 0) {
    lines.push({
      level: "success",
      message: `📸 Thumbnails saved: ${saved.length} → ${thumbnails.dir ?? "the thumbnail directory"}`,
    });
  }
  for (const outcome of failed.slice(0, 3)) {
    lines.push({ level: "warning", message: `  ⚠ No thumbnail for ${outcome.channel}: ${outcome.detail}` });
  }
  if (failed.length > 3) {
    lines.push({ level: "warning", message: `  ⚠ ${failed.length - 3} more channel(s) had no thumbnail` });
  }
  if (saved.length === 0 && failed.length === 0) {
    lines.push({ level: "info", message: "No thumbnail was attempted (no channel returned a playable link)" });
  }
  return lines;
}
