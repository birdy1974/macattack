/**
 * Honest, reproducible quality reporting for portal-scan results.
 *
 * This scanner checks the Stalker control/API path and account-validation
 * requests. It does not request a media playlist, download stream segments, or
 * render video. Consequently this report intentionally has no overall stream
 * quality score and always marks playback stability as not tested.
 */

export type PortalCheckStatus =
  | "response_received"
  | "http_status_issue"
  | "check_error"
  | "not_measured";

export interface QualityReport {
  version: 1;
  assessment: {
    status: "not_rated";
    label: "Stream quality not rated";
    explanation: string;
  };
  measuredAt: string | null;
  source: {
    vantagePoint: "scanner_host";
    label: "Scanner host → portal";
    target: string | null;
  };
  portal: {
    status: PortalCheckStatus;
    label: string;
    tcpConnect: {
      probes: number;
      successful: number | null;
      failed: number | null;
      failureRatePct: number | null;
      intervalMs: number | null;
      windowMs: number | null;
      windowEstimated: boolean;
      minMs: number | null;
      meanMs: number | null;
      medianMs: number | null;
      p95Ms: number | null;
      maxMs: number | null;
      standardDeviationMs: number | null;
      observationsMs: Array<number | null> | null;
      error: string | null;
    };
    http: {
      samples: number;
      label: string;
      statusCode: number | null;
      responseBodyInspected: false;
      dnsMs: number | null;
      tcpMs: number | null;
      tlsMs: number | null;
      ttfbMs: number | null;
      totalMs: number | null;
      error: string | null;
    };
  };
  accountCheck: {
    status: "observed" | "not_observed";
    description: string;
    handshakeMs: number | null;
    accountInfoMs: number | null;
    totalMs: number | null;
  };
  playback: {
    status: "not_tested";
    label: "Not tested";
    mediaRequests: 0;
    startupTimeMs: null;
    stallCount: null;
    stalledDurationMs: null;
    rebufferRatioPct: null;
    reason: string;
  };
  operatorTelemetry: {
    status: "not_available";
    label: "Not available";
    reason: string;
    metrics: null;
  };
  confidence: {
    level: "limited";
    label: string;
    tcpProbeCount: number;
    httpSampleCount: number;
    sampleWindowMs: number | null;
    explanation: string;
  };
  limitations: string[];
}

interface QualityJobSource {
  portalUrl: string;
  diagnosticsAt?: Date | string | null;
  pingMinMs?: number | null;
  pingAvgMs?: number | null;
  pingMaxMs?: number | null;
  pingStdevMs?: number | null;
  pingP50Ms?: number | null;
  pingP95Ms?: number | null;
  pingLossPct?: number | null;
  pingProbes?: number | null;
  pingSuccessful?: number | null;
  pingProbeMs?: number | null;
  pingWindowMs?: number | null;
  pingRtts?: Array<number | null> | null;
  pingError?: string | null;
  httpDnsMs?: number | null;
  httpTcpMs?: number | null;
  httpTlsMs?: number | null;
  httpTtfbMs?: number | null;
  httpTotalMs?: number | null;
  httpStatusCode?: number | null;
  httpError?: string | null;
}

