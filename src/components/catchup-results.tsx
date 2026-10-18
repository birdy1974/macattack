"use client";

import type { CatchUpVerification } from "@/lib/catchup-verification";

export function CatchUpResults({ report, busy = false, error, onCheck }: {
  report?: CatchUpVerification | null;
  busy?: boolean;
  error?: string | null;
  onCheck?: (channelKey?: string) => void;
}) {
  const channels = report?.channels;
  const playable = channels?.filter((c) => c.status === "playable").length ?? 0;
  const failed = channels?.filter((c) => c.status === "failed").length ?? 0;
  const untested = channels?.filter((c) => c.status === "untested").length ?? 0;
  return (
    <section aria-label="Saved catch-up channels and genres" className="rounded-lg border border-purple-900/60 bg-purple-950/10 p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-purple-200">Saved catch-up availability · channels &amp; genres</h3>
          {channels && <p className="text-xs text-gray-400 mt-1">{channels.length} advertised · {playable} archive media playable · {failed} sampled checks failed · {untested} untested</p>}
        </div>
        {onCheck && <button type="button" disabled={busy} onClick={() => onCheck()} className="rounded border border-purple-800 px-2 py-1 text-xs text-purple-200 hover:bg-purple-950/50 disabled:opacity-50">
          {busy ? "Checking & saving…" : !channels ? "Discover & check catch-up" : untested ? "Check next 3 untested channels" : "Re-check archive sample"}
        </button>}
      </div>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {!channels && <p className="text-xs text-gray-400">No channel inventory was saved by this older result. Discover catch-up to save the advertised channels and test their archive media.</p>}
      {channels?.length === 0 && <p className="text-xs text-gray-400">No archive-enabled channel was advertised in the fetched catalogue. This is not a full-provider capability guarantee.</p>}
      {report?.genres?.map((genre, index) => (
        <details key={genre.genreId ?? "unknown"} open={index === 0} className="rounded border border-gray-800 p-2">
          <summary className="cursor-pointer text-xs text-gray-300">
            <span className="font-semibold text-purple-100">{genre.genreTitle}</span> · {genre.playableChannels} playable / {genre.advertisedChannels} advertised · {genre.failedChannels} failed · {genre.untestedChannels} untested
          </summary>
          <div className="mt-2 max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-gray-500 text-left"><th className="p-1">Channel</th><th className="p-1">Archive result</th><th className="p-1">Advertised retention</th><th className="p-1">Last check</th>{onCheck && <th className="p-1">Test</th>}</tr></thead>
              <tbody className="divide-y divide-gray-800/60">
                {channels?.filter((c) => c.genreId === genre.genreId).map((channel) => (
                  <tr key={channel.key}>
                    <td className="p-1 text-gray-200"><p>{channel.channelName}</p><p className="text-gray-500">ID: {channel.channelId ?? "not supplied"}</p></td>
                    <td className={`p-1 ${channel.status === "playable" ? "text-green-300" : channel.status === "failed" ? "text-orange-300" : "text-gray-400"}`}>
                      {channel.status === "playable" ? "Archive media playable" : channel.status === "failed" ? "Sampled checks failed" : "Advertised, untested"}
                      {channel.status === "failed" && <p className="text-gray-500 mt-0.5 max-w-64">{channel.attempts.at(-1)?.error ?? "No archive media"}</p>}
                      {channel.status === "playable" && <p className="text-gray-500 mt-0.5">{channel.attempts.find((a) => a.playable)?.method}</p>}
                    </td>
                    <td className="p-1 text-gray-400">{channel.advertisedDays === null ? "Unknown" : `${Number(channel.advertisedDays.toFixed(2))} days`}</td>
                    <td className="p-1 text-gray-500">{channel.checkedAt ? new Date(channel.checkedAt).toLocaleString() : "Not tested"}</td>
                    {onCheck && <td className="p-1"><button type="button" disabled={busy} onClick={() => onCheck(channel.key)} aria-label={`Check catch-up for ${channel.channelName} (${channel.channelId ?? channel.key})`} className="rounded border border-purple-900 px-2 py-1 text-purple-200 disabled:opacity-50">{channel.checkedAt ? "Re-check" : "Check"}</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      <p className="text-xs text-gray-500">These results belong to this saved account/MAC. Only channels marked playable returned media from an archive-specific request. Untested channels are not confirmed. A working channel does not confirm the entire genre, historical content, or full retention. Additional checks are saved cumulatively without rerunning live quality tests.</p>
    </section>
  );
}
