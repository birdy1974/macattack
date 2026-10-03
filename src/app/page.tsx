"use client";

import { Fragment, useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import {
  DEFAULT_WEEK_SCHEDULE,
  WEEKDAYS,
  type ScheduleSettings,
} from "@/lib/schedule";
import { BRAND_IMAGE_URL } from "@/lib/branding";
import { buildQualityReport, type QualityReport } from "@/lib/quality-report";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ScanJob {
  id: number;
  portalUrl: string;
  macPrefix: string;
  status: string;
  timeoutMs: number;
  outputFilename: string;
  selectedFields: string[];
  totalTested: number;
  totalFound: number;
  currentMac: string | null;
  haUrl: string | null;
  haToken: string | null;
  haEntityId: string | null;
  blockSize: number;
  // Server diagnostics
  pingMinMs: number | null;
  pingAvgMs: number | null;
  pingMaxMs: number | null;
  pingStdevMs: number | null;
  pingLossPct: number | null;
  pingProbes: number | null;
  pingSuccessful: number | null;
  pingProbeMs: number | null;
  pingP50Ms: number | null;
  pingP95Ms: number | null;
  pingWindowMs: number | null;
  pingRtts: Array<number | null> | null;
  diagnosticsAt: string | null;
  pingError: string | null;
  httpError: string | null;
  httpDnsMs: number | null;
  httpTcpMs: number | null;
  httpTlsMs: number | null;
  httpTtfbMs: number | null;
  httpTotalMs: number | null;
  httpStatusCode: number | null;
  serverIp: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScanResult {
  id: number;
  jobId: number;
  macAddress: string;
  portalUrl: string;
  expireDate: string | null;
  serverLocation: string | null;
  tariffPlan: string | null;
  maxConnections: string | null;
  activeConnections: string | null;
  accountStatus: string | null;
  phoneNumber: string | null;
  responseTimeMs: number | null;
  handshakeTimeMs: number | null;
  accountInfoTimeMs: number | null;
  qualityReport: QualityReport | null;
  timezone: string | null;
  portalOnline: string | null;
  lastActive: string | null;
  username: string | null;
  password: string | null;
  playlistGenres: string | null;
  vodCategories: string | null;
  createdAt: string | null;
  foundAt: string;
}

interface LogEntry {
  id: number;
  jobId: number;
  level: string;
  message: string;
  createdAt: string;
}

interface HASettings {
  haUrl: string;
  haToken: string;
  haEntityId: string;
}

// ============================================================================
// AVAILABLE OUTPUT FIELDS
// ============================================================================

const AVAILABLE_FIELDS = [
  { key: "macAddress", label: "MAC Address", default: true },
  { key: "portalUrl", label: "Portal URL", default: true },
  { key: "expireDate", label: "Expire Date", default: true },
  { key: "serverLocation", label: "Server Location", default: true },
  { key: "responseTimeMs", label: "Portal Check Response (ms)", default: true },
  { key: "portalCheckStatus", label: "Portal Check Status", default: true },
  { key: "playbackStability", label: "Playback Stability", default: true },
  { key: "qualityConfidence", label: "Quality Test Scope/Confidence", default: false },
  { key: "handshakeTimeMs", label: "Portal Handshake (ms)", default: false },
  { key: "accountInfoTimeMs", label: "Account Info Request (ms)", default: false },
  { key: "qualityReport", label: "Detailed Quality Report (JSON)", default: false },
  { key: "tariffPlan", label: "Tariff Plan", default: true },
  { key: "maxConnections", label: "Max Connections", default: true },
  { key: "activeConnections", label: "Active Connections", default: true },
  { key: "portalOnline", label: "Portal Online State", default: true },
  { key: "lastActive", label: "Last Active", default: true },
  { key: "accountStatus", label: "Account Status", default: true },
  { key: "phoneNumber", label: "Phone Number", default: false },
  { key: "timezone", label: "Portal/Device Timezone", default: true },
  { key: "username", label: "Username", default: true },
  { key: "password", label: "Password", default: true },
  { key: "playlistGenres", label: "Playlist/Genres", default: false },
  { key: "vodCategories", label: "VOD Categories", default: false },
  { key: "createdAt", label: "Created At", default: true },
];

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function MacAttackPage() {
  // ========================================================================
  // STATE: Form inputs
  // ========================================================================
  const [portalUrl, setPortalUrl] = useState("");
  const [macPrefix, setMacPrefix] = useState("00:1A:79");
  const [timeoutMs, setTimeoutMs] = useState(5000);
  const [selectedFields, setSelectedFields] = useState<string[]>(
    AVAILABLE_FIELDS.filter((f) => f.default).map((f) => f.key)
  );
  const [skipVerification, setSkipVerification] = useState(false);
  const [blockSize, setBlockSize] = useState(8000);

  // ========================================================================
  // STATE: Filters
  // ========================================================================
  const [genreFilterEnabled, setGenreFilterEnabled] = useState(false);
  const [genreFilterKeywords, setGenreFilterKeywords] = useState(
    "nl, netherlands, dutch, ned, nederland"
  );
  const [genreMatchLive, setGenreMatchLive] = useState(true);
  const [genreMatchVod, setGenreMatchVod] = useState(true);
  const [genreMatchSeries, setGenreMatchSeries] = useState(true);
  const [expireFilterEnabled, setExpireFilterEnabled] = useState(false);
  const [expireMinDate, setExpireMinDate] = useState<string>("");
  const [expireIncludeUnlimited, setExpireIncludeUnlimited] = useState(true);

  // ========================================================================
  // STATE: Home Assistant
  // ========================================================================
  const [haEntityId, setHaEntityId] = useState("");
  const [showHASettings, setShowHASettings] = useState(false);
  const [haSettings, setHaSettings] = useState<HASettings>({
    haUrl: "",
    haToken: "",
    haEntityId: "",
  });
  const [haTestResult, setHaTestResult] = useState<{
    success?: boolean;
    message?: string;
    error?: string;
  } | null>(null);
  const [haSaving, setHaSaving] = useState(false);
  const [showScheduleSettings, setShowScheduleSettings] = useState(false);
  const [scheduleSettings, setScheduleSettings] = useState<ScheduleSettings>({
    enabled: false,
    timezone: "UTC",
    days: DEFAULT_WEEK_SCHEDULE,
  });
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{
    success?: boolean;
    message?: string;
    error?: string;
  } | null>(null);

  // ========================================================================
  // STATE: Scan status
  // ========================================================================
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [job, setJob] = useState<ScanJob | null>(null);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [expandedResultId, setExpandedResultId] = useState<number | null>(null);
  const [expandedQualityId, setExpandedQualityId] = useState<number | null>(null);
  const [rawDataByResult, setRawDataByResult] = useState<Record<number, unknown>>({});
  const [rawDataLoadingId, setRawDataLoadingId] = useState<number | null>(null);
  const [rawDataError, setRawDataError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(true);

  // ========================================================================
  // STATE: Log filtering
  // ========================================================================
  const [logFilters, setLogFilters] = useState({
    info: true,
    success: true,
    warning: true,
    error: true,
  });

  // ========================================================================
  // STATE: History
  // ========================================================================
  const [history, setHistory] = useState<ScanJob[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // ========================================================================
  // REFS
  // ========================================================================
  const logContainerRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ========================================================================
  // FUNCTIONS: Data loading
  // ========================================================================

  const loadHASettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = (await res.json()) as HASettings & {
          scheduleEnabled: boolean;
          scheduleTimezone: string;
          scheduleDays: ScheduleSettings["days"];
        };
        setHaSettings({
          haUrl: data.haUrl,
          haToken: data.haToken,
          haEntityId: data.haEntityId,
        });
        setScheduleSettings({
          enabled: data.scheduleEnabled,
          timezone: data.scheduleTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          days: data.scheduleDays,
        });
        setHaEntityId((current) => current || data.haEntityId);
      }
    } catch {
      // ignore
    }
  }, []);

  // ========================================================================
  // EFFECTS: Initial load
  // ========================================================================

  // Check for active scan on page load
  useEffect(() => {
    const checkActiveScan = async () => {
      setIsReconnecting(true);
      try {
        const res = await fetch("/api/scan/active");
        if (res.ok) {
          const data = (await res.json()) as { active: boolean; job: ScanJob | null };
          if (data.job) {
            setActiveJobId(data.job.id);
            setJob(data.job);
            setPortalUrl(data.job.portalUrl);
            setMacPrefix(data.job.macPrefix);
            setTimeoutMs(data.job.timeoutMs);
            if (data.job.selectedFields) {
              setSelectedFields(data.job.selectedFields);
            }
            if (data.job.haEntityId) {
              setHaEntityId(data.job.haEntityId);
            }
            if (data.job.blockSize) {
              setBlockSize(data.job.blockSize);
            }
            // Restore filter state from the running/completed job so the UI
            // reflects what was actually used during the scan.
            const j = data.job as ScanJob & {
              genreFilterEnabled?: number | boolean;
              genreFilterKeywords?: string;
              genreFilterMatchLive?: number | boolean;
              genreFilterMatchVod?: number | boolean;
              genreFilterMatchSeries?: number | boolean;
              expireFilterEnabled?: number | boolean;
              expireFilterMinDate?: string | null;
              expireFilterIncludeUnlimited?: number | boolean;
            };
            if (j.genreFilterEnabled !== undefined) {
              setGenreFilterEnabled(Boolean(j.genreFilterEnabled));
              if (j.genreFilterKeywords) setGenreFilterKeywords(j.genreFilterKeywords);
              setGenreMatchLive(j.genreFilterMatchLive !== 0 && j.genreFilterMatchLive !== false);
              setGenreMatchVod(j.genreFilterMatchVod !== 0 && j.genreFilterMatchVod !== false);
              setGenreMatchSeries(j.genreFilterMatchSeries !== 0 && j.genreFilterMatchSeries !== false);
            }
            if (j.expireFilterEnabled !== undefined) {
              setExpireFilterEnabled(Boolean(j.expireFilterEnabled));
              if (j.expireFilterMinDate) setExpireMinDate(j.expireFilterMinDate);
              setExpireIncludeUnlimited(j.expireFilterIncludeUnlimited !== 0 && j.expireFilterIncludeUnlimited !== false);
            }
          }
        }
      } catch {
        // Ignore errors on initial load
      } finally {
        setIsReconnecting(false);
      }
    };
    
    checkActiveScan();
    const settingsTimer = setTimeout(() => { void loadHASettings(); }, 0);
    return () => clearTimeout(settingsTimer);
  }, [loadHASettings]);

  // Poll for scan status updates
  const pollStatus = useCallback(async () => {
    if (!activeJobId) return;
    try {
      const res = await fetch(`/api/scan/status?jobId=${activeJobId}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        job: ScanJob;
        results: Omit<ScanResult, "qualityReport">[];
        logs: LogEntry[];
      };
      setJob(data.job);
      // Build the verbose report in the browser from compact job/result fields.
      // The polling API stays lean instead of repeating shared diagnostics for
      // every result row on every 1.5-second refresh.
      setResults(data.results.map((result) => ({
        ...result,
        qualityReport: buildQualityReport(data.job, result),
      })));
      setLogs(data.logs);

      // Stop polling if scan is done
      if (
        data.job.status === "completed" ||
        data.job.status === "paused" ||
        data.job.status === "error"
      ) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      }
    } catch {
      // ignore
    }
  }, [activeJobId]);

  // Start polling when we have an active job
  useEffect(() => {
    if (activeJobId) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      pollIntervalRef.current = setInterval(pollStatus, 1500);
      const initialPoll = setTimeout(() => { void pollStatus(); }, 0);
      return () => {
        clearTimeout(initialPoll);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      };
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [activeJobId, pollStatus]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, logFilters]);

  const loadHistory = async () => {
    try {
      const res = await fetch("/api/scan/history");
      if (res.ok) {
        const data = (await res.json()) as { jobs: ScanJob[] };
        setHistory(data.jobs);
      }
    } catch {
      // ignore
    }
  };

  // ========================================================================
  // FUNCTIONS: Scan control
  // ========================================================================

  const handleStart = async () => {
    if (!portalUrl.trim()) {
      setError("Please enter a portal URL");
      return;
    }

    setError(null);
    setIsLoading(true);
    setResults([]);
    setLogs([]);
    setJob(null);

    try {
      const res = await fetch("/api/scan/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portalUrl: portalUrl.trim(),
          macPrefix: macPrefix.trim(),
          timeoutMs,
          selectedFields,
          haUrl: haSettings.haUrl,
          haToken: haSettings.haToken,
          haEntityId: haEntityId || haSettings.haEntityId,
          skipVerification,
          blockSize,
          // Filters
          genreFilterEnabled,
          genreFilterKeywords: genreFilterEnabled
            ? genreFilterKeywords
            : "",
          genreFilterMatchLive: genreMatchLive,
          genreFilterMatchVod: genreMatchVod,
          genreFilterMatchSeries: genreMatchSeries,
          expireFilterEnabled,
          expireFilterMinDate: expireFilterEnabled ? expireMinDate || null : null,
          expireFilterIncludeUnlimited: expireIncludeUnlimited,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        jobId?: number;
        error?: string;
      };

      if (!res.ok || !data.success) {
        setError(data.error || "Failed to start scan");
        return;
      }

      setActiveJobId(data.jobId!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start scan");
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = async () => {
    if (!activeJobId) return;
    setIsLoading(true);
    try {
      await fetch("/api/scan/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: activeJobId }),
      });
      await pollStatus();
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  };

  const toggleRawData = async (resultId: number) => {
    if (expandedResultId === resultId) {
      setExpandedResultId(null);
      setRawDataError(null);
      return;
    }

    setExpandedResultId(resultId);
    setRawDataError(null);
    if (Object.prototype.hasOwnProperty.call(rawDataByResult, resultId)) return;
    if (!activeJobId) return;

    setRawDataLoadingId(resultId);
    try {
      const response = await fetch(
        `/api/scan/result-data?jobId=${activeJobId}&resultId=${resultId}`
      );
      const payload = (await response.json()) as {
        rawData?: unknown;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Failed to load raw data");
      setRawDataByResult((current) => ({ ...current, [resultId]: payload.rawData ?? null }));
    } catch (err) {
      setRawDataError(err instanceof Error ? err.message : "Failed to load raw data");
    } finally {
      setRawDataLoadingId(null);
    }
  };

  const handleDownload = (format: "csv" | "txt" | "json") => {
    if (!activeJobId) return;
    window.open(
      `/api/scan/download?jobId=${activeJobId}&format=${format}`,
      "_blank"
    );
  };

  // ========================================================================
  // FUNCTIONS: Field selection
  // ========================================================================

  const toggleField = (key: string) => {
    setSelectedFields((prev) =>
      prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]
    );
  };

  const selectAllFields = () => {
    setSelectedFields(AVAILABLE_FIELDS.map((f) => f.key));
  };

  const deselectAllFields = () => {
    setSelectedFields(["macAddress"]);
  };

  // ========================================================================
  // FUNCTIONS: Home Assistant
  // ========================================================================

  const handleSaveHASettings = async () => {
    setHaSaving(true);
    setHaTestResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(haSettings),
      });
      if (res.ok) {
        setHaTestResult({ success: true, message: "Settings saved successfully" });
      } else {
        const data = (await res.json()) as { error?: string };
        setHaTestResult({ error: data.error || "Failed to save settings" });
      }
    } catch (err) {
      setHaTestResult({ error: err instanceof Error ? err.message : "Failed to save" });
    } finally {
      setHaSaving(false);
    }
  };

  const handleSaveSchedule = async () => {
    setScheduleSaving(true);
    setScheduleResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleEnabled: scheduleSettings.enabled,
          scheduleTimezone: scheduleSettings.timezone,
          scheduleDays: scheduleSettings.days,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        setScheduleResult({ error: data.error || "Failed to save schedule" });
      } else {
        setScheduleResult({ success: true, message: "Schedule saved successfully" });
      }
    } catch (err) {
      setScheduleResult({ error: err instanceof Error ? err.message : "Failed to save schedule" });
    } finally {
      setScheduleSaving(false);
    }
  };

  const handleTestHA = async () => {
    setHaSaving(true);
    setHaTestResult(null);
    try {
      const res = await fetch("/api/settings/test-ha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(haSettings),
      });
      const data = (await res.json()) as { success?: boolean; message?: string; error?: string };
      setHaTestResult(data);
    } catch (err) {
      setHaTestResult({ error: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setHaSaving(false);
    }
  };

  // ========================================================================
  // COMPUTED VALUES
  // ========================================================================

  const isRunning = job?.status === "running";
  const isScheduledPaused = job?.status === "scheduled_paused";
  const isStopped =
    !job ||
    job.status === "completed" ||
    job.status === "paused" ||
    job.status === "error";

  // Distribution of real account-validation request times for saved results.
  // These are portal API timings, not playback-start measurements.
  const accountResponseSamples = results
    .map((result) => result.responseTimeMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const responsePercentile = (fraction: number): number | null => {
    if (accountResponseSamples.length === 0) return null;
    const position = fraction * (accountResponseSamples.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return accountResponseSamples[lower] +
      (accountResponseSamples[upper] - accountResponseSamples[lower]) * (position - lower);
  };
  const accountResponseSummary = {
    count: accountResponseSamples.length,
    min: accountResponseSamples[0] ?? null,
    median: responsePercentile(0.5),
    p95: responsePercentile(0.95),
    max: accountResponseSamples[accountResponseSamples.length - 1] ?? null,
  };

  // Filter logs based on selected log levels
  const filteredLogs = logs.filter((log) => {
    return logFilters[log.level as keyof typeof logFilters] ?? true;
  });

  // ========================================================================
  // HELPER FUNCTIONS
  // ========================================================================

  const getStatusColor = (status: string) => {
    switch (status) {
      case "running":
        return "text-cyan-400";
      case "completed":
        return "text-green-400";
      case "paused":
      case "scheduled_paused":
        return "text-yellow-400";
      case "error":
        return "text-red-400";
      default:
        return "text-gray-400";
    }
  };

  const getLogColor = (level: string) => {
    switch (level) {
      case "success":
        return "text-green-400";
      case "warning":
        return "text-yellow-400";
      case "error":
        return "text-red-400";
      default:
        return "text-gray-300";
    }
  };

  const getLogIcon = (level: string) => {
    switch (level) {
      case "success":
        return "✅";
      case "warning":
        return "⚠️";
      case "error":
        return "❌";
      default:
        return "ℹ️";
    }
  };

  const getFieldValue = (result: ScanResult, field: string): string => {
    const report = result.qualityReport;
    if (field === "portalCheckStatus") {
      return report?.portal.label ?? "Portal check not available";
    }
    if (field === "playbackStability") {
      return report?.playback.label ?? "Not tested";
    }
    if (field === "qualityConfidence") {
      return report?.confidence.label ?? "Limited — portal-only spot check";
    }
    if (field === "qualityReport") {
      return report ? JSON.stringify(report) : "—";
    }

    const value = result[field as keyof ScanResult];
    if (value === null || value === undefined || value === "") return "—";
    if (["responseTimeMs", "handshakeTimeMs", "accountInfoTimeMs"].includes(field)) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      return `${Math.round(n)} ms`;
    }
    return String(value);
  };

  /** Format a ms value for display, returns "—" if null/undefined. */
  const fmtMs = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return `${Math.round(v)} ms`;
  };

  /** Color-code a latency value (lower = greener, higher = redder). */
  const latencyColor = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return "text-gray-400";
    if (v < 100) return "text-green-400";
    if (v < 300) return "text-cyan-400";
    if (v < 700) return "text-yellow-400";
    return "text-red-400";
  };

  const getPortalCheckAssessment = (currentJob: ScanJob) => {
    if (currentJob.httpError) {
      return { label: "HTTP check failed", color: "text-red-300" };
    }
    if (currentJob.httpStatusCode !== null) {
      return currentJob.httpStatusCode >= 200 && currentJob.httpStatusCode < 300
        ? { label: `Portal HTTP responded (${currentJob.httpStatusCode})`, color: "text-green-300" }
        : { label: `Portal HTTP status ${currentJob.httpStatusCode}`, color: "text-yellow-300" };
    }
    return currentJob.diagnosticsAt
      ? { label: "No HTTP response recorded", color: "text-yellow-300" }
      : { label: "Portal check pending", color: "text-gray-400" };
  };

  const getTcpSuccessfulCount = (currentJob: ScanJob): number | null => {
    if (currentJob.pingSuccessful !== null) return currentJob.pingSuccessful;
    if (
      currentJob.pingProbes !== null && currentJob.pingProbes > 0 &&
      currentJob.pingLossPct !== null
    ) {
      return Math.round(currentJob.pingProbes * (1 - currentJob.pingLossPct / 100));
    }
    return null;
  };

  const toggleLogFilter = (level: keyof typeof logFilters) => {
    setLogFilters((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  /**
   * Estimates memory usage for the block-shuffle algorithm given
   * the current MAC prefix and block size.
   */
  const estimateMemory = useCallback(() => {
    const prefixParts = macPrefix
      .replace(/\*/g, "")
      .replace(/:$/, "")
      .split(":")
      .filter(Boolean);
    const missingBytes = Math.max(0, 6 - prefixParts.length);
    const totalCombinations = Math.pow(256, missingBytes);
    const bs = Math.max(100, Math.min(blockSize, 500000));
    const totalBlocks = Math.ceil(totalCombinations / bs);

    // blockOrder array: totalBlocks × 4 bytes
    // current block indices: blockSize × 4 bytes  (reused every iteration)
    const blockOrderBytes = totalBlocks * 4;
    const perBlockBytes = bs * 4;
    const totalBytes = blockOrderBytes + perBlockBytes;

    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return {
      totalCombinations,
      totalBlocks,
      blockOrderSize: formatSize(blockOrderBytes),
      perBlockSize: formatSize(perBlockBytes),
      totalSize: formatSize(totalBytes),
    };
  }, [macPrefix, blockSize]);

  const memEstimate = estimateMemory();

  // ========================================================================
  // RENDER: Loading screen
  // ========================================================================

  if (isReconnecting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <Image
            src={BRAND_IMAGE_URL}
            alt=""
            aria-hidden="true"
            width={64}
            height={64}
            className="w-16 h-16 mx-auto mb-4 rounded-xl object-cover animate-pulse"
            unoptimized
          />
          <p className="text-gray-400">Connecting to MacAttack...</p>
          <p className="text-gray-500 text-sm mt-2">Checking for active scans...</p>
          <div className="mt-4 flex justify-center gap-1">
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce [animation-delay:0s]" />
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce [animation-delay:0.15s]" />
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce [animation-delay:0.3s]" />
          </div>
        </div>
      </div>
    );
  }

  // ========================================================================
  // RENDER: Main UI
  // ========================================================================

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div style={{ maxWidth: "80rem", margin: "0 auto", padding: "0.75rem 1rem", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <Image
              src={BRAND_IMAGE_URL}
              alt=""
              aria-hidden="true"
              width={40}
              height={40}
              style={{ width: "2.5rem", height: "2.5rem", borderRadius: "0.5rem", objectFit: "cover", flexShrink: 0 }}
              unoptimized
            />
            <div>
              <h1 style={{ fontSize: "1.25rem", fontWeight: "bold" }} className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
                MacAttack
              </h1>
              <p style={{ fontSize: "0.75rem" }} className="text-gray-500">
                IPTV Stalker Portal Scanner
              </p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {isRunning && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-900/30 border border-cyan-700/50 rounded-full scanning-glow">
                <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
                <span className="text-xs text-cyan-300 font-medium">
                  Scanning...
                </span>
              </div>
            )}
            {isScheduledPaused && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-900/30 border border-yellow-700/50 rounded-full">
                <div className="w-2 h-2 bg-yellow-400 rounded-full" />
                <span className="text-xs text-yellow-300 font-medium">Schedule pause</span>
              </div>
            )}
            <button
              onClick={() => setShowScheduleSettings(true)}
              className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
              title="Work schedule settings"
            >
              ⏰ Schedule
            </button>
            <button
              onClick={() => setShowHASettings(true)}
              className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
              title="Home Assistant Settings"
            >
              🏠 HA Settings
            </button>
            <button
              onClick={() => {
                setShowHistory(!showHistory);
                if (!showHistory) loadHistory();
              }}
              className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
            >
              📜 History
            </button>
          </div>
        </div>
      </header>

      {/* Running scan banner */}
      {isRunning && (
        <div className="bg-cyan-900/20 border-b border-cyan-700/30 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-cyan-300">
              <span className="animate-pulse">●</span>
              <span>
                Scan running in background — {job?.totalTested.toLocaleString()} tested, {job?.totalFound} found
              </span>
            </div>
            <span className="text-xs text-cyan-500">
              You can close this page; the scan will continue
            </span>
          </div>
        </div>
      )}
      {isScheduledPaused && (
        <div className="bg-yellow-900/20 border-b border-yellow-700/30 px-4 py-2">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-yellow-300">
              <span>⏸</span>
              <span>Outside the allowed work schedule — this scan is paused automatically.</span>
            </div>
            <span className="text-xs text-yellow-500">
              It will resume when the next allowed window opens.
            </span>
          </div>
        </div>
      )}

      {/* Home Assistant Settings Modal */}
      {showHASettings && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-200">
                🏠 Home Assistant Integration
              </h2>
              <button
                onClick={() => setShowHASettings(false)}
                className="text-gray-400 hover:text-gray-200"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Home Assistant URL
                </label>
                <input
                  type="text"
                  value={haSettings.haUrl}
                  onChange={(e) =>
                    setHaSettings((s) => ({ ...s, haUrl: e.target.value }))
                  }
                  placeholder="http://homeassistant.local:8123"
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Your Home Assistant instance URL (e.g., http://192.168.1.100:8123)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Long-Lived Access Token
                </label>
                <input
                  type="password"
                  value={haSettings.haToken}
                  onChange={(e) =>
                    setHaSettings((s) => ({ ...s, haToken: e.target.value }))
                  }
                  placeholder="eyJ0eXAiOiJKV1QiLCJhbGc..."
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Create at: Profile → Security → Long-Lived Access Tokens
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Default Entity ID (optional)
                </label>
                <input
                  type="text"
                  value={haSettings.haEntityId}
                  onChange={(e) =>
                    setHaSettings((s) => ({ ...s, haEntityId: e.target.value }))
                  }
                  placeholder="sensor.macattack_found"
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Entity to update with found MAC count. Will be created if it doesn&apos;t exist.
                </p>
              </div>

              {haTestResult && (
                <div
                  className={`p-3 rounded-lg text-sm ${
                    haTestResult.success
                      ? "bg-green-900/30 border border-green-700/50 text-green-300"
                      : "bg-red-900/30 border border-red-700/50 text-red-300"
                  }`}
                >
                  {haTestResult.success ? "✅ " : "❌ "}
                  {haTestResult.message || haTestResult.error}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleTestHA}
                  disabled={haSaving || !haSettings.haUrl || !haSettings.haToken}
                  className="flex-1 py-2.5 px-4 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 rounded-lg font-medium transition-colors"
                >
                  {haSaving ? "Testing..." : "🔌 Test Connection"}
                </button>
                <button
                  onClick={handleSaveHASettings}
                  disabled={haSaving}
                  className="flex-1 py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 rounded-lg font-medium transition-colors"
                >
                  {haSaving ? "Saving..." : "💾 Save Settings"}
                </button>
              </div>
            </div>

            <div className="mt-4 p-3 bg-gray-800/50 rounded-lg">
              <p className="text-xs text-gray-400">
                <strong>How it works:</strong> MacAttack will send the count of found MAC addresses
                to your Home Assistant entity via the REST API. The entity state will update in real-time
                as valid MACs are discovered. When you stop the scan, the entity will reset to 0.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Work Schedule Modal */}
      {showScheduleSettings && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-200">⏰ Work Schedule</h2>
                <p className="text-xs text-gray-500 mt-1">Choose when MacAttack is allowed to scan.</p>
              </div>
              <button
                onClick={() => setShowScheduleSettings(false)}
                className="text-gray-400 hover:text-gray-200"
                aria-label="Close schedule settings"
              >
                ✕
              </button>
            </div>

            <label className="flex items-start gap-3 p-4 bg-gray-800/70 border border-gray-700 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={scheduleSettings.enabled}
                onChange={(event) => setScheduleSettings((current) => ({ ...current, enabled: event.target.checked }))}
                className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
              />
              <span>
                <span className="block text-sm font-medium text-gray-200">Enable work schedule</span>
                <span className="block text-xs text-gray-400 mt-1">
                  {scheduleSettings.enabled
                    ? "Scans run only during the allowed windows below and pause automatically outside them."
                    : "Schedule disabled — MacAttack is allowed to run at all times."}
                </span>
              </span>
            </label>

            <div className="mt-4 mb-4 flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1">
                <label htmlFor="schedule-timezone" className="block text-sm font-medium text-gray-300 mb-1.5">
                  Time zone
                </label>
                <input
                  id="schedule-timezone"
                  type="text"
                  value={scheduleSettings.timezone}
                  onChange={(event) => setScheduleSettings((current) => ({ ...current, timezone: event.target.value }))}
                  placeholder="Europe/London"
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <button
                onClick={() => {
                  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                  if (localTimezone) setScheduleSettings((current) => ({ ...current, timezone: localTimezone }));
                }}
                className="px-3 py-2.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
              >
                Use my local time zone
              </button>
            </div>

            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <div className="grid grid-cols-[minmax(6rem,1fr)_1fr_1fr] gap-3 bg-gray-800/70 px-4 py-2 text-xs uppercase tracking-wide text-gray-500">
                <span>Day</span><span>Allowed from</span><span>Allowed until</span>
              </div>
              <div className="divide-y divide-gray-800">
                {WEEKDAYS.map(({ key, label }) => (
                  <div key={key} className="grid grid-cols-[minmax(6rem,1fr)_1fr_1fr] items-center gap-3 px-4 py-2.5">
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={scheduleSettings.days[key].enabled}
                        onChange={(event) => setScheduleSettings((current) => ({
                          ...current,
                          days: { ...current.days, [key]: { ...current.days[key], enabled: event.target.checked } },
                        }))}
                        className="w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                      />
                      {label}
                    </label>
                    {(["start", "end"] as const).map((field) => (
                      <input
                        key={field}
                        type="time"
                        aria-label={`${label} ${field === "start" ? "start" : "end"} time`}
                        value={scheduleSettings.days[key][field]}
                        onChange={(event) => setScheduleSettings((current) => ({
                          ...current,
                          days: { ...current.days, [key]: { ...current.days[key], [field]: event.target.value } },
                        }))}
                        className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-40"
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Times use the selected time zone. An end time earlier than the start time runs overnight into the next day.
            </p>

            {scheduleResult && (
              <div className={`mt-4 p-3 rounded-lg text-sm ${scheduleResult.success ? "bg-green-900/30 border border-green-700/50 text-green-300" : "bg-red-900/30 border border-red-700/50 text-red-300"}`}>
                {scheduleResult.success ? "✅ " : "❌ "}{scheduleResult.message || scheduleResult.error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-5">
              <button
                onClick={() => setShowScheduleSettings(false)}
                className="py-2.5 px-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSchedule}
                disabled={scheduleSaving}
                className="py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 rounded-lg font-medium text-sm transition-colors"
              >
                {scheduleSaving ? "Saving..." : "💾 Save Schedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      <main style={{ flex: 1, maxWidth: "80rem", margin: "0 auto", width: "100%", padding: "1.5rem 1rem" }}>
        {/* History Panel */}
        {showHistory && (
          <div className="mb-6 bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-3">Scan History</h3>
            {history.length === 0 ? (
              <p className="text-gray-500 text-sm">No previous scans</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {history.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      setActiveJobId(h.id);
                      setShowHistory(false);
                      setPortalUrl(h.portalUrl);
                      setMacPrefix(h.macPrefix);
                    }}
                    className="w-full text-left px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors flex items-center justify-between"
                  >
                    <div>
                      <span className="text-sm font-medium text-gray-200">
                        {h.portalUrl}
                      </span>
                      <span className="text-xs text-gray-500 ml-3">
                        {new Date(h.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400">
                        Found: {h.totalFound} / Tested: {h.totalTested}
                      </span>
                      <span
                        className={`text-xs font-medium ${getStatusColor(h.status)}`}
                      >
                        {h.status.toUpperCase()}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="mb-6 bg-red-900/20 border border-red-700/50 rounded-xl p-4 flex items-start gap-3">
            <span className="text-red-400 text-lg">❌</span>
            <div className="flex-1">
              <p className="text-red-300 font-medium">Error</p>
              <p className="text-red-400 text-sm">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-300"
            >
              ✕
            </button>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: "1.5rem",
          }}
          className="main-grid"
        >
          {/* Left Panel - Configuration */}
          <div className="space-y-4" style={{ gridColumn: "1 / 2" }}>
            {/* Target Configuration */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                🎯 Target Configuration
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Portal URL
                  </label>
                  <input
                    type="text"
                    value={portalUrl}
                    onChange={(e) => setPortalUrl(e.target.value)}
                    placeholder="http://example.com/c/"
                    disabled={isRunning}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 disabled:opacity-50 transition-colors"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Stalker middleware portal (e.g., /c/, /stalker_portal/c/)
                  </p>
                </div>

                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipVerification}
                      onChange={(e) => setSkipVerification(e.target.checked)}
                      disabled={isRunning}
                      className="w-4 h-4 rounded border-gray-600 text-orange-500 focus:ring-orange-500 bg-gray-700"
                    />
                    <span className="text-sm text-gray-300">Skip portal verification</span>
                  </label>
                  <p className="text-xs text-gray-500 mt-1 ml-6">
                    Enable if auto-detection fails. Uses default URL patterns.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    MAC Prefix
                  </label>
                  <input
                    type="text"
                    value={macPrefix}
                    onChange={(e) => setMacPrefix(e.target.value)}
                    placeholder="00:1A:79"
                    disabled={isRunning}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 disabled:opacity-50 transition-colors"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Default: 00:1A:79 (MAG device prefix)
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Timeout (ms)
                  </label>
                  <input
                    type="number"
                    value={timeoutMs}
                    onChange={(e) =>
                      setTimeoutMs(parseInt(e.target.value) || 5000)
                    }
                    min={1000}
                    max={30000}
                    step={500}
                    disabled={isRunning}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 disabled:opacity-50 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Block Size (MACs per block)
                  </label>
                  <input
                    type="number"
                    value={blockSize}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 8000;
                      setBlockSize(Math.max(100, Math.min(v, 500000)));
                    }}
                    min={100}
                    max={500000}
                    step={1000}
                    disabled={isRunning}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 disabled:opacity-50 transition-colors"
                  />
                  <div className="mt-2 p-2 bg-gray-800/60 rounded-lg border border-gray-700/50">
                    <p className="text-xs text-gray-400">
                      <span className="text-gray-500">Total MACs:</span>{" "}
                      <span className="text-cyan-400 font-medium">{memEstimate.totalCombinations.toLocaleString()}</span>
                      {" · "}
                      <span className="text-gray-500">Blocks:</span>{" "}
                      <span className="text-cyan-400 font-medium">{memEstimate.totalBlocks.toLocaleString()}</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      <span className="text-gray-500">Est. memory:</span>{" "}
                      <span className="text-green-400 font-medium">{memEstimate.totalSize}</span>
                      <span className="text-gray-600">
                        {" "}(block order {memEstimate.blockOrderSize} + per-block {memEstimate.perBlockSize})
                      </span>
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Home Assistant Entity (optional)
                  </label>
                  <input
                    type="text"
                    value={haEntityId}
                    onChange={(e) => setHaEntityId(e.target.value)}
                    placeholder="sensor.macattack_found"
                    disabled={isRunning}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 disabled:opacity-50 transition-colors"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Override default HA entity for this scan
                  </p>
                </div>
              </div>
            </div>

            {/* Filters */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                🎚️ Result Filters
              </h2>
              <p className="text-xs text-gray-500 mb-4">
                When disabled (default), every valid MAC is stored. Enable filters to save only MACs that match your criteria.
              </p>

              {/* Genre/content filter */}
              <div className="mb-5 p-3 bg-gray-800/50 border border-gray-700/60 rounded-lg">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={genreFilterEnabled}
                    onChange={(e) => setGenreFilterEnabled(e.target.checked)}
                    disabled={isRunning}
                    className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700 disabled:opacity-50"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-gray-200">
                      Filter by content category (fuzzy match)
                    </span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Only store MACs whose category list contains any of these keywords (case &amp; accent insensitive, comma-separated).
                    </p>
                  </div>
                </label>

                {genreFilterEnabled && (
                  <div className="mt-3 space-y-3">
                    <textarea
                      value={genreFilterKeywords}
                      onChange={(e) => setGenreFilterKeywords(e.target.value)}
                      disabled={isRunning}
                      rows={2}
                      placeholder="nl, netherlands, dutch, ned, nederland"
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 disabled:opacity-50 font-mono"
                    />
                    <div className="flex flex-wrap gap-3 text-xs text-gray-400">
                      <span>Match in:</span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={genreMatchLive}
                          onChange={(e) => setGenreMatchLive(e.target.checked)}
                          disabled={isRunning}
                          className="w-3.5 h-3.5 rounded border-gray-600 text-cyan-500 bg-gray-700"
                        />
                        📺 Live TV
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={genreMatchVod}
                          onChange={(e) => setGenreMatchVod(e.target.checked)}
                          disabled={isRunning}
                          className="w-3.5 h-3.5 rounded border-gray-600 text-cyan-500 bg-gray-700"
                        />
                        🎬 VOD
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={genreMatchSeries}
                          onChange={(e) => setGenreMatchSeries(e.target.checked)}
                          disabled={isRunning}
                          className="w-3.5 h-3.5 rounded border-gray-600 text-cyan-500 bg-gray-700"
                        />
                        🎞️ Series
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {/* Expire-date filter */}
              <div className="p-3 bg-gray-800/50 border border-gray-700/60 rounded-lg">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={expireFilterEnabled}
                    onChange={(e) => setExpireFilterEnabled(e.target.checked)}
                    disabled={isRunning}
                    className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700 disabled:opacity-50"
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-gray-200">
                      Only keep MACs expiring on or after:
                    </span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Reject MACs whose subscription expires before this date.
                    </p>
                  </div>
                </label>

                {expireFilterEnabled && (
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={expireMinDate}
                        onChange={(e) => setExpireMinDate(e.target.value)}
                        disabled={isRunning}
                        className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                      />
                      <div className="flex flex-wrap gap-1">
                        {[
                          { label: "Today", offset: 0 },
                          { label: "+1 mo", offset: 30 },
                          { label: "+3 mo", offset: 90 },
                          { label: "+6 mo", offset: 180 },
                          { label: "+1 yr", offset: 365 },
                        ].map((p) => {
                          const d = new Date();
                          d.setDate(d.getDate() + p.offset);
                          const iso = d.toISOString().slice(0, 10);
                          return (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => setExpireMinDate(iso)}
                              disabled={isRunning}
                              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 border border-gray-600 rounded transition-colors"
                            >
                              {p.label}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => setExpireMinDate("")}
                          disabled={isRunning}
                          className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded transition-colors"
                        >
                          Any date
                        </button>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={expireIncludeUnlimited}
                        onChange={(e) => setExpireIncludeUnlimited(e.target.checked)}
                        disabled={isRunning}
                        className="w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                      />
                      <span className="text-xs text-gray-300">
                        Include <em>unlimited / lifetime</em> accounts (0000-00-00, empty, or far-future dates)
                      </span>
                    </label>
                  </div>
                )}
              </div>
            </div>

            {/* Output Fields Selection */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  📋 Output Fields
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={selectAllFields}
                    disabled={isRunning}
                    className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded transition-colors"
                  >
                    Select All
                  </button>
                  <button
                    onClick={deselectAllFields}
                    disabled={isRunning}
                    className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded transition-colors"
                  >
                    Deselect All
                  </button>
                </div>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {AVAILABLE_FIELDS.map((field) => (
                  <label
                    key={field.key}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFields.includes(field.key)}
                      onChange={() => toggleField(field.key)}
                      disabled={isRunning || (field.key === "macAddress" && selectedFields.length === 1)}
                      className="w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700 disabled:opacity-50"
                    />
                    <span className="text-sm text-gray-300">{field.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {selectedFields.length} of {AVAILABLE_FIELDS.length} fields selected
              </p>
            </div>

            {/* Actions */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                ⚡ Actions
              </h2>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 p-3 bg-gray-800/60 border border-gray-700/70 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-200">⏰ Work schedule</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {scheduleSettings.enabled
                        ? `Limited hours · ${scheduleSettings.timezone}`
                        : "Disabled · allowed to run at all times"}
                    </p>
                  </div>
                  <button
                    onClick={() => { setScheduleResult(null); setShowScheduleSettings(true); }}
                    className="px-3 py-2 text-xs bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg transition-colors"
                  >
                    Configure
                  </button>
                </div>
                {isStopped ? (
                  <button
                    onClick={handleStart}
                    disabled={isLoading || !portalUrl.trim()}
                    className="w-full py-3 px-4 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all shadow-lg shadow-cyan-900/30 hover:shadow-cyan-800/40"
                  >
                    {isLoading ? "⏳ Starting..." : "🚀 Start Scan"}
                  </button>
                ) : (
                  <button
                    onClick={handleStop}
                    disabled={isLoading}
                    className="w-full py-3 px-4 bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 disabled:from-gray-700 disabled:to-gray-700 text-white font-semibold rounded-lg transition-all shadow-lg"
                  >
                    {isLoading ? "⏳ Stopping..." : "⏹️ Stop Scan"}
                  </button>
                )}

                {activeJobId && results.length > 0 && (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                      <button
                        onClick={() => handleDownload("csv")}
                        className="py-2 px-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm font-medium rounded-lg transition-colors"
                      >
                        📥 Download CSV
                      </button>
                      <button
                        onClick={() => handleDownload("txt")}
                        className="py-2 px-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm font-medium rounded-lg transition-colors"
                      >
                        📥 Download TXT
                      </button>
                      <button
                        onClick={() => handleDownload("json")}
                        className="col-span-2 py-2 px-3 bg-cyan-950/60 hover:bg-cyan-900/70 border border-cyan-800/70 text-cyan-200 text-sm font-medium rounded-lg transition-colors"
                      >
                        📥 Full JSON (all captured server data)
                      </button>
                    </div>
                    <p className="text-xs text-gray-500">
                      JSON includes complete responses from portal endpoints already requested by the scan, even for fields not shown in the table. Raw responses may contain account credentials; store the export securely.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right Panel - Results & Logs */}
          <div className="space-y-4">
            {/* Stats Bar */}
            {job && (
              <div className="stats-grid">
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-cyan-400">
                    {job.totalTested.toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">MACs Tested</p>
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                  <p className="text-2xl font-bold text-green-400">
                    {job.totalFound}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Valid Found</p>
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                  <p
                    className={`text-2xl font-bold ${getStatusColor(job.status)}`}
                  >
                    {job.status.toUpperCase()}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Status</p>
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                  <p className="text-sm font-mono text-yellow-400 truncate">
                    {job.currentMac || "—"}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Current MAC</p>
                </div>
              </div>
            )}

            {/* Portal connectivity and playback-scope report */}
            {job && (job.diagnosticsAt || job.pingAvgMs !== null || job.httpTotalMs !== null) && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                      🌐 Portal Connectivity &amp; Quality Report
                    </h2>
                    <p className="text-xs text-gray-500 mt-1">
                      Scanner host → Stalker portal · {job.diagnosticsAt
                        ? `measured ${new Date(job.diagnosticsAt).toLocaleString()}`
                        : "measurement time unavailable"}
                    </p>
                  </div>
                  <span className="px-3 py-1.5 rounded-full border border-amber-800 bg-amber-950/50 text-xs font-semibold text-amber-300">
                    Playback stability: NOT TESTED
                  </span>
                </div>

                <div className="mb-4 rounded-lg border border-amber-900/70 bg-amber-950/25 p-3">
                  <p className="text-sm font-semibold text-amber-200">
                    No stream-quality score is available from this scan.
                  </p>
                  <p className="text-xs leading-relaxed text-gray-300 mt-1">
                    These checks measure the scanner server&apos;s connection to the portal and its control API. The scanner does not open a channel or play media, so it cannot report startup time, bitrate, stalls, or freeze likelihood. The media server and the viewer&apos;s device/network may use a different route.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-4">
                  <div className="bg-gray-800/60 rounded-lg p-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Portal HTTP check</p>
                    <p className={`text-base font-semibold mt-1 ${getPortalCheckAssessment(job).color}`}>
                      {getPortalCheckAssessment(job).label}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      One handshake-endpoint HTTP timing sample · body not inspected · status {job.httpStatusCode ?? "—"}
                    </p>
                    {job.httpError && <p className="text-xs text-red-300 mt-1 break-words">{job.httpError}</p>}
                  </div>

                  <div className="bg-gray-800/60 rounded-lg p-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">TCP connection time</p>
                    <p className={`text-lg font-mono font-bold mt-1 ${latencyColor(job.pingP50Ms ?? job.pingAvgMs)}`}>
                      Median {fmtMs(job.pingP50Ms ?? job.pingAvgMs)}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      P95 {fmtMs(job.pingP95Ms)} · min {fmtMs(job.pingMinMs)} · max {fmtMs(job.pingMaxMs)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      σ {fmtMs(job.pingStdevMs)} variation · connect timing is not media jitter
                    </p>
                  </div>

                  <div className="bg-gray-800/60 rounded-lg p-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">TCP probe outcomes</p>
                    <p className="text-lg font-mono font-bold text-cyan-300 mt-1">
                      {(job.pingProbes ?? 0) > 0
                        ? `${getTcpSuccessfulCount(job) ?? "—"} / ${job.pingProbes} connected`
                        : "No TCP probes recorded"}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {job.pingProbes !== null && job.pingSuccessful !== null
                        ? `${job.pingProbes - job.pingSuccessful} failed`
                        : job.pingLossPct !== null
                          ? `${job.pingLossPct.toFixed(1)}% TCP connection failures`
                          : "No failed-probe estimate available"}
                      {job.pingLossPct !== null ? ` · ${job.pingLossPct.toFixed(1)}% failure rate` : ""}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {job.pingProbeMs ?? 250}ms spacing · {job.pingWindowMs !== null
                        ? `${(job.pingWindowMs / 1000).toFixed(2)}s observed window`
                        : "short sample window"}
                    </p>
                    {job.pingError && <p className="text-xs text-yellow-300 mt-1 break-words">{job.pingError}</p>}
                  </div>

                  <div className="bg-gray-800/60 rounded-lg p-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">HTTP time to first byte</p>
                    <p className={`text-lg font-mono font-bold mt-1 ${latencyColor(job.httpTtfbMs)}`}>
                      {fmtMs(job.httpTtfbMs)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Portal response after connection setup; not video startup time
                    </p>
                  </div>

                  <div className="bg-gray-800/60 rounded-lg p-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">HTTP request total</p>
                    <p className={`text-lg font-mono font-bold mt-1 ${latencyColor(job.httpTotalMs)}`}>
                      {fmtMs(job.httpTotalMs)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      DNS {fmtMs(job.httpDnsMs)} · TCP {fmtMs(job.httpTcpMs)} · TLS {fmtMs(job.httpTlsMs)}
                    </p>
                  </div>

                  <div className="bg-gray-800/60 rounded-lg p-3">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">
                      Valid-result account checks
                    </p>
                    <p className={`text-lg font-mono font-bold mt-1 ${latencyColor(accountResponseSummary.median)}`}>
                      Median {fmtMs(accountResponseSummary.median)}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      P95 {fmtMs(accountResponseSummary.p95)} · min {fmtMs(accountResponseSummary.min)} · max {fmtMs(accountResponseSummary.max)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {accountResponseSummary.count} saved results · handshake + account_info only
                    </p>
                  </div>
                </div>

                {/* HTTP waterfall describes the one portal timing request only. */}
                {job.httpTotalMs !== null && job.httpTotalMs > 0 && (
                  <div className="mb-4">
                    <p className="text-xs text-gray-500 mb-2">Portal HTTP timing breakdown (one sample)</p>
                    {(() => {
                      const total = job.httpTotalMs!;
                      const phases: Array<{
                        key: string;
                        label: string;
                        ms: number;
                        bg: string;
                        fg: string;
                      }> = [];
                      if (job.httpDnsMs && job.httpDnsMs > 0)
                        phases.push({ key: "dns", label: "DNS", ms: job.httpDnsMs, bg: "bg-blue-700", fg: "text-blue-100" });
                      if (job.httpTcpMs && job.httpTcpMs > 0)
                        phases.push({ key: "tcp", label: "TCP", ms: job.httpTcpMs, bg: "bg-purple-700", fg: "text-purple-100" });
                      if (job.httpTlsMs && job.httpTlsMs > 0)
                        phases.push({ key: "tls", label: "TLS", ms: job.httpTlsMs, bg: "bg-orange-700", fg: "text-orange-100" });
                      if (job.httpTtfbMs && job.httpTtfbMs > 0)
                        phases.push({ key: "ttfb", label: "TTFB", ms: job.httpTtfbMs, bg: "bg-cyan-700", fg: "text-cyan-100" });

                      const accounted = phases.reduce((sum, phase) => sum + phase.ms, 0);
                      const transferMs = Math.max(0, total - accounted);
                      if (transferMs > 1)
                        phases.push({ key: "transfer", label: "Other", ms: transferMs, bg: "bg-green-700", fg: "text-green-100" });

                      return (
                        <>
                          <div className="flex h-6 w-full rounded overflow-hidden bg-gray-800 text-xs font-mono">
                            {phases.map((phase) => {
                              const percent = (phase.ms / total) * 100;
                              return (
                                <div
                                  key={phase.key}
                                  className={`${phase.bg} ${phase.fg} flex items-center justify-center`}
                                  style={{ width: `${percent}%` }}
                                  title={`${phase.label}: ${Math.round(phase.ms)}ms`}
                                >
                                  {percent > 10 ? `${phase.label} ${Math.round(phase.ms)}ms` : ""}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-400">
                            {phases.map((phase) => (
                              <span key={phase.key}>
                                <span className={`inline-block w-3 h-3 ${phase.bg} rounded-sm mr-1 align-middle`} />
                                {phase.label} {Math.round(phase.ms)}ms
                              </span>
                            ))}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                <p className="text-xs leading-relaxed text-gray-500 border-t border-gray-800 pt-3">
                  Interpretation: TCP probe failures are connection-attempt failures, not packet-loss measurements. These short scanner-to-portal observations have limited confidence and do not test the actual media host, sustained segment throughput, player buffering, or the viewer&apos;s local network.
                  {job.serverIp ? ` Portal IP: ${job.serverIp}.` : ""}
                </p>
              </div>
            )}

            {/* Results Table */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  🎯 Valid MAC Addresses Found
                </h2>
                <span className="text-xs text-gray-500">
                  {results.length} result{results.length !== 1 ? "s" : ""}
                </span>
              </div>

              {results.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <p className="text-gray-500 text-sm">
                    {isRunning
                      ? "Scanning for valid MAC addresses..."
                      : "No results yet. Start a scan to find valid MACs."}
                  </p>
                  {isRunning && (
                    <div className="mt-4 flex justify-center">
                      <div className="flex gap-1">
                        <div className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce [animation-delay:0s]" />
                        <div className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce [animation-delay:0.15s]" />
                        <div className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce [animation-delay:0.3s]" />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-800 z-10">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-semibold text-gray-400 uppercase">
                          #
                        </th>
                        {selectedFields.map((field) => (
                          <th
                            key={field}
                            className="px-3 py-3 text-left text-xs font-semibold text-gray-400 uppercase whitespace-nowrap"
                          >
                            {AVAILABLE_FIELDS.find((f) => f.key === field)?.label || field}
                          </th>
                        ))}
                        <th className="px-3 py-3 text-left text-xs font-semibold text-gray-400 uppercase whitespace-nowrap">
                          Quality
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-semibold text-gray-400 uppercase whitespace-nowrap">
                          Server Data
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/50">
                      {results.map((result, idx) => (
                        <Fragment key={result.id}>
                          <tr className="hover:bg-gray-800/50 transition-colors">
                            <td className="px-3 py-3 text-gray-500 font-mono text-xs">
                              {idx + 1}
                            </td>
                            {selectedFields.map((field) => (
                              <td
                                key={field}
                                className={`px-3 py-3 text-xs max-w-48 truncate ${
                                  field === "macAddress"
                                    ? "font-mono text-cyan-400"
                                    : field === "password"
                                    ? "font-mono text-green-400"
                                    : field === "expireDate"
                                    ? "text-yellow-400"
                                    : field === "responseTimeMs"
                                    ? `font-mono ${latencyColor(result.responseTimeMs)}`
                                    : "text-gray-300"
                                }`}
                                title={getFieldValue(result, field)}
                              >
                                {getFieldValue(result, field)}
                              </td>
                            ))}
                            <td className="px-3 py-2 min-w-44">
                              <p className={`text-xs font-medium ${
                                result.qualityReport?.portal.status === "response_received"
                                  ? "text-green-300"
                                  : result.qualityReport?.portal.status === "check_error"
                                    ? "text-red-300"
                                    : result.qualityReport?.portal.status === "http_status_issue"
                                      ? "text-yellow-300"
                                      : "text-gray-400"
                              }`}>
                                {result.qualityReport?.portal.status === "response_received"
                                  ? "Portal responded"
                                  : result.qualityReport?.portal.status === "check_error" || result.qualityReport?.portal.status === "http_status_issue"
                                    ? "Portal check issue"
                                    : "Portal check unavailable"}
                              </p>
                              <p className="text-xs text-amber-300 mt-0.5">Playback not tested</p>
                              <button
                                type="button"
                                onClick={() => setExpandedQualityId((current) => current === result.id ? null : result.id)}
                                aria-expanded={expandedQualityId === result.id}
                                className="mt-1 whitespace-nowrap px-2 py-1 text-xs text-amber-200 hover:text-amber-100 border border-amber-900 rounded"
                              >
                                {expandedQualityId === result.id ? "Hide quality" : "Quality details"}
                              </button>
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => void toggleRawData(result.id)}
                                aria-expanded={expandedResultId === result.id}
                                disabled={rawDataLoadingId !== null}
                                className="whitespace-nowrap px-2 py-1 text-xs text-cyan-300 hover:text-cyan-100 border border-cyan-900 rounded disabled:opacity-50"
                              >
                                {rawDataLoadingId === result.id
                                  ? "Loading…"
                                  : expandedResultId === result.id
                                    ? "Hide JSON"
                                    : "View JSON"}
                              </button>
                            </td>
                          </tr>
                          {expandedQualityId === result.id && (
                            <tr>
                              <td colSpan={selectedFields.length + 3} className="px-4 py-4 bg-gray-950/70">
                                {result.qualityReport ? (
                                  <div className="space-y-3">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                      <div>
                                        <h3 className="text-sm font-semibold text-gray-200">{result.qualityReport.assessment.label}</h3>
                                        <p className="text-xs text-gray-400 mt-1">{result.qualityReport.assessment.explanation}</p>
                                      </div>
                                      <span className="px-2.5 py-1 rounded border border-amber-900 bg-amber-950/40 text-xs text-amber-200">
                                        Playback: {result.qualityReport.playback.label}
                                      </span>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">Measurement source</p>
                                        <p className="text-sm text-gray-200 mt-1">{result.qualityReport.source.label}</p>
                                        <p className="text-xs font-mono text-gray-400 mt-1">{result.qualityReport.source.target ?? "Portal target unavailable"}</p>
                                        <p className="text-xs text-gray-500 mt-1">
                                          {result.qualityReport.measuredAt
                                            ? new Date(result.qualityReport.measuredAt).toLocaleString()
                                            : "Measurement time unavailable"}
                                        </p>
                                      </div>

                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">TCP connection sample</p>
                                        <p className="text-sm text-gray-200 mt-1">
                                          {result.qualityReport.portal.tcpConnect.successful ?? "—"} / {result.qualityReport.portal.tcpConnect.probes} connected
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                          {result.qualityReport.portal.tcpConnect.failed ?? "—"} failed · {result.qualityReport.portal.tcpConnect.failureRatePct !== null
                                            ? `${result.qualityReport.portal.tcpConnect.failureRatePct.toFixed(1)}%`
                                            : "failure rate unknown"}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-1">
                                          {result.qualityReport.portal.tcpConnect.windowMs !== null
                                            ? `${result.qualityReport.portal.tcpConnect.windowEstimated ? "Estimated " : ""}${(result.qualityReport.portal.tcpConnect.windowMs / 1000).toFixed(2)}s window`
                                            : "Window unavailable"}
                                          {result.qualityReport.portal.tcpConnect.intervalMs !== null
                                            ? ` · ${result.qualityReport.portal.tcpConnect.intervalMs}ms interval`
                                            : ""}
                                        </p>
                                        {result.qualityReport.portal.tcpConnect.observationsMs && (
                                          <p className="text-xs font-mono text-gray-500 mt-1 break-words">
                                            Samples: {result.qualityReport.portal.tcpConnect.observationsMs
                                              .map((value) => value === null ? "timeout" : `${value.toFixed(1)}ms`)
                                              .join(" · ")}
                                          </p>
                                        )}
                                        {result.qualityReport.portal.tcpConnect.error && (
                                          <p className="text-xs text-yellow-300 mt-1 break-words">
                                            {result.qualityReport.portal.tcpConnect.error}
                                          </p>
                                        )}
                                      </div>

                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">TCP connect-time spread</p>
                                        <p className={`text-sm font-mono mt-1 ${latencyColor(result.qualityReport.portal.tcpConnect.medianMs)}`}>
                                          Median {fmtMs(result.qualityReport.portal.tcpConnect.medianMs)} · P95 {fmtMs(result.qualityReport.portal.tcpConnect.p95Ms)}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                          Min {fmtMs(result.qualityReport.portal.tcpConnect.minMs)} · mean {fmtMs(result.qualityReport.portal.tcpConnect.meanMs)} · max {fmtMs(result.qualityReport.portal.tcpConnect.maxMs)}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-1">
                                          σ {fmtMs(result.qualityReport.portal.tcpConnect.standardDeviationMs)} · connect-time variation, not RTP jitter
                                        </p>
                                      </div>

                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">Portal HTTP timing</p>
                                        <p className={`text-sm mt-1 ${
                                          result.qualityReport.portal.status === "response_received"
                                            ? "text-green-300"
                                            : result.qualityReport.portal.status === "check_error"
                                              ? "text-red-300"
                                              : "text-yellow-300"
                                        }`}>
                                          {result.qualityReport.portal.http.label}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                          DNS {fmtMs(result.qualityReport.portal.http.dnsMs)} · TCP {fmtMs(result.qualityReport.portal.http.tcpMs)} · TLS {fmtMs(result.qualityReport.portal.http.tlsMs)}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                          TTFB {fmtMs(result.qualityReport.portal.http.ttfbMs)} · total {fmtMs(result.qualityReport.portal.http.totalMs)}
                                        </p>
                                        {result.qualityReport.portal.http.error && <p className="text-xs text-red-300 mt-1 break-words">{result.qualityReport.portal.http.error}</p>}
                                      </div>

                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">This MAC&apos;s portal account check</p>
                                        <p className={`text-sm font-mono mt-1 ${latencyColor(result.qualityReport.accountCheck.totalMs)}`}>
                                          Total {fmtMs(result.qualityReport.accountCheck.totalMs)}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                          Handshake {fmtMs(result.qualityReport.accountCheck.handshakeMs)} · account_info {fmtMs(result.qualityReport.accountCheck.accountInfoMs)}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-1">This is not channel startup/playback time.</p>
                                      </div>

                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">Operator-side server health</p>
                                        <p className="text-sm text-gray-300 mt-1">{result.qualityReport.operatorTelemetry.label}</p>
                                        <p className="text-xs text-gray-500 mt-1">{result.qualityReport.operatorTelemetry.reason}</p>
                                      </div>

                                      <div className="bg-gray-900 rounded-lg p-3">
                                        <p className="text-xs uppercase tracking-wide text-gray-500">Evidence confidence</p>
                                        <p className="text-sm text-amber-200 mt-1">{result.qualityReport.confidence.label}</p>
                                        <p className="text-xs text-gray-400 mt-1">{result.qualityReport.confidence.explanation}</p>
                                      </div>
                                    </div>

                                    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                                      <p className="text-xs font-semibold text-gray-300 mb-1">What this does not establish</p>
                                      <ul className="list-disc pl-5 space-y-1 text-xs text-gray-500">
                                        {result.qualityReport.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                                      </ul>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="text-xs text-gray-500">No quality report is available for this result.</p>
                                )}
                              </td>
                            </tr>
                          )}
                          {expandedResultId === result.id && (
                            <tr>
                              <td
                                colSpan={selectedFields.length + 3}
                                className="px-4 py-3 bg-gray-950/70"
                              >
                                <p className="text-xs text-gray-400 mb-2">
                                  Raw responses from endpoints requested for this result, plus normalized-field provenance.
                                </p>
                                {rawDataLoadingId === result.id ? (
                                  <p className="text-xs text-cyan-300">Loading captured portal data…</p>
                                ) : rawDataError ? (
                                  <p className="text-xs text-red-300">{rawDataError}</p>
                                ) : rawDataByResult[result.id] === null ? (
                                  <p className="text-xs text-gray-500">No raw portal data was stored for this result.</p>
                                ) : Object.prototype.hasOwnProperty.call(rawDataByResult, result.id) ? (
                                  <pre className="max-h-96 overflow-auto rounded-lg border border-gray-800 bg-black/30 p-3 text-xs leading-relaxed text-gray-300 whitespace-pre-wrap break-all">
                                    {JSON.stringify(rawDataByResult[result.id], null, 2)}
                                  </pre>
                                ) : (
                                  <p className="text-xs text-gray-500">Loading captured portal data…</p>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Log Console */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  🖥️ Console Log
                </h2>
                {/* Log filter buttons */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 mr-1">Show:</span>
                  <button
                    onClick={() => toggleLogFilter("info")}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      logFilters.info
                        ? "bg-blue-900/50 text-blue-300 border border-blue-700/50"
                        : "bg-gray-800 text-gray-500 border border-gray-700"
                    }`}
                  >
                    ℹ️ Info
                  </button>
                  <button
                    onClick={() => toggleLogFilter("success")}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      logFilters.success
                        ? "bg-green-900/50 text-green-300 border border-green-700/50"
                        : "bg-gray-800 text-gray-500 border border-gray-700"
                    }`}
                  >
                    ✅ Success
                  </button>
                  <button
                    onClick={() => toggleLogFilter("warning")}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      logFilters.warning
                        ? "bg-yellow-900/50 text-yellow-300 border border-yellow-700/50"
                        : "bg-gray-800 text-gray-500 border border-gray-700"
                    }`}
                  >
                    ⚠️ Warning
                  </button>
                  <button
                    onClick={() => toggleLogFilter("error")}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      logFilters.error
                        ? "bg-red-900/50 text-red-300 border border-red-700/50"
                        : "bg-gray-800 text-gray-500 border border-gray-700"
                    }`}
                  >
                    ❌ Error
                  </button>
                </div>
              </div>
              <div
                ref={logContainerRef}
                className="p-4 max-h-72 overflow-y-auto font-mono text-xs space-y-1 bg-gray-950"
              >
                {filteredLogs.length === 0 ? (
                  <p className="text-gray-600">
                    {logs.length === 0
                      ? "Waiting for scan to start..."
                      : "No logs match the current filter."}
                  </p>
                ) : (
                  filteredLogs.map((log) => (
                    <div
                      key={log.id}
                      className={`flex gap-2 ${getLogColor(log.level)}`}
                    >
                      <span className="text-gray-600 shrink-0">
                        [{new Date(log.createdAt).toLocaleTimeString()}]
                      </span>
                      <span className="shrink-0">{getLogIcon(log.level)}</span>
                      <span className="break-all whitespace-pre-wrap">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="px-4 py-2 bg-gray-900 border-t border-gray-800 text-xs text-gray-500">
                Showing {filteredLogs.length} of {logs.length} log entries
              </div>
            </div>

            {/* Info Panel */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                ℹ️ Information
              </h2>
              <div className="text-xs text-gray-500 space-y-2">
                <p>
                  <strong className="text-gray-400">How it works:</strong>{" "}
                  MacAttack tests MAC addresses against Stalker middleware portals. A MAC is only
                  considered valid if the portal returns actual subscription data (expiry date, plan name, etc.).
                </p>
                <p>
                  <strong className="text-gray-400">Log Filters:</strong>{" "}
                  Use the filter buttons above the console to show/hide different log levels.
                  Click a button to toggle that log type.
                </p>
                <p>
                  <strong className="text-gray-400">Background Scanning:</strong>{" "}
                  Scans continue running even if you close this page. When you return,
                  the app will automatically reconnect.
                </p>
                <p className="text-yellow-500/80">
                  ⚠️ Only use MacAttack on portals you own or have explicit permission to test.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-4 mt-8">
        <div className="max-w-7xl mx-auto px-4 text-center text-xs text-gray-600">
          MacAttack — IPTV Stalker Portal Security Testing Tool — For authorized use only
        </div>
      </footer>
    </div>
  );
}