interface QualityResultSource {
  responseTimeMs?: number | null;
  handshakeTimeMs?: number | null;
  accountInfoTimeMs?: number | null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function getTarget(portalUrl: string): string | null {
  try {
    const withProtocol = /^https?:\/\//i.test(portalUrl)
      ? portalUrl
      : `http://${portalUrl}`;
    const parsed = new URL(withProtocol);
    const defaultPort = parsed.protocol === "https:" ? "443" : "80";
    return `${parsed.hostname}:${parsed.port || defaultPort}`;
  } catch {
    return null;
  }
}

/**
 * Attach an explicit portal-vs-playback report to one saved result.
 * The shared portal measurements are from the scan job; the account request
 * timings are specific to this result's validated MAC.
 */
export function buildQualityReport(
  job: QualityJobSource,
  result: QualityResultSource
): QualityReport {
  const probes = Math.max(0, Math.floor(finiteNumber(job.pingProbes) ?? 0));
  const reportedSuccesses = finiteNumber(job.pingSuccessful);
  const failurePct = finiteNumber(job.pingLossPct);
  const successful =
    reportedSuccesses !== null
      ? Math.max(0, Math.min(probes, Math.floor(reportedSuccesses)))
      : probes > 0 && failurePct !== null
        ? Math.max(0, Math.min(probes, Math.round(probes * (1 - failurePct / 100))))
        : null;
  const failed = successful === null || probes === 0 ? null : probes - successful;
  const failureRatePct =
    probes > 0 && failed !== null ? Number(((failed / probes) * 100).toFixed(2)) : null;

  const intervalMs = finiteNumber(job.pingProbeMs);
  const reportedWindowMs = finiteNumber(job.pingWindowMs);
  const canEstimateWindow = probes > 0 && intervalMs !== null;
  const windowMs =
    reportedWindowMs ?? (canEstimateWindow ? intervalMs! * Math.max(0, probes - 1) : null);
  const windowEstimated = reportedWindowMs === null && windowMs !== null;

  const httpStatusCode = finiteNumber(job.httpStatusCode);
  const httpError = job.httpError || null;
  const hasHttpObservation = httpStatusCode !== null || httpError !== null;
  const isSuccessfulHttpResponse =
    !httpError && httpStatusCode !== null && httpStatusCode >= 200 && httpStatusCode < 300;
  const portalStatus: PortalCheckStatus = httpError
    ? "check_error"
    : httpStatusCode === null
      ? hasHttpObservation
        ? "check_error"
        : "not_measured"
      : isSuccessfulHttpResponse
        ? "response_received"
        : "http_status_issue";
  const httpLabel = httpError
    ? "HTTP probe failed"
    : httpStatusCode === null
      ? "No HTTP response recorded"
      : httpStatusCode >= 200 && httpStatusCode < 300
        ? `HTTP ${httpStatusCode} responded`
        : httpStatusCode < 400
          ? `HTTP ${httpStatusCode} redirect response`
          : `HTTP ${httpStatusCode} response`;
  const portalLabel =
    portalStatus === "response_received"
      ? "Portal HTTP endpoint responded"
      : portalStatus === "http_status_issue"
        ? `Portal returned ${httpStatusCode !== null && httpStatusCode >= 300 && httpStatusCode < 400 ? "a redirect" : `HTTP ${httpStatusCode}`}`
        : portalStatus === "check_error"
          ? "Portal HTTP check failed"
          : "Portal HTTP check not measured";

  const httpSamples = hasHttpObservation || job.diagnosticsAt ? 1 : 0;
  const resultTimeMs = finiteNumber(result.responseTimeMs);
  const handshakeMs = finiteNumber(result.handshakeTimeMs);
  const accountInfoMs = finiteNumber(result.accountInfoTimeMs);
  const sampleCountLabel = [
    probes > 0 ? `${probes} TCP` : null,
    httpSamples > 0 ? `${httpSamples} HTTP` : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return {
    version: 1,
    assessment: {
      status: "not_rated",
      label: "Stream quality not rated",
      explanation:
        "Only portal/control-API connectivity and account-request timing were measured. No media stream was played, so freeze/stall likelihood cannot be scored.",
    },
    measuredAt: toIsoString(job.diagnosticsAt),
    source: {
      vantagePoint: "scanner_host",
      label: "Scanner host → portal",
      target: getTarget(job.portalUrl),
    },
    portal: {
      status: portalStatus,
      label: portalLabel,
      tcpConnect: {
        probes,
        successful,
        failed,
        failureRatePct,
        intervalMs,
        windowMs,
        windowEstimated,
        minMs: finiteNumber(job.pingMinMs),
        meanMs: finiteNumber(job.pingAvgMs),
        medianMs: finiteNumber(job.pingP50Ms),
        p95Ms: finiteNumber(job.pingP95Ms),
        maxMs: finiteNumber(job.pingMaxMs),
        standardDeviationMs: finiteNumber(job.pingStdevMs),
        observationsMs: Array.isArray(job.pingRtts)
          ? job.pingRtts.map((value) => finiteNumber(value))
          : null,
        error: job.pingError || null,
      },
      http: {
        samples: httpSamples,
        label: httpLabel,
        statusCode: httpStatusCode,
        responseBodyInspected: false,
        dnsMs: finiteNumber(job.httpDnsMs),
        tcpMs: finiteNumber(job.httpTcpMs),
        tlsMs: finiteNumber(job.httpTlsMs),
        ttfbMs: finiteNumber(job.httpTtfbMs),
        totalMs: finiteNumber(job.httpTotalMs),
        error: httpError,
      },
    },
    accountCheck: {
      status: resultTimeMs === null ? "not_observed" : "observed",
      description: "This result's Stalker handshake + account_info request; not video startup time.",
      handshakeMs,
      accountInfoMs,
      totalMs: resultTimeMs,
    },
    playback: {
      status: "not_tested",
      label: "Not tested",
      mediaRequests: 0,
      startupTimeMs: null,
      stallCount: null,
      stalledDurationMs: null,
      rebufferRatioPct: null,
      reason:
        "The scanner does not request or play a channel/VOD stream. Playback start time, buffer health, freezes, and player errors are unknown.",
    },
    operatorTelemetry: {
      status: "not_available",
      label: "Not available",
      reason:
        "This portal scan has no operator/admin access to source-stream errors, server load, egress capacity, or active-client telemetry.",
      metrics: null,
    },
    confidence: {
      level: "limited",
      label: "Limited — portal-only spot check",
      tcpProbeCount: probes,
      httpSampleCount: httpSamples,
      sampleWindowMs: windowMs,
      explanation:
        `${sampleCountLabel || "No successful diagnostic samples recorded"} from the scanner host` +
        (windowMs !== null ? ` over approximately ${(windowMs / 1000).toFixed(1)} seconds` : "") +
        ". This is a short, single-time snapshot—not a prediction of future playback.",
    },
    limitations: [
      "The media server/CDN and channel path may differ from the Stalker portal host.",
      "Measurements originate from the scanner server/container, not the viewer's device, Wi-Fi, or ISP route.",
      "TCP connect failures are not the same as media-packet loss or RTP jitter; a successful connect does not prove sustained throughput.",
      "The HTTP timing probe records status and timings only; it does not inspect or validate the handshake response body.",
      "One HTTP timing request and a short TCP probe window cannot reveal peak-hour congestion or future outages.",
      "A real playback test is required to measure startup delay, stalls/rebuffering, delivered bitrate, and playback errors.",
      "Operator-side source health, server load, egress capacity, and active-client telemetry are not available to this portal scanner.",
    ],
  };
}
