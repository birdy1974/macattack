import { NextRequest, NextResponse } from "next/server";
import { detectFfmpeg, resetFfmpegDetection } from "@/lib/ffmpeg-tools";
import { thumbnailStoreInfo } from "@/lib/thumbnail-store";

/**
 * Capability report for the dashboard. FFmpeg is included in the published
 * multi-architecture image. VAAPI remains optional and is only reported when
 * FFmpeg supports it and a Linux DRI device is accessible to this process.
 *
 * `GET /api/system?refresh=1` clears the cached detection result and probes
 * again, so fixing FFMPEG_PATH or pulling a newer image does not require an
 * app restart before the dashboard reflects it.
 */
export async function GET(request: NextRequest) {
  try {
    const refresh =
      request.nextUrl.searchParams.get("refresh") === "1" ||
      request.nextUrl.searchParams.get("force") === "1";
    if (refresh) resetFfmpegDetection();
    const ffmpeg = await detectFfmpeg(refresh);
    return NextResponse.json({
      ffmpeg: {
        available: ffmpeg.available,
        version: ffmpeg.version,
        reason: ffmpeg.reason,
        path: ffmpeg.path,
        triedPaths: ffmpeg.triedPaths,
        envOverride: "FFMPEG_PATH",
        envOverrideSet: Boolean(process.env.FFMPEG_PATH?.trim()),
        hardwareAcceleration: ffmpeg.hardwareAcceleration,
        hardwareDevice: ffmpeg.hardwareDevice,
        checkedAt: ffmpeg.checkedAt,
      },
      thumbnails: await thumbnailStoreInfo(),
      features: {
        pictureChecks: ffmpeg.available,
        thumbnails: ffmpeg.available,
        pictureChecksNote: ffmpeg.available
          ? "ffmpeg detected — freeze/black detection, FPS/bitrate profiling and thumbnails are enabled."
          : "ffmpeg not detected — streams are still measured for speed/stability/quality, but no picture analysis is possible.",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to detect capabilities" },
      { status: 500 }
    );
  }
}
