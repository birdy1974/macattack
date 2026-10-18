import { NextRequest, NextResponse } from "next/server";
import { readThumbnail } from "@/lib/thumbnail-store";

/**
 * Serve a captured stream thumbnail.
 *
 * Thumbnails live outside the source tree (MACATTACK_DATA_DIR, default
 * ./data/thumbnails) and file names are validated by the store, so a request
 * can never escape the thumbnail directory.
 */
export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const file = await readThumbnail(name);
  if (!file) {
    return NextResponse.json({ error: "Thumbnail not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(file), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(file.byteLength),
      // A new search clears frames; do not keep old captures in browser caches.
      "Cache-Control": "no-store",
    },
  });
}
