import { NextRequest, NextResponse } from "next/server";
import { checkXtreamAccountQuality } from "@/lib/xtream-quality";
import { parseXtreamUrl, xtreamAccount } from "@/lib/xtream-streams";

/**
 * Xtream Codes accounts (Wave 3 coverage).
 *
 *   GET  /api/scan/xtream?url=http://host:8080/get.php?username=…&password=…
 *        → account info only (login check)
 *   POST /api/scan/xtream { url, channels, sampleMs }
 *        → login + live stream sampling through the same probe engine
 *
 * Xtream accounts are a different protocol, not a MAC; the reply therefore
 * contains the account summary plus a probe report in the shared format.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") || "";
  const credentials = parseXtreamUrl(url);
  if (!credentials) {
    return NextResponse.json(
      { error: "Provide an Xtream URL containing username and password (player_api.php or get.php)" },
      { status: 400 }
    );
  }

  try {
    const login = await xtreamAccount(credentials, { timeoutMs: 8000 });
    return NextResponse.json({
      credentials: {
        base: credentials.base,
        username: credentials.username,
        endpoint: credentials.endpoint,
      },
      auth: login.auth,
      account: login.account,
      error: login.error,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Xtream login failed" },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      url?: string;
      channels?: number;
      sampleMs?: number;
      pictureChecks?: boolean;
      thumbnails?: boolean;
    };

    const credentials = parseXtreamUrl(body.url || "");
    if (!credentials) {
      return NextResponse.json(
        { error: "Provide an Xtream URL containing username and password (player_api.php or get.php)" },
        { status: 400 }
      );
    }

    const { report, account, error } = await checkXtreamAccountQuality({
      credentials,
      channelsToProbe: Math.max(1, Math.min(Number(body.channels) || 3, 8)),
      sampleMs: Math.max(3000, Math.min(Number(body.sampleMs) || 8000, 30000)),
      pictureChecks: body.pictureChecks !== false,
      thumbnails: body.thumbnails !== false,
    });

    if (!report) {
      return NextResponse.json({ error: error || "Xtream check failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true, account, report });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Xtream check failed" },
      { status: 500 }
    );
  }
}
