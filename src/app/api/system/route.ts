import { NextResponse } from "next/server";
import { detectFfmpeg } from "@/lib/ffmpeg-tools";
import { thumbnailStoreInfo } from "@/lib/thumbnail-store";

/**
 * Capability report for the dashboard. FFmpeg is included in the published
 * multi-architecture image. VAAPI remains optional and is only reported when
 * FFmpeg supports it and a Linux DRI device is accessible to this process.
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
        hardwareAcceleration: ffmpeg.hardwareAcceleration,
        hardwareDevice: ffmpeg.hardwareDevice,
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
