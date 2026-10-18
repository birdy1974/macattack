"use client";

import { summariseQualityDashboard, type DashboardResult } from "@/lib/quality-dashboard";

const bandStyles: Record<string, string> = {
  excellent: "bg-green-400", good: "bg-emerald-500", fair: "bg-yellow-400",
  poor: "bg-orange-500", unusable: "bg-red-500",
};
const score = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}/10`;

export function QualityDashboard({ results, running, enabled, onSelect }: {
  results: DashboardResult[];
  running: boolean;
  enabled: boolean;
  onSelect: (id: number) => void;
}) {
  const summary = summariseQualityDashboard(results);
  return (
    <section aria-label="Found MAC quality dashboard" className="rounded-xl border border-cyan-900/70 bg-gray-900 p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-cyan-200 uppercase tracking-wider">Found MAC quality</h2>
          <p className="text-xs text-gray-400 mt-1">{summary.completed}/{summary.found} addresses checked · {summary.scored} scored · {summary.unscored} checked without a score</p>
        </div>
        <span className={`rounded-full border px-2 py-1 text-xs ${running ? "border-cyan-800 text-cyan-300" : "border-gray-700 text-gray-400"}`}>
          {running ? "Live · refreshes every 1.5s" : "Latest scan snapshot"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([{ label: "Overall", value: summary.overall }, { label: "Speed", value: summary.speed }, { label: "Picture quality", value: summary.picture }, { label: "Stability", value: summary.stability }]).map(({ label, value }) => (
          <div key={label} className="rounded-lg bg-gray-950/60 border border-gray-800 p-3">
            <p className="text-xs text-gray-400">{label}</p>
            <p className="mt-1 text-xl font-semibold font-mono text-white">{score(value)}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-gray-400">
        <span>{summary.playable}/{summary.probed} sampled channels playable{summary.playablePercent === null ? "" : ` (${summary.playablePercent}%)`}</span>
        <span>Median first byte: {summary.firstByteMs === null ? "—" : `${summary.firstByteMs} ms`}</span>
        <span>{summary.pending} {enabled ? (running ? "awaiting measurement" : "not measured") : "not measured (checks off)"}</span>
      </div>
      <div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-gray-800" aria-hidden="true">
          {summary.bands.filter((band) => band.count > 0).map((band) => (
            <div key={band.verdict} className={bandStyles[band.verdict]} style={{ width: `${band.count / Math.max(summary.found, 1) * 100}%` }} />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-300">
          {summary.bands.map((band) => <span key={band.verdict} className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${bandStyles[band.verdict]}`} /><span className="capitalize">{band.verdict}</span> {band.count}</span>)}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-800 p-3 text-xs">
          <h3 className="font-semibold text-gray-200 mb-2">Picture warnings · addresses affected</h3>
          <p className={summary.frozen ? "text-red-300" : "text-gray-400"}>{summary.frozen} with frozen-picture evidence</p>
          <p className={summary.mislabeled ? "text-yellow-300" : "text-gray-400"}>{summary.mislabeled} with quality-label mismatches</p>
        </div>
        <div className="rounded-lg border border-gray-800 p-3 text-xs">
          <h3 className="font-semibold text-gray-200 mb-2">Catch-up spot checks · addresses</h3>
          <p className="text-purple-300">{summary.archivePlayable} archive media playable · {summary.archiveFailed} sampled checks failed</p>
          <p className="text-gray-400">{summary.archivePlayableChannels}/{summary.archiveAdvertisedChannels} advertised channel/account pairs have playable archive media</p>
          <p className="text-gray-400">{summary.archiveNotAdvertised} not advertised in fetched catalogue · {summary.archiveUnchecked} unchecked</p>
        </div>
      </div>
      {summary.top.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-300 mb-2">Highest measured quality</h3>
          <div className="space-y-1">
            {summary.top.map((result, index) => (
              <button key={result.id} type="button" onClick={() => onSelect(result.id)} className="w-full flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-950/40 px-3 py-2 text-xs hover:bg-cyan-950/40 focus-visible:outline-2 focus-visible:outline-cyan-400">
                <span className="font-mono text-gray-200">{index + 1}. {result.macAddress}</span>
                <span className="text-gray-400">{result.qualityResolution ?? "resolution unknown"} · <span className="text-cyan-200">{score(result.qualityScore ?? null)}</span> · view result →</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {summary.genres.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-300">Sampled genres · {summary.genres.length} shown</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {summary.genres.map((genre) => <div key={genre.title} className="rounded border border-gray-800 px-3 py-2"><p className="text-gray-200 truncate" title={genre.title}>{genre.title}</p><p className="text-gray-400 mt-1">{score(genre.score)} · {genre.playable}/{genre.probed} playable · {genre.samples} address samples</p></div>)}
          </div>
        </details>
      )}
      {summary.found === 0 && <p className="text-sm text-gray-400">Waiting for the first matching address. Quality appears as each media check finishes.</p>}
      <p className="text-xs text-gray-500">Scores average completed measurements only; missing scores are never treated as zero. Samples describe the scanner’s media path, not every channel or peak-hour playback. Catch-up media playback does not prove archive age or retention.{summary.lastMeasuredAt ? ` Last measurement: ${new Date(summary.lastMeasuredAt).toLocaleTimeString()}.` : ""}</p>
    </section>
  );
}
