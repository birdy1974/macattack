import { NextResponse } from "next/server";
import { detectFfmpeg } from "@/lib/ffmpeg-tools";
import { thumbnailStoreInfo } from "@/lib/thumbnail-store";

/**
 * Capability report for the dashboard.
 *
 * Everything optional is detected at runtime, never bundled: the NAS/Pi image
 * must keep working when ffmpeg is absent, so the UI shows what is available
 * and labels the rest "not available on this host" instead of failing.
 */
export async function GET() {
  try {
    const ffmpeg = await detectFfmpeg();
    return NextResponse.json({
      ffmpeg: {
        available: ffmpeg.available,
        version: ffmpeg.version,
        reason: ffmpeg.reason,
        path: ffmpeg.path,
        envOverride: "FFMPEG_PATH",
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
