import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { playlistTokens, scanResults } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";

/**
 * Stable subscription URLs for an M3U playlist.
 *
 *   POST   /api/scan/playlist-token  { resultId, limitCount? } → creates a token
 *   GET    /api/scan/playlist-token?resultId=42                → lists tokens
 *   DELETE /api/scan/playlist-token?token=…                    → revokes a token
 *
 * The token itself is then used with the normal playlist endpoint:
 *
 *   GET /api/scan/playlist?token=…  (stable URL, safe to paste into a player)
 *
 * Tokens are random, revocable and read-only; a player that polls the URL gets
 * freshly resolved links every time (Stalker links are short-lived, so a
 * pre-baked file would go stale).
 */

function newToken(): string {
  return randomBytes(18).toString("base64url");
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { resultId?: number; limitCount?: number };
    const resultId = Number(body.resultId);
    if (!Number.isSafeInteger(resultId) || resultId < 1) {
      return NextResponse.json({ error: "Valid resultId is required" }, { status: 400 });
    }

    const [result] = await db
      .select({ id: scanResults.id, macAddress: scanResults.macAddress })
      .from(scanResults)
      .where(eq(scanResults.id, resultId))
      .limit(1);
    if (!result) {
      return NextResponse.json({ error: "Result not found" }, { status: 404 });
    }

    const limitCount = Math.max(1, Math.min(Number(body.limitCount) || 200, 800));
    const [created] = await db
      .insert(playlistTokens)
      .values({ resultId, token: newToken(), limitCount })
      .returning();

    const path = `/api/scan/playlist?token=${created.token}`;
    return NextResponse.json({
      success: true,
      token: created,
      // Relative path plus an absolute URL when the request carried an origin
      // (works behind the NAS reverse proxy too).
      path,
      url: `${request.nextUrl.origin}${path}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create playlist token" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const resultId = Number(request.nextUrl.searchParams.get("resultId"));
    if (!Number.isSafeInteger(resultId) || resultId < 1) {
      return NextResponse.json({ error: "Valid resultId is required" }, { status: 400 });
    }

    const tokens = await db
      .select()
      .from(playlistTokens)
      .where(eq(playlistTokens.resultId, resultId))
      .orderBy(desc(playlistTokens.createdAt))
      .limit(50);

    return NextResponse.json({
      tokens: tokens.map((token) => ({
        ...token,
        path: `/api/scan/playlist?token=${token.token}`,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list playlist tokens" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get("token");
    if (!token) {
      return NextResponse.json({ error: "token is required" }, { status: 400 });
    }

    const updated = await db
      .update(playlistTokens)
      .set({ revoked: 1 })
      .where(and(eq(playlistTokens.token, token), eq(playlistTokens.revoked, 0)))
      .returning();

    return NextResponse.json({ success: true, revoked: updated.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to revoke playlist token" },
      { status: 500 }
    );
  }
}
