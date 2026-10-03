import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { playlistTokens, scanJobs, scanResults } from "@/db/schema";
import { validateStalkerPortal } from "@/lib/scanner";
import {
  buildM3U,
  stalkerHandshake,
  stalkerListChannels,
  stalkerResolveStream,
  type StalkerChannel,
} from "@/lib/stalker-streams";

/**
 * Stalker → M3U export for one validated MAC (the feature Flux-Stream made
 * popular). Lists the portal's channels, resolves playable URLs with
 * create_link and streams back an .m3u playlist.
 *
 *   GET /api/scan/playlist?resultId=42&limit=200
 *
 * Link resolution is capped and rate-limited so a big portal cannot hammer the
 * middleware from the NAS.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 800;
const CONCURRENCY = 5;

export async function GET(request: NextRequest) {
  let resultId = Number(request.nextUrl.searchParams.get("resultId"));
  const limitRaw = Number(request.nextUrl.searchParams.get("limit"));
  let limit = Math.max(1, Math.min(limitRaw || DEFAULT_LIMIT, MAX_LIMIT));

  // ── Stable subscription URL: ?token=… ───────────────────────────────
  // Tokens are created by /api/scan/playlist-token and can be revoked there.
  const token = request.nextUrl.searchParams.get("token");
  let tokenLimit: number | null = null;
  if (token) {
    const [row] = await db
      .select()
      .from(playlistTokens)
      .where(and(eq(playlistTokens.token, token), eq(playlistTokens.revoked, 0)))
      .limit(1);
    if (!row) {
      return new Response(JSON.stringify({ error: "Unknown or revoked playlist token" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    resultId = row.resultId;
    tokenLimit = row.limitCount;
    if (!Number.isFinite(limitRaw)) limit = row.limitCount;
    void db
      .update(playlistTokens)
      .set({ fetchCount: row.fetchCount + 1, lastFetchedAt: new Date() })
      .where(eq(playlistTokens.id, row.id))
      .catch(() => undefined);
  }

  if (!Number.isSafeInteger(resultId) || resultId < 1) {
    return new Response(JSON.stringify({ error: "Valid resultId or token is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (tokenLimit !== null) limit = Math.min(limit, tokenLimit);

  try {
    const [row] = await db
      .select({ result: scanResults, job: scanJobs })
      .from(scanResults)
      .innerJoin(scanJobs, eq(scanResults.jobId, scanJobs.id))
      .where(eq(scanResults.id, resultId))
      .limit(1);

    if (!row?.result || !row.job) {
      return new Response(JSON.stringify({ error: "Result not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const timeoutMs = Math.max(row.job.timeoutMs || 5000, 8000);
    let serverPath = row.result.stalkerServerPath;
    if (!serverPath) {
      const validation = await validateStalkerPortal(row.job.portalUrl, timeoutMs);
      serverPath = validation.valid ? validation.serverPath ?? null : null;
    }
    if (!serverPath) {
      return new Response(
        JSON.stringify({ error: "Could not resolve a Stalker endpoint for this portal" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    const portalBase = `${new URL(serverPath).origin}/c/`;

    const clientOptions = {
      serverPath,
      portalBase,
      mac: row.result.macAddress,
      timeoutMs,
    };

    const handshake = await stalkerHandshake(clientOptions);
    if (!handshake.token) {
      return new Response(
        JSON.stringify({ error: handshake.error || "Handshake failed" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const list = await stalkerListChannels(clientOptions, handshake.token, {
      maxChannels: limit,
      maxGenres: 20,
    });

    const resolved: Array<{ channel: StalkerChannel; url: string }> = [];
    const queue = [...list.channels.slice(0, limit)];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const channel = queue.shift();
        if (!channel) break;
        const link = await stalkerResolveStream(clientOptions, handshake.token as string, channel);
        if (link.url) resolved.push({ channel, url: link.url });
      }
    });
    await Promise.all(workers);

    // Keep the portal's original ordering (the parallel workers finish randomly).
    const order = new Map(list.channels.map((channel, index) => [channel.id || `${channel.name}|${channel.genreId}`, index]));
    resolved.sort(
      (a, b) =>
        (order.get(a.channel.id || `${a.channel.name}|${a.channel.genreId}`) ?? 0) -
        (order.get(b.channel.id || `${b.channel.name}|${b.channel.genreId}`) ?? 0)
    );

    const playlistName = `${row.result.macAddress} @ ${new URL(row.job.portalUrl).host}`;
    const body = buildM3U(resolved, playlistName);
    const filename = `macattack_${row.result.macAddress.replace(/:/g, "")}_${Date.now()}.m3u`;

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "audio/x-mpegurl; charset=utf-8",
        // A token URL is a subscription: let the player re-fetch it instead of
        // downloading a one-off file.
        "Content-Disposition": token
          ? "inline"
          : `attachment; filename="${filename}"`,
        "X-Channels-Listed": String(list.channels.length),
        "X-Channels-Playable": String(resolved.length),
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Playlist export failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
