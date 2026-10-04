"use client";

import {
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";
import Image from "next/image";
import {
  DEFAULT_WEEK_SCHEDULE,
  WEEKDAYS,
  type ScheduleSettings,
} from "@/lib/schedule";
import { BRAND_IMAGE_URL } from "@/lib/branding";
import { mergeOutputFieldOrder, moveItem } from "@/lib/field-order";
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
  // Measured stream quality (populated when a valid MAC passes the filters)
  qualityVerdict?: string | null;
  qualityScore?: number | null;
  qualitySpeedScore?: number | null;
  qualityQualityScore?: number | null;
  qualityStabilityScore?: number | null;
  qualityResolution?: string | null;
  qualityCodec?: string | null;
  qualityThroughputMbps?: number | null;
  qualityRequiredMbps?: number | null;
  qualityChannelsPlayable?: number | null;
  qualityChannelsProbed?: number | null;
  qualityCheckedAt?: string | null;
  qualityFrozen?: number | null;
  qualityLabelMismatch?: string | null;
  qualityRetries?: number | null;
  qualityThroughputCv?: number | null;
  qualityCatchUpStatus?: string | null;
  qualityCatchUpDays?: number | null;
  qualityThumbnail?: string | null;
  qualityEwma?: number | null;
  qualityTrend?: string | null;
  qualityGenreSummary?: Array<{
    genreId: string | null;
    genreTitle: string;
    channelsProbed: number;
    channelsPlayable: number;
    averageOverall: number | null;
  }> | null;
  protocol?: string | null;
  timezone: string | null;
  portalOnline: string | null;
  lastActive: string | null;
  username: string | null;
  password: string | null;
  playlistGenres: string | null;
  vodCategories: string | null;
  itvGenreCount: number | null;
  vodCategoryCount: number | null;
  seriesCategoryCount: number | null;
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

interface StreamQualityChannelSummary {
  name: string;
  url: string | null;
  linkError: string | null;
  score: {
    overall: number | null;
    speed: number | null;
    quality: number | null;
    stability: number | null;
    verdict: string;
    label: string;
    evidence: string[];
    penalties: string[];
  } | null;
  probe: {
    status: string;
    container: string;
    sustainedMbps: number | null;
    requiredMbps: number | null;
    resolution: { label: string } | null;
    videoCodec: string | null;
    ts: { continuityErrorsPer1000: number; bitrateMbps: number } | null;
    hls: { segmentsOk: number; segmentsFailed: number; realtimeDeficitMs: number } | null;
    warnings: string[];
  } | null;
}

interface StreamQualityReportSummary {
  measuredAt: string;
  portal: { channelListSource: string; channelsListed: number; linksResolved: number; linksFailed: number };
  channels: StreamQualityChannelSummary[];
  aggregate: {
    channelsProbed: number;
    channelsPlayable: number;
    speedScore: number | null;
    qualityScore: number | null;
    stabilityScore: number | null;
    overallScore: number | null;
    verdict: string;
    label: string;
    headroomSummary: string | null;
  };
  notes: string[];
  limitations: string[];
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
  { key: "quality", label: "Quality", default: true },
  { key: "serverLocation", label: "Server Location", default: true },
  { key: "responseTimeMs", label: "Portal Check Response (ms)", default: true },
  { key: "portalCheckStatus", label: "Portal Check Status", default: true },
  { key: "playbackStability", label: "Playback Stability", default: true },
  { key: "qualityConfidence", label: "Quality Test Scope/Confidence", default: false },
  { key: "handshakeTimeMs", label: "Portal Handshake (ms)", default: false },
  { key: "accountInfoTimeMs", label: "Account Info Request (ms)", default: false },
  { key: "qualityReport", label: "Detailed Quality Report (JSON)", default: false },
  { key: "qualityVerdict", label: "Stream Quality Verdict (measured)", default: true },
  { key: "qualityScore", label: "Stream Quality Score (0-10)", default: true },
  { key: "qualitySpeedScore", label: "Stream Speed Score (0-10)", default: false },
  { key: "qualityStabilityScore", label: "Stream Stability Score (0-10)", default: false },
  { key: "qualityResolution", label: "Stream Resolution (measured)", default: true },
  { key: "qualityCodec", label: "Stream Video Codec (measured)", default: false },
  { key: "qualityThroughputMbps", label: "Stream Throughput (Mbps measured)", default: true },
  { key: "qualityRequiredMbps", label: "Stream Required Bitrate (Mbps)", default: false },
  { key: "qualityChannels", label: "Stream Channels Playable/Probed", default: false },
  { key: "qualityMeasured", label: "Stream Quality Measured At", default: false },
  { key: "qualityRetries", label: "Stream Retries (transient)", default: false },
  { key: "qualityFrozen", label: "Stream Frozen Picture Detected", default: false },
  { key: "qualityLabelMismatch", label: "Stream Label Mismatch", default: false },
  { key: "qualityCatchUp", label: "Stream Catch-Up (archive) Check", default: false },
  { key: "qualityThumbnail", label: "Stream Thumbnail URL", default: false },
  { key: "qualityEwma", label: "Stream Score EWMA (history)", default: false },
  { key: "qualityTrend", label: "Stream Score Trend (history)", default: false },
  { key: "qualityGenres", label: "Stream Quality by Genre (measured)", default: false },
  { key: "protocol", label: "Account Protocol", default: false },
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
  { key: "itvGenreCount", label: "ITV Genres Retrieved (count)", default: true },
  { key: "vodCategoryCount", label: "VOD Categories Retrieved (count)", default: true },
  { key: "seriesCategoryCount", label: "Series Categories Retrieved (count)", default: true },
  { key: "createdAt", label: "Created At", default: true },
];

// ============================================================================
// CONSOLE LOG AUTO-REFRESH PREFERENCE (persisted in localStorage)
// ============================================================================

const LOG_AUTO_REFRESH_STORAGE_KEY = "macattack.logAutoRefresh";
const logAutoRefreshListeners = new Set<() => void>();

function subscribeLogAutoRefresh(listener: () => void): () => void {
  logAutoRefreshListeners.add(listener);
  // Keep multiple open tabs in sync.
  window.addEventListener("storage", listener);
  return () => {
    logAutoRefreshListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Defaults to enabled when nothing is stored or storage is unavailable. */
function getLogAutoRefreshSnapshot(): boolean {
  try {
    return window.localStorage.getItem(LOG_AUTO_REFRESH_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setLogAutoRefreshPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(LOG_AUTO_REFRESH_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage unavailable — the preference just won't persist.
  }
  logAutoRefreshListeners.forEach((listener) => listener());
}

function normalizeSelectedFields(fields: string[]): string[] {
  const available = new Set(AVAILABLE_FIELDS.map((field) => field.key));
  const normalized = [...new Set(fields.filter((field) => available.has(field)))];
  return normalized.length > 0 ? normalized : ["macAddress"];
}

/** How the Output Fields order last interacted with the stored preference. */
type FieldOrderSaveState = "idle" | "saving" | "saved" | "error";

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
  const [fieldOrder, setFieldOrder] = useState<string[]>(() =>
    AVAILABLE_FIELDS.map((field) => field.key)
  );
  const [fieldOrderSaveState, setFieldOrderSaveState] =
    useState<FieldOrderSaveState>("idle");
  const [draggedField, setDraggedField] = useState<string | null>(null);
  const [dragOverField, setDragOverField] = useState<string | null>(null);
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
  const [qualityCheckEnabled, setQualityCheckEnabled] = useState(true);
  const [qualityChannels, setQualityChannels] = useState(3);
  const [qualitySampleMs, setQualitySampleMs] = useState(8000);
  // Wave add-ons (all optional; ffmpeg-dependent ones are labelled in the UI)
  const [uaRotationEnabled, setUaRotationEnabled] = useState(true);
  const [pictureChecksEnabled, setPictureChecksEnabled] = useState(true);
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState(true);
  const [catchUpCheckEnabled, setCatchUpCheckEnabled] = useState(true);
  // Scan scope: prefix enumeration, bulk MAC list, or multi-portal
  const [scanMode, setScanMode] = useState<"prefix" | "list">("prefix");
  const [macList, setMacList] = useState("");
  const [extraPortals, setExtraPortals] = useState("");
  const [concurrency, setConcurrency] = useState(1);
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
  const [qualityDetailByResult, setQualityDetailByResult] = useState<Record<number, StreamQualityReportSummary>>({});
  const [qualityDetailLoadingId, setQualityDetailLoadingId] = useState<number | null>(null);
  const [qualityActionId, setQualityActionId] = useState<number | null>(null);
  const [qualityActionError, setQualityActionError] = useState<string | null>(null);
  type HistoryRun = {
    id: number;
    measuredAt: string;
    overall: number | null;
    speed: number | null;
    quality: number | null;
    stability: number | null;
    verdict: string | null;
    throughputMbps: number | null;
    frozen: boolean;
    labelMismatches: number;
    viaProxy: string | null;
    source: string;
  };
  type HistorySummary = {
    ewma: number | null;
    trend: string;
    bestOverall: number | null;
    worstOverall: number | null;
    averageThroughputMbps: number | null;
    lastMeasuredAt: string | null;
  };
  type MonitorInfo = {
    id: number;
    enabled: number;
    intervalMinutes: number;
    alertOn: string;
    lastRunAt: string | null;
    lastVerdict: string | null;
    lastScore: number | null;
    lastTrend: string | null;
    lastAlertReason: string | null;
    due?: boolean;
  };
  const [historyByResult, setHistoryByResult] = useState<
    Record<number, { runs: HistoryRun[]; summary: HistorySummary }>
  >({});
  const [historyLoadingId, setHistoryLoadingId] = useState<number | null>(null);
  const [monitorByResult, setMonitorByResult] = useState<Record<number, MonitorInfo | null>>({});
  const [monitorBusyId, setMonitorBusyId] = useState<number | null>(null);
  const [monitorRunResult, setMonitorRunResult] = useState<string | null>(null);
  const [playlistTokenByResult, setPlaylistTokenByResult] = useState<Record<number, string>>({});
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<{
    ffmpeg: {
      available: boolean;
      version: string | null;
      reason: string | null;
      path: string | null;
      triedPaths?: string[];
      envOverrideSet?: boolean;
      hardwareAcceleration: "vaapi" | null;
      hardwareDevice: string | null;
      checkedAt?: string;
    };
    thumbnails: { dir: string; fallbackDir?: string; fileCount: number | null; maxAgeDays: number; writable?: boolean; usingFallback?: boolean; lastError?: string | null };
  } | null>(null);
  const [systemRefreshing, setSystemRefreshing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [uaList, setUaList] = useState("");
  const [proxyList, setProxyList] = useState("");
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [advancedResult, setAdvancedResult] = useState<{ success?: string; error?: string } | null>(null);
  const [proxyChecks, setProxyChecks] = useState<Array<{ ok: boolean; latencyMs: number | null; display?: string }>>([]);
  const [proxyChecking, setProxyChecking] = useState(false);
  const [xtreamUrl, setXtreamUrl] = useState("");
  const [xtreamResult, setXtreamResult] = useState<string | null>(null);
  const [xtreamBusy, setXtreamBusy] = useState(false);
  const [rawDataByResult, setRawDataByResult] = useState<Record<number, unknown>>({});
  const [rawDataLoadingId, setRawDataLoadingId] = useState<number | null>(null);
  const [rawDataError, setRawDataError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsUpdatedAt, setLogsUpdatedAt] = useState<Date | null>(null);
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
  // STATE: Console log auto-refresh
  // ========================================================================
  // Read from localStorage as an external store so the server render (default:
  // enabled) hydrates cleanly and the choice sticks across reloads/tabs.
  const logAutoRefresh = useSyncExternalStore(
    subscribeLogAutoRefresh,
    getLogAutoRefreshSnapshot,
    () => true,
  );

  // ========================================================================
  // REFS
  // ========================================================================
  const logContainerRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Output Fields order (see /api/settings): the last order read from the
  // server, the selected fields of a restored active job (null when none), and
  // whether the user already reordered this session — their drag always wins.
  const storedFieldOrderRef = useRef<string[]>([]);
  const activeJobFieldOrderRef = useRef<string[] | null>(null);
  const fieldOrderDecidedRef = useRef(false);
  // Saves are serialised so a slow request can never overwrite a newer order.
  const fieldOrderSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  // Mirror of `logAutoRefresh` so the polling callback can read the current
  // value without being re-created (and the interval restarted) on toggle.
  const logAutoRefreshRef = useRef(true);

  // ========================================================================
  // FUNCTIONS: Data loading
  // ========================================================================

  /**
   * Apply the field order the user last stored for the Output Fields list.
   *
   * The selected fields of a restored job (when there is one) keep the order
   * that job was started with; the remaining fields follow the stored
   * preference; fields the stored order predates fall back to the default
   * position. Without a job, the stored order alone is applied and the current
   * field selection is kept.
   */
  const applyFieldOrder = useCallback((jobFields: string[] | null) => {
    const preferred = [
      ...(jobFields ? normalizeSelectedFields(jobFields) : []),
      ...storedFieldOrderRef.current,
    ];
    if (preferred.length === 0) return;

    const nextOrder = mergeOutputFieldOrder(
      AVAILABLE_FIELDS.map((field) => field.key),
      preferred
    );
    setFieldOrder(nextOrder);

    if (jobFields) {
      const selected = new Set(normalizeSelectedFields(jobFields));
      setSelectedFields(nextOrder.filter((fieldKey) => selected.has(fieldKey)));
    } else {
      setSelectedFields((previous) =>
        nextOrder.filter((fieldKey) => previous.includes(fieldKey))
      );
    }
  }, []);

  const loadHASettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = (await res.json()) as HASettings & {
          scheduleEnabled: boolean;
          scheduleTimezone: string;
          scheduleDays: ScheduleSettings["days"];
          outputFieldOrder?: string[];
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

        // Apply the remembered Output Fields order. Skipped once the user has
        // reordered in this session — the stored order must not undo a drag.
        storedFieldOrderRef.current = data.outputFieldOrder ?? [];
        if (!fieldOrderDecidedRef.current) {
          applyFieldOrder(activeJobFieldOrderRef.current);
        }
      }
    } catch {
      // ignore
    }
  }, [applyFieldOrder]);

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
              // The running job's fields keep the order that scan was started
              // with; the stored preference fills in the fields it does not use.
              activeJobFieldOrderRef.current = normalizeSelectedFields(data.job.selectedFields);
              applyFieldOrder(activeJobFieldOrderRef.current);
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
  }, [loadHASettings, applyFieldOrder]);

  // Poll for scan status updates.
  // Pass `forceLogs` to pull the console once even while auto-refresh is off
  // (used by the "Refresh now" button).
  const pollStatus = useCallback(async (forceLogs = false) => {
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
      if (forceLogs || logAutoRefreshRef.current) {
        setLogs(data.logs);
        setLogsUpdatedAt(new Date());
      }

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

  // Keep the ref the polling callback reads in sync with the preference.
  useEffect(() => {
    logAutoRefreshRef.current = logAutoRefresh;
  }, [logAutoRefresh]);

  // Auto-scroll logs to bottom. While auto-refresh is paused we leave the
  // scroll position alone so the log can be read back without being yanked.
  useEffect(() => {
    if (!logAutoRefresh) return;
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, logFilters, logAutoRefresh]);

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
    if (scanMode === "list" && !macList.trim()) {
      setError("Bulk MAC list mode needs at least one MAC address (or switch back to prefix scanning)");
      return;
    }

    setError(null);
    setIsLoading(true);
    setResults([]);
    setLogs([]);
    setLogsUpdatedAt(null);
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
          // Stream quality / speed / stability check for every found MAC
          qualityCheckEnabled,
          qualityChannels,
          qualitySampleMs,
          uaRotationEnabled,
          pictureChecksEnabled,
          thumbnailsEnabled,
          catchUpCheckEnabled,
          // Scope: prefix enumeration, bulk MAC list, multi-portal, concurrency
          scanMode,
          macList: scanMode === "list" ? macList : "",
          portalUrls: extraPortals
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
          concurrency,
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
    const query = new URLSearchParams({ jobId: String(activeJobId), format });
    selectedFields.forEach((field) => query.append("field", field));
    window.open(`/api/scan/download?${query.toString()}`, "_blank");
  };

  // ========================================================================
  // FUNCTIONS: Field selection
  // ========================================================================

  const toggleField = (key: string) => {
    setSelectedFields((previous) => {
      const nextSelected = new Set(previous);
      if (nextSelected.has(key)) {
        nextSelected.delete(key);
      } else {
        nextSelected.add(key);
      }
      return fieldOrder.filter((fieldKey) => nextSelected.has(fieldKey));
    });
  };

  /**
   * Store the Output Fields order server-side so it survives a reload and
   * applies to the next scan's results table and CSV/TXT export.
   */
  const persistFieldOrder = useCallback((order: readonly string[]) => {
    fieldOrderDecidedRef.current = true;
    setFieldOrderSaveState("saving");
    const body = JSON.stringify({ outputFieldOrder: [...order] });

    // Chain the requests: if an earlier save is still in flight, the newer
    // order must land last (otherwise a slow response could resurrect it).
    fieldOrderSaveChainRef.current = fieldOrderSaveChainRef.current
      .catch(() => {
        // An earlier failure must not block the next save.
      })
      .then(async () => {
        try {
          const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          setFieldOrderSaveState(res.ok ? "saved" : "error");
        } catch {
          setFieldOrderSaveState("error");
        }
      });
  }, []);

  const reorderOutputField = (draggedKey: string, targetKey: string) => {
    const nextOrder = moveItem(fieldOrder, draggedKey, targetKey);
    if (nextOrder.join("\u0000") === fieldOrder.join("\u0000")) return;
    setFieldOrder(nextOrder);
    const selected = new Set(selectedFields);
    setSelectedFields(nextOrder.filter((fieldKey) => selected.has(fieldKey)));
    persistFieldOrder(nextOrder);
  };

  const selectAllFields = () => {
    setSelectedFields([...fieldOrder]);
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
    if (field === "quality") {
      const portalLabel =
        report?.portal.status === "response_received"
          ? "Portal responded"
          : report?.portal.status === "check_error" || report?.portal.status === "http_status_issue"
            ? "Portal check issue"
            : "Portal check unavailable";
      if (result.qualityVerdict && result.qualityVerdict !== "unknown") {
        const scorePart = result.qualityScore != null ? ` · ${result.qualityScore}/10` : "";
        const resPart = result.qualityResolution ?? "resolution n/a";
        const speedPart =
          result.qualityThroughputMbps != null ? ` · ${result.qualityThroughputMbps.toFixed(2)} Mbps` : "";
        const chPart =
          result.qualityChannelsProbed != null
            ? ` · ${result.qualityChannelsPlayable ?? 0}/${result.qualityChannelsProbed} playable`
            : "";
        return `${portalLabel} · Streams: ${result.qualityVerdict}${scorePart} · ${resPart}${speedPart}${chPart}`;
      }
      return `${portalLabel} · Streams not measured`;
    }
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
    if (field === "qualityVerdict") {
      return result.qualityVerdict ? `${result.qualityVerdict.replace(/^./, (c) => c.toUpperCase())}${result.qualityScore != null ? ` (${result.qualityScore}/10)` : ""}` : "not measured";
    }
    if (field === "qualityChannels") {
      return result.qualityChannelsProbed != null
        ? `${result.qualityChannelsPlayable ?? 0}/${result.qualityChannelsProbed} playable`
        : "—";
    }
    if (field === "qualityMeasured") {
      return result.qualityCheckedAt ? new Date(result.qualityCheckedAt).toLocaleString() : "—";
    }
    if (field === "qualityThroughputMbps") {
      return result.qualityThroughputMbps != null ? `${result.qualityThroughputMbps.toFixed(2)} Mbps` : "—";
    }
    if (field === "qualityRequiredMbps") {
      return result.qualityRequiredMbps != null ? `${result.qualityRequiredMbps.toFixed(2)} Mbps` : "—";
    }
    if (field === "qualityRetries") {
      return result.qualityRetries != null ? String(result.qualityRetries) : "—";
    }
    if (field === "qualityFrozen") {
      return result.qualityFrozen === 1 ? "yes" : result.qualityFrozen === 0 ? "no" : "—";
    }
    if (field === "qualityLabelMismatch") {
      return result.qualityLabelMismatch || "—";
    }
    if (field === "qualityCatchUp") {
      if (!result.qualityCatchUpStatus) return "—";
      return result.qualityCatchUpDays && result.qualityCatchUpDays >= 1
        ? `${result.qualityCatchUpStatus} (${result.qualityCatchUpDays.toFixed(1)} day(s))`
        : result.qualityCatchUpStatus;
    }
    if (field === "qualityThumbnail") {
      return result.qualityThumbnail
        ? `/api/scan/thumbnail?name=${encodeURIComponent(result.qualityThumbnail)}`
        : "—";
    }
    if (field === "qualityEwma") {
      return result.qualityEwma != null ? String(result.qualityEwma) : "—";
    }
    if (field === "qualityTrend") {
      return result.qualityTrend || "—";
    }
    if (field === "qualityGenres") {
      const groups = result.qualityGenreSummary || [];
      if (groups.length === 0) return "—";
      return groups
        .map(
          (group) =>
            `${group.genreTitle}: ${group.averageOverall ?? "—"}/10 (${group.channelsPlayable}/${group.channelsProbed} playable)`
        )
        .join(" · ");
    }
    if (field === "protocol") {
      return result.protocol || "stalker";
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

  /** Load the stored per-channel stream-quality report for one result. */
  const loadQualityDetail = async (resultId: number) => {
    setQualityDetailLoadingId(resultId);
    setQualityActionError(null);
    try {
      const res = await fetch(`/api/scan/quality?resultId=${resultId}`);
      const data = (await res.json()) as { report?: StreamQualityReportSummary | null; error?: string };
      if (!res.ok) {
        setQualityActionError(data.error || "Could not load the stream-quality report");
        return;
      }
      if (data.report) {
        setQualityDetailByResult((current) => ({ ...current, [resultId]: data.report as StreamQualityReportSummary }));
      } else {
        setQualityActionError("No stream-quality report was stored for this result");
      }
    } catch {
      setQualityActionError("Could not load the stream-quality report");
    } finally {
      setQualityDetailLoadingId(null);
    }
  };

  /** Re-measure the streams for a stored result (streams change over time). */
  const recheckQuality = async (resultId: number) => {
    setQualityActionId(resultId);
    setQualityActionError(null);
    try {
      const res = await fetch("/api/scan/quality", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId }),
      });
      const data = (await res.json()) as {
        error?: string;
        qualityVerdict?: string;
        qualityScore?: number | null;
        qualitySpeedScore?: number | null;
        qualityQualityScore?: number | null;
        qualityStabilityScore?: number | null;
        qualityResolution?: string | null;
        qualityCodec?: string | null;
        qualityThroughputMbps?: number | null;
        qualityRequiredMbps?: number | null;
        qualityChannelsPlayable?: number | null;
        qualityChannelsProbed?: number | null;
        qualityCheckedAt?: string | null;
        qualityReport?: StreamQualityReportSummary | null;
      };
      if (!res.ok) {
        setQualityActionError(data.error || "Stream quality check failed");
        return;
      }
      setResults((current) =>
        current.map((result) =>
          result.id === resultId
            ? {
                ...result,
                qualityVerdict: data.qualityVerdict ?? result.qualityVerdict,
                qualityScore: data.qualityScore ?? result.qualityScore,
                qualitySpeedScore: data.qualitySpeedScore ?? result.qualitySpeedScore,
                qualityQualityScore: data.qualityQualityScore ?? result.qualityQualityScore,
                qualityStabilityScore: data.qualityStabilityScore ?? result.qualityStabilityScore,
                qualityResolution: data.qualityResolution ?? result.qualityResolution,
                qualityCodec: data.qualityCodec ?? result.qualityCodec,
                qualityThroughputMbps: data.qualityThroughputMbps ?? result.qualityThroughputMbps,
                qualityRequiredMbps: data.qualityRequiredMbps ?? result.qualityRequiredMbps,
                qualityChannelsPlayable: data.qualityChannelsPlayable ?? result.qualityChannelsPlayable,
                qualityChannelsProbed: data.qualityChannelsProbed ?? result.qualityChannelsProbed,
                qualityCheckedAt: data.qualityCheckedAt ?? result.qualityCheckedAt,
              }
            : result
        )
      );
      if (data.qualityReport) {
        setQualityDetailByResult((current) => ({ ...current, [resultId]: data.qualityReport as StreamQualityReportSummary }));
      }
    } catch {
      setQualityActionError("Stream quality check failed");
    } finally {
      setQualityActionId(null);
    }
  };

  // ========================================================================
  // WAVE HELPERS: history, monitoring, stable playlist URLs, add-ons
  // ========================================================================

  /** Load probe history (EWMA/trend sparkline) for one result. */
  const loadProbeHistory = async (resultId: number) => {
    setHistoryLoadingId(resultId);
    try {
      const res = await fetch(`/api/scan/history?resultId=${resultId}&days=90`);
      const data = (await res.json()) as {
        runs?: HistoryRun[];
        summary?: HistorySummary;
        error?: string;
      };
      if (res.ok && data.runs && data.summary) {
        setHistoryByResult((current) => ({ ...current, [resultId]: { runs: data.runs!, summary: data.summary! } }));
      }
    } catch {
      // Silent: history is an enhancement, not a blocker.
    } finally {
      setHistoryLoadingId(null);
    }
  };

  /** Load monitoring state for one result. */
  const loadMonitor = async (resultId: number) => {
    try {
      const res = await fetch(`/api/scan/monitors?resultId=${resultId}`);
      const data = (await res.json()) as { monitors?: MonitorInfo[] };
      setMonitorByResult((current) => ({ ...current, [resultId]: data.monitors?.[0] ?? null }));
    } catch {
      // ignore
    }
  };

  /** Enable/disable monitoring for one result. */
  const toggleMonitor = async (resultId: number, enabled: boolean) => {
    setMonitorBusyId(resultId);
    setMonitorRunResult(null);
    try {
      const res = await fetch("/api/scan/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId, enabled }),
      });
      const data = (await res.json()) as { monitor?: MonitorInfo; error?: string };
      if (res.ok && data.monitor) {
        setMonitorByResult((current) => ({ ...current, [resultId]: data.monitor! }));
      } else {
        setMonitorRunResult(data.error || "Could not update monitoring");
      }
    } catch {
      setMonitorRunResult("Could not update monitoring");
    } finally {
      setMonitorBusyId(null);
    }
  };

  /** Run all due monitor checks now (same endpoint an external cron would hit). */
  const runDueMonitors = async () => {
    setMonitorRunResult("Running due checks…");
    try {
      const res = await fetch("/api/scan/monitors?limit=3", { method: "PUT" });
      const data = (await res.json()) as {
        ran?: number;
        skipped?: number;
        outcomes?: Array<{ macAddress: string; verdict: string | null; trend: string; alert: boolean; reason: string | null; error: string | null }>;
        error?: string;
      };
      if (!res.ok) {
        setMonitorRunResult(data.error || "Monitor run failed");
        return;
      }
      if (!data.ran) {
        setMonitorRunResult(`No monitors were due (${data.skipped ?? 0} waiting for their interval).`);
        return;
      }
      const alerts = (data.outcomes || []).filter((outcome) => outcome.alert);
      setMonitorRunResult(
        `Ran ${data.ran} check(s).` +
          (alerts.length > 0
            ? ` ⚠ ${alerts.length} alert(s): ` +
              alerts.map((alert) => `${alert.macAddress} — ${alert.reason}`).join("; ")
            : " No new alerts.")
      );
      // Refresh the affected rows in the table.
      await pollStatus();
    } catch {
      setMonitorRunResult("Monitor run failed");
    }
  };

  /** Create a stable, revocable subscription URL for a result's M3U. */
  const createPlaylistToken = async (resultId: number) => {
    try {
      const res = await fetch("/api/scan/playlist-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId, limitCount: 200 }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (res.ok && data.url) {
        setPlaylistTokenByResult((current) => ({ ...current, [resultId]: data.url! }));
        try {
          await navigator.clipboard.writeText(data.url);
          setCopiedToken(data.url);
          setTimeout(() => setCopiedToken(null), 2500);
        } catch {
          // Clipboard may be unavailable (http origin) — the URL is shown anyway.
        }
      } else {
        setQualityActionError(data.error || "Could not create the subscription URL");
      }
    } catch {
      setQualityActionError("Could not create the subscription URL");
    }
  };

  /** Save the add-on settings (UA list, proxy pool) and load capabilities. */
  const loadAdvanced = useCallback(async () => {
    try {
      const [settingsRes, systemRes] = await Promise.all([fetch("/api/settings"), fetch("/api/system")]);
      if (settingsRes.ok) {
        const data = (await settingsRes.json()) as { uaList?: string; proxyList?: string };
        setUaList(data.uaList || "");
        setProxyList(data.proxyList || "");
      }
      if (systemRes.ok) {
        const data = (await systemRes.json()) as {
          ffmpeg: {
            available: boolean;
            version: string | null;
            reason: string | null;
            path: string | null;
            triedPaths?: string[];
            envOverrideSet?: boolean;
            hardwareAcceleration: "vaapi" | null;
            hardwareDevice: string | null;
            checkedAt?: string;
          };
          thumbnails: { dir: string; fallbackDir?: string; fileCount: number | null; maxAgeDays: number; writable?: boolean; usingFallback?: boolean; lastError?: string | null };
        };
        setSystemInfo(data);
      }
    } catch {
      // ignore
    }
  }, []);

  /** Re-run FFmpeg/thumbnail detection without restarting the container. */
  const refreshSystemInfo = useCallback(async () => {
    setSystemRefreshing(true);
    try {
      const systemRes = await fetch("/api/system?refresh=1");
      if (systemRes.ok) {
        const data = (await systemRes.json()) as {
          ffmpeg: {
            available: boolean;
            version: string | null;
            reason: string | null;
            path: string | null;
            triedPaths?: string[];
            envOverrideSet?: boolean;
            hardwareAcceleration: "vaapi" | null;
            hardwareDevice: string | null;
            checkedAt?: string;
          };
          thumbnails: { dir: string; fallbackDir?: string; fileCount: number | null; maxAgeDays: number; writable?: boolean; usingFallback?: boolean; lastError?: string | null };
        };
        setSystemInfo(data);
      }
    } catch {
      // ignore
    } finally {
      setSystemRefreshing(false);
    }
  }, []);

  const saveAdvanced = async () => {
    setAdvancedSaving(true);
    setAdvancedResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uaList, proxyList }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      setAdvancedResult(
        res.ok && data.success
          ? { success: "Saved. Proxy/UA settings apply to the next scan and quality check." }
          : { error: data.error || "Could not save the advanced settings" }
      );
    } catch {
      setAdvancedResult({ error: "Could not save the advanced settings" });
    } finally {
      setAdvancedSaving(false);
    }
  };

  const validateProxyPool = async () => {
    setProxyChecking(true);
    setAdvancedResult(null);
    try {
      // Save the pool first so validation always checks what the scanner will use.
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyList }),
      });
      const res = await fetch("/api/scan/proxies", { method: "PUT" });
      const data = (await res.json()) as {
        checked?: number;
        working?: number;
        results?: Array<{ ok: boolean; latencyMs: number | null; display?: string }>;
        error?: string;
      };
      if (!res.ok) {
        setAdvancedResult({ error: data.error || "Proxy validation failed" });
        return;
      }
      setProxyChecks(data.results || []);
      setAdvancedResult({ success: `Checked ${data.checked ?? 0} proxy(ies): ${data.working ?? 0} working.` });
    } catch {
      setAdvancedResult({ error: "Proxy validation failed" });
    } finally {
      setProxyChecking(false);
    }
  };

  /** Login-check + sample an Xtream Codes account. */
  const checkXtream = async (measure: boolean) => {
    if (!xtreamUrl.trim()) {
      setXtreamResult("Paste an Xtream URL containing username and password");
      return;
    }
    setXtreamBusy(true);
    setXtreamResult(null);
    try {
      if (!measure) {
        const res = await fetch(`/api/scan/xtream?url=${encodeURIComponent(xtreamUrl.trim())}`);
        const data = (await res.json()) as {
          auth?: boolean;
          account?: { status: string | null; expiryDate: string | null; maxConnections: string | null; activeConnections: string | null } | null;
          error?: string;
        };
        setXtreamResult(
          res.ok && data.auth
            ? `Login OK — status ${data.account?.status ?? "?"}, expires ${data.account?.expiryDate ?? "?"}, connections ${data.account?.activeConnections ?? "?"}/${data.account?.maxConnections ?? "?"}`
            : `Login failed: ${data.error || "no account data"}`
        );
        return;
      }
      const res = await fetch("/api/scan/xtream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: xtreamUrl.trim(), channels: 3, sampleMs: 8000 }),
      });
      const data = (await res.json()) as {
        account?: { liveStreams: number; categories: number; status: string | null };
        report?: { aggregate: { overallScore: number | null; verdict: string; channelsPlayable: number; channelsProbed: number; label: string } };
        error?: string;
      };
      if (!res.ok || !data.report) {
        setXtreamResult(`Xtream check failed: ${data.error || "unknown error"}`);
        return;
      }
      setXtreamResult(
        `Xtream OK — ${data.account?.liveStreams ?? 0} live stream(s) in ${data.account?.categories ?? 0} categories. ` +
          `Sampled ${data.report.aggregate.channelsPlayable}/${data.report.aggregate.channelsProbed} playable, score ${
            data.report.aggregate.overallScore ?? "—"
          }/10 (${data.report.aggregate.verdict}).`
      );
    } catch {
      setXtreamResult("Xtream check failed");
    } finally {
      setXtreamBusy(false);
    }
  };

  /** Tiny sparkline (SVG) for a run history. */
  const renderSparkline = (runs: HistoryRun[]) => {
    const points = runs
      .slice()
      .reverse()
      .map((run) => run.overall)
      .filter((value): value is number => typeof value === "number");
    if (points.length < 2) return <span className="text-xs text-gray-600">not enough history yet</span>;
    const width = 120;
    const height = 28;
    const step = width / Math.max(points.length - 1, 1);
    const path = points
      .map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${(height - (value / 10) * height).toFixed(1)}`)
      .join(" ");
    return (
      <svg width={width} height={height} className="overflow-visible">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className={scoreColor(points[points.length - 1])} />
        {points.map((value, index) => (
          <circle
            key={index}
            cx={(index * step).toFixed(1)}
            cy={(height - (value / 10) * height).toFixed(1)}
            r="1.6"
            className={`fill-current ${scoreColor(value)}`}
          />
        ))}
      </svg>
    );
  };

  /** Colour a stream-quality verdict for the results table. */
  const verdictColor = (verdict: string | null | undefined): string => {
    switch ((verdict || "").toLowerCase()) {
      case "excellent":
        return "text-green-300";
      case "good":
        return "text-emerald-300";
      case "fair":
        return "text-yellow-300";
      case "poor":
        return "text-orange-300";
      case "unusable":
        return "text-red-300";
      default:
        return "text-gray-400";
    }
  };

  const scoreColor = (score: number | null | undefined): string => {
    if (score === null || score === undefined || !Number.isFinite(score)) return "text-gray-400";
    if (score >= 7) return "text-green-300";
    if (score >= 5) return "text-yellow-300";
    return "text-red-300";
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
   * Enable/disable automatic console-log refresh while a scan is running.
   * Results, progress and the job status keep polling regardless — only the
   * log list is frozen. The choice is remembered across reloads.
   */
  const toggleLogAutoRefresh = () => {
    const next = !logAutoRefresh;
    logAutoRefreshRef.current = next;
    setLogAutoRefreshPreference(next);
    // Re-enabling should show the newest lines right away instead of waiting
    // for the next poll tick.
    if (next) void pollStatus(true);
  };

  /** Pull the console log once, even while auto-refresh is paused. */
  const refreshLogsNow = () => {
    void pollStatus(true);
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
            width={384}
            height={384}
            className="w-96 h-96 max-w-[85vw] max-h-[85vw] mx-auto mb-6 rounded-2xl object-cover animate-pulse shadow-lg shadow-cyan-950/40"
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
        <div style={{ maxWidth: "80rem", margin: "0 auto", padding: "0.75rem 1rem", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", flexWrap: "wrap", flex: "1 1 auto" }}>
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
            <div role="group" aria-label="Scan actions" className="flex items-center gap-1 rounded-lg border border-gray-700/80 bg-gray-950/60 p-1">
              <button
                onClick={isStopped ? handleStart : handleStop}
                disabled={isLoading || (isStopped && !portalUrl.trim())}
                aria-label={isStopped ? "Start scan" : "Stop scan"}
                title={isStopped ? "Start scan" : "Stop scan"}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isStopped ? "bg-cyan-700 hover:bg-cyan-600" : "bg-red-700 hover:bg-red-600"
                }`}
              >
                {isLoading ? (isStopped ? "⏳ Starting" : "⏳ Stopping") : isStopped ? "🚀 Start" : "⏹ Stop"}
              </button>
              {activeJobId && results.length > 0 && (
                <>
                  <button
                    onClick={() => handleDownload("csv")}
                    aria-label="Download CSV"
                    title="Download CSV"
                    className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-800"
                  >
                    📥 CSV
                  </button>
                  <button
                    onClick={() => handleDownload("txt")}
                    aria-label="Download TXT"
                    title="Download TXT"
                    className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-800"
                  >
                    📥 TXT
                  </button>
                </>
              )}
            </div>
            <button
              onClick={() => setShowScheduleSettings(true)}
              className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
              title="Work schedule settings"
            >
              ⏰ Schedule
            </button>
            <button
              onClick={() => {
                setShowAdvanced(true);
                void loadAdvanced();
              }}
              className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
              title="Proxies, user agents, capability detection, Xtream and monitoring"
            >
              🧰 Advanced
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

      {/* Advanced panel: proxies, user agents, capabilities, Xtream, monitors */}
      {showAdvanced && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-200">🧰 Advanced</h2>
              <button onClick={() => setShowAdvanced(false)} className="text-gray-400 hover:text-gray-200">
                ✕
              </button>
            </div>

            {/* Capabilities */}
            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-gray-300">Host capabilities</p>
                <button
                  onClick={() => void refreshSystemInfo()}
                  disabled={systemRefreshing}
                  className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded text-gray-200"
                  title="Re-run FFmpeg detection (also clears the cached result after pulling a new image or fixing FFMPEG_PATH)"
                >
                  {systemRefreshing ? "Checking…" : "↻ Re-check"}
                </button>
              </div>
              {systemInfo ? (
                <div className="space-y-1 text-xs text-gray-400">
                  <p>
                    <span className="text-gray-500">ffmpeg:</span>{" "}
                    {systemInfo.ffmpeg.available ? (
                      <span className="text-green-300">
                        available ({systemInfo.ffmpeg.version || "version unknown"}
                        {systemInfo.ffmpeg.path ? ` · ${systemInfo.ffmpeg.path}` : ""})
                      </span>
                    ) : (
                      <span className="text-yellow-300">not found — picture checks/thumbnails are unavailable</span>
                    )}
                  </p>
                  {!systemInfo.ffmpeg.available && systemInfo.ffmpeg.reason && (
                    <p className="rounded border border-yellow-900/70 bg-yellow-950/20 p-2 text-yellow-200/90 break-words">
                      {systemInfo.ffmpeg.reason}
                    </p>
                  )}
                  <p>
                    <span className="text-gray-500">Video decode:</span>{" "}
                    {!systemInfo.ffmpeg.available ? (
                      <span className="text-gray-400">unavailable until FFmpeg is installed</span>
                    ) : systemInfo.ffmpeg.hardwareAcceleration === "vaapi" ? (
                      <span className="text-green-300">
                        VAAPI candidate on <code>{systemInfo.ffmpeg.hardwareDevice}</code> (tested per decode; software fallback enabled)
                      </span>
                    ) : (
                      <span className="text-gray-400">software decode (VAAPI support/device not detected or acceleration disabled)</span>
                    )}
                  </p>
                  <p className="text-gray-500">
                    The Docker image includes FFmpeg. When enabled, VAAPI is attempted only if supported and an Intel DRI
                    device is accessible; failed hardware decoding retries in software. For local runs, install ffmpeg or set{" "}
                    <code>FFMPEG_PATH</code> (leave it unset inside Docker — the bundled binary is found on PATH).
                  </p>
                  <p>
                    <span className="text-gray-500">Thumbnails:</span>{" "}
                    {systemInfo.thumbnails.fileCount ?? 0} file(s) in <code>{systemInfo.thumbnails.dir}</code> (kept{" "}
                    {systemInfo.thumbnails.maxAgeDays} days)
                    {systemInfo.thumbnails.writable === false && (
                      <span className="text-yellow-300">
                        {" "}— directory is not writable by the app user (uid 1001); check the volume permissions.
                      </span>
                    )}
                  </p>
                  {systemInfo.thumbnails.usingFallback && (
                    <p className="text-xs text-yellow-300">
                      Writes fall back to <code>{systemInfo.thumbnails.fallbackDir ?? "/tmp/macattack-thumbnails"}</code>{" "}
                      (cleared when the container is recreated). Fix the mount permissions to keep thumbnails in the data
                      directory
                      {systemInfo.thumbnails.lastError ? ` — ${systemInfo.thumbnails.lastError}` : ""}.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Detecting…</p>
              )}
            </div>

            {/* User agents */}
            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
              <p className="text-sm font-semibold text-gray-300 mb-1">User-agent candidates</p>
              <p className="text-xs text-gray-500 mb-2">
                Tried in order when the default MAG user agent is refused; the first working one is remembered per
                portal host. One per line, max 20. Leave empty for the built-in list (MAG200/MAG254/MAG250/VLC/Chrome).
              </p>
              <textarea
                value={uaList}
                onChange={(e) => setUaList(e.target.value)}
                rows={3}
                placeholder={"Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3"}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* Proxy pool */}
            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-300">Proxy pool (optional)</p>
              <p className="text-xs text-gray-500">
                One proxy per line: <code>host:port</code> or <code>user:pass@host:port</code> (max 50). The first
                enabled proxy is used for stream probes/quality checks, which gives you a second vantage point when a
                stream looks geo-blocked. Portal scans keep going direct so the MAC checks stay fast.
              </p>
              <textarea
                value={proxyList}
                onChange={(e) => setProxyList(e.target.value)}
                rows={3}
                placeholder={"127.0.0.1:8888\nuser:pass@proxy.example.com:8080"}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void saveAdvanced()}
                  disabled={advancedSaving}
                  className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 rounded text-white"
                >
                  {advancedSaving ? "Saving…" : "Save settings"}
                </button>
                <button
                  onClick={() => void validateProxyPool()}
                  disabled={proxyChecking || !proxyList.trim()}
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded text-gray-200"
                >
                  {proxyChecking ? "Validating…" : "Validate proxies"}
                </button>
              </div>
              {proxyChecks.length > 0 && (
                <ul className="text-xs space-y-0.5">
                  {proxyChecks.map((check, index) => (
                    <li key={index} className={check.ok ? "text-green-300" : "text-red-300"}>
                      {check.ok ? "✓" : "✕"} {check.display || `proxy ${index + 1}`}{" "}
                      {check.latencyMs != null ? `· ${check.latencyMs} ms` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {advancedResult?.success && <p className="text-xs text-green-300">{advancedResult.success}</p>}
              {advancedResult?.error && <p className="text-xs text-red-300">{advancedResult.error}</p>}
            </div>

            {/* Monitoring */}
            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-300">Monitoring &amp; alerts</p>
              <p className="text-xs text-gray-500">
                Enable “Monitor” on any found MAC to re-check it on an interval. Checks run when you press the button
                below (or when a cron job hits <code>PUT /api/scan/monitors</code>) — nothing runs in the background,
                and no data leaves your host.
              </p>
              <button
                onClick={() => void runDueMonitors()}
                className="px-3 py-1.5 text-xs bg-amber-700 hover:bg-amber-600 rounded text-white"
              >
                Run due checks now
              </button>
              {monitorRunResult && <p className="text-xs text-amber-200">{monitorRunResult}</p>}
            </div>

            {/* Xtream */}
            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-300">Xtream Codes account check</p>
              <p className="text-xs text-gray-500">
                Paste an Xtream URL that contains the credentials, e.g.{" "}
                <code>http://host:8080/get.php?username=USER&amp;password=PASS&amp;type=m3u_plus</code>. Login is
                checked first; the deep check samples live streams with the same measurement engine as Stalker results.
              </p>
              <input
                type="text"
                value={xtreamUrl}
                onChange={(e) => setXtreamUrl(e.target.value)}
                placeholder="http://host:8080/player_api.php?username=…&password=…"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void checkXtream(false)}
                  disabled={xtreamBusy}
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 rounded text-gray-200"
                >
                  {xtreamBusy ? "Working…" : "Check login"}
                </button>
                <button
                  onClick={() => void checkXtream(true)}
                  disabled={xtreamBusy}
                  className="px-3 py-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 rounded text-white"
                >
                  {xtreamBusy ? "Working…" : "Check + sample streams"}
                </button>
              </div>
              {xtreamResult && <p className="text-xs text-cyan-200">{xtreamResult}</p>}
            </div>
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

                {/* Scan scope: enumerate a prefix, or check a pasted MAC list */}
                <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-300">Scan scope</span>
                    <div className="flex rounded-lg overflow-hidden border border-gray-700">
                      <button
                        type="button"
                        onClick={() => setScanMode("prefix")}
                        disabled={isRunning}
                        className={`px-3 py-1.5 text-xs ${scanMode === "prefix" ? "bg-cyan-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"} disabled:opacity-50`}
                      >
                        Enumerate prefix
                      </button>
                      <button
                        type="button"
                        onClick={() => setScanMode("list")}
                        disabled={isRunning}
                        className={`px-3 py-1.5 text-xs ${scanMode === "list" ? "bg-cyan-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"} disabled:opacity-50`}
                      >
                        Bulk MAC list
                      </button>
                    </div>
                  </div>

                  {scanMode === "prefix" ? (
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
                  ) : (
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1.5">
                        MAC list (one per line, max 5,000)
                      </label>
                      <textarea
                        value={macList}
                        onChange={(e) => setMacList(e.target.value)}
                        placeholder={"00:1A:79:12:34:56\n00:1A:79:AA:BB:CC  # shop box\n00:11:22:33:44:55,00:11:22:33:44:66"}
                        rows={5}
                        disabled={isRunning}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Accepts commas, spaces, dashes and <em>portal|mac</em> pairs. Duplicates are removed;
                        unusable entries are reported after the job is queued.
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1.5">
                      Additional portals (optional, one per line)
                    </label>
                    <textarea
                      value={extraPortals}
                      onChange={(e) => setExtraPortals(e.target.value)}
                      placeholder={"http://backup-portal.example.com/c/\nhttp://another.example.net:8080/c/"}
                      rows={2}
                      disabled={isRunning}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs font-mono text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Multi-portal run: portals are rotated per block, so a dead server cannot stall the scan and a
                      valid MAC is retried against the next portal (second-chance re-check).
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1.5">
                      Parallel MAC checks
                    </label>
                    <select
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                      disabled={isRunning}
                      className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    >
                      <option value={1}>1 — sequential (gentlest, default)</option>
                      <option value={2}>2 workers</option>
                      <option value={4}>4 workers</option>
                      <option value={6}>6 workers</option>
                      <option value={8}>8 workers (capped; rate-limited per portal)</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Parallelism is capped at 8 and rate-limited per portal host to avoid getting the scanner
                      blocked. Higher values also apply to quality checks (max 4 channel probes at once).
                    </p>
                  </div>
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

            {/* Stream quality check */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={qualityCheckEnabled}
                  onChange={(e) => setQualityCheckEnabled(e.target.checked)}
                  disabled={isRunning}
                  className="mt-1 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                />
                <span>
                  <span className="text-sm font-semibold text-gray-200">
                    🎚️ Stream quality check for every found MAC
                  </span>
                  <span className="block text-xs text-gray-500 mt-1">
                    When a MAC passes the filters, MacAttack lists the portal&apos;s channels, resolves real
                    stream URLs with <em>create_link</em> and measures throughput vs. required bitrate,
                    resolution/codec and transport-stream stability. Adds roughly 10–30 seconds per found MAC.
                  </span>
                </span>
              </label>

              {qualityCheckEnabled && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-xs text-gray-400">Channels to probe (1–8)</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={qualityChannels}
                      onChange={(e) => setQualityChannels(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                      disabled={isRunning}
                      className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    />
                    <span className="block text-xs text-gray-500 mt-1">
                      Spread across genres so one broken category cannot dominate the verdict.
                    </span>
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-400">Sample per channel (3–30 seconds)</span>
                    <input
                      type="number"
                      min={3}
                      max={30}
                      value={Math.round(qualitySampleMs / 1000)}
                      onChange={(e) => setQualitySampleMs(Math.max(3, Math.min(30, Number(e.target.value) || 8)) * 1000)}
                      disabled={isRunning}
                      className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    />
                    <span className="block text-xs text-gray-500 mt-1">
                      Longer windows catch stalls and bitrate dips; shorter windows keep scans fast.
                    </span>
                  </label>
                </div>
              )}

              {qualityCheckEnabled && (
                <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                    Optional add-ons
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={uaRotationEnabled}
                        onChange={(e) => setUaRotationEnabled(e.target.checked)}
                        disabled={isRunning}
                        className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                      />
                      <span className="text-xs text-gray-300">
                        User-agent rotation
                        <span className="block text-gray-500">
                          Try MAG/VLC/browser user agents when a portal refuses the default one, then remember the
                          winner for that host.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={catchUpCheckEnabled}
                        onChange={(e) => setCatchUpCheckEnabled(e.target.checked)}
                        disabled={isRunning}
                        className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                      />
                      <span className="text-xs text-gray-300">
                        Catch-up (archive) verification
                        <span className="block text-gray-500">
                          When the portal advertises an archive, request a past programme and verify it actually
                          resolves and plays.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pictureChecksEnabled}
                        onChange={(e) => setPictureChecksEnabled(e.target.checked)}
                        disabled={isRunning}
                        className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                      />
                      <span className="text-xs text-gray-300">
                        Picture checks (freeze / black / fps)
                        <span className="block text-gray-500">
                          Uses the FFmpeg bundled in the Docker image. Local source runs without FFmpeg still
                          measure streams for speed/stability, but skip picture checks.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={thumbnailsEnabled}
                        onChange={(e) => setThumbnailsEnabled(e.target.checked)}
                        disabled={isRunning}
                        className="mt-0.5 w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700"
                      />
                      <span className="text-xs text-gray-300">
                        Stream thumbnails
                        <span className="block text-gray-500">
                          Capture one JPEG per probed channel with FFmpeg so you can see what you found.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              )}
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
                {fieldOrder.map((fieldKey) => {
                  const field = AVAILABLE_FIELDS.find((availableField) => availableField.key === fieldKey);
                  if (!field) return null;

                  return (
                    <div
                      key={field.key}
                      onDragOver={(event) => {
                        if (isRunning) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDragOverField(field.key);
                      }}
                      onDrop={(event) => {
                        if (isRunning) return;
                        event.preventDefault();
                        const sourceKey = event.dataTransfer.getData("text/plain") || draggedField;
                        if (sourceKey) reorderOutputField(sourceKey, field.key);
                        setDraggedField(null);
                        setDragOverField(null);
                      }}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                        dragOverField === field.key
                          ? "border-cyan-500 bg-cyan-950/40"
                          : "border-transparent hover:bg-gray-800"
                      } ${draggedField === field.key ? "opacity-50" : ""}`}
                    >
                      <button
                        type="button"
                        draggable={!isRunning}
                        disabled={isRunning}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", field.key);
                          setDraggedField(field.key);
                        }}
                        onDragEnd={() => {
                          setDraggedField(null);
                          setDragOverField(null);
                        }}
                        onKeyDown={(event) => {
                          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                          const index = fieldOrder.indexOf(field.key);
                          const targetIndex = index + (event.key === "ArrowUp" ? -1 : 1);
                          const targetKey = fieldOrder[targetIndex];
                          if (!targetKey) return;
                          event.preventDefault();
                          reorderOutputField(field.key, targetKey);
                        }}
                        aria-label={`Reorder ${field.label}`}
                        title="Drag to reorder (or use Alt + arrow keys)"
                        className="shrink-0 cursor-grab text-lg leading-none text-gray-500 hover:text-cyan-300 active:cursor-grabbing disabled:cursor-not-allowed"
                      >
                        ⠿
                      </button>
                      <label className="flex min-w-0 flex-1 items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedFields.includes(field.key)}
                          onChange={() => toggleField(field.key)}
                          disabled={isRunning || (field.key === "macAddress" && selectedFields.length === 1)}
                          className="w-4 h-4 rounded border-gray-600 text-cyan-500 focus:ring-cyan-500 bg-gray-700 disabled:opacity-50"
                        />
                        <span className="text-sm text-gray-300">{field.label}</span>
                      </label>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {selectedFields.length} of {AVAILABLE_FIELDS.length} fields selected
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Drag the ⠿ handle to change the results-table and CSV/TXT column order. The
                order is saved automatically — it survives reloads and applies to the next scan.
                {fieldOrderSaveState === "saving" && (
                  <span className="text-gray-400"> Saving…</span>
                )}
                {fieldOrderSaveState === "saved" && (
                  <span className="text-green-400"> Order saved ✓</span>
                )}
                {fieldOrderSaveState === "error" && (
                  <span className="text-amber-300">
                    {" "}
                    Could not save the order — it is kept for this session only.
                  </span>
                )}
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
                            {selectedFields.map((field) =>
                              field === "quality" ? (
                                <td key={field} className="px-3 py-2 min-w-44">
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
                                  {result.qualityVerdict && result.qualityVerdict !== "unknown" ? (
                                    <>
                                      <p className={`text-xs mt-0.5 font-medium ${verdictColor(result.qualityVerdict)}`}>
                                        Streams: {result.qualityVerdict}
                                        {result.qualityScore != null ? ` · ${result.qualityScore}/10` : ""}
                                      </p>
                                      <p className="text-xs text-gray-400 mt-0.5">
                                        {result.qualityResolution ?? "resolution n/a"}
                                        {result.qualityThroughputMbps != null ? ` · ${result.qualityThroughputMbps.toFixed(2)} Mbps` : ""}
                                        {result.qualityChannelsProbed != null
                                          ? ` · ${result.qualityChannelsPlayable ?? 0}/${result.qualityChannelsProbed} playable`
                                          : ""}
                                      </p>
                                    </>
                                  ) : (
                                    <p className="text-xs text-amber-300 mt-0.5">Streams not measured</p>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setExpandedQualityId((current) => current === result.id ? null : result.id)}
                                    aria-expanded={expandedQualityId === result.id}
                                    className="mt-1 whitespace-nowrap px-2 py-1 text-xs text-amber-200 hover:text-amber-100 border border-amber-900 rounded"
                                  >
                                    {expandedQualityId === result.id ? "Hide quality" : "Quality details"}
                                  </button>
                                </td>
                              ) : (
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
                              )
                            )}
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
                              <td colSpan={selectedFields.length + 2} className="px-4 py-4 bg-gray-950/70">
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

                                    {/* ── Measured stream quality (real media path) ── */}
                                    <div className="rounded-lg border border-cyan-900/60 bg-cyan-950/10 p-3 space-y-2">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                          <p className="text-xs font-semibold text-cyan-200">
                                            Measured stream quality (real media path)
                                          </p>
                                          <p className="text-xs text-gray-400 mt-0.5">
                                            Probe of the channels this MAC can open: throughput vs. required bitrate,
                                            resolution/codec, and transport-stream stability.
                                          </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <button
                                            type="button"
                                            onClick={() => void recheckQuality(result.id)}
                                            disabled={qualityActionId === result.id}
                                            className="px-2 py-1 text-xs text-cyan-200 hover:text-cyan-100 border border-cyan-800 rounded disabled:opacity-50"
                                          >
                                            {qualityActionId === result.id ? "Measuring…" : "Re-check streams"}
                                          </button>
                                          <a
                                            href={`/api/scan/playlist?resultId=${result.id}&limit=200`}
                                            className="px-2 py-1 text-xs text-green-200 hover:text-green-100 border border-green-900 rounded"
                                          >
                                            Download M3U
                                          </a>
                                          <button
                                            type="button"
                                            onClick={() => void loadQualityDetail(result.id)}
                                            disabled={qualityDetailLoadingId === result.id}
                                            className="px-2 py-1 text-xs text-gray-300 hover:text-gray-100 border border-gray-700 rounded disabled:opacity-50"
                                          >
                                            {qualityDetailLoadingId === result.id ? "Loading…" : "Per-channel detail"}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => void loadProbeHistory(result.id)}
                                            disabled={historyLoadingId === result.id}
                                            className="px-2 py-1 text-xs text-purple-200 hover:text-purple-100 border border-purple-900 rounded disabled:opacity-50"
                                          >
                                            {historyLoadingId === result.id ? "Loading…" : "Trend history"}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => void createPlaylistToken(result.id)}
                                            className="px-2 py-1 text-xs text-green-200 hover:text-green-100 border border-green-900 rounded"
                                            title="Creates a stable, revocable M3U subscription URL you can paste into a player"
                                          >
                                            Subscription URL
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const current = monitorByResult[result.id];
                                              if (current === undefined) {
                                                void loadMonitor(result.id).then(() =>
                                                  void toggleMonitor(result.id, true)
                                                );
                                              } else {
                                                void toggleMonitor(result.id, !current || current.enabled !== 1);
                                              }
                                            }}
                                            disabled={monitorBusyId === result.id}
                                            className={`px-2 py-1 text-xs border rounded disabled:opacity-50 ${
                                              monitorByResult[result.id]?.enabled === 1
                                                ? "text-amber-200 border-amber-800"
                                                : "text-gray-300 border-gray-700 hover:text-gray-100"
                                            }`}
                                          >
                                            {monitorBusyId === result.id
                                              ? "Saving…"
                                              : monitorByResult[result.id]?.enabled === 1
                                                ? "Monitoring on"
                                                : "Monitor"}
                                          </button>
                                        </div>
                                      </div>

                                      {qualityActionError && <p className="text-xs text-red-300">{qualityActionError}</p>}

                                      {result.qualityVerdict ? (
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                          <div className="bg-gray-900 rounded-lg p-2">
                                            <p className="text-xs uppercase tracking-wide text-gray-500">Verdict</p>
                                            <p className={`text-sm font-medium ${verdictColor(result.qualityVerdict)}`}>
                                              {result.qualityVerdict}
                                            </p>
                                            <p className="text-xs text-gray-500 mt-0.5">
                                              overall {result.qualityScore ?? "—"}/10 · {result.qualityResolution ?? "resolution n/a"}
                                            </p>
                                          </div>
                                          <div className="bg-gray-900 rounded-lg p-2">
                                            <p className="text-xs uppercase tracking-wide text-gray-500">Speed</p>
                                            <p className={`text-sm font-mono ${scoreColor(result.qualitySpeedScore)}`}>
                                              {result.qualitySpeedScore ?? "—"}/10
                                            </p>
                                            <p className="text-xs text-gray-500 mt-0.5">
                                              {result.qualityThroughputMbps != null ? `${result.qualityThroughputMbps.toFixed(2)} Mbps delivered` : "no throughput figure"}
                                              {result.qualityRequiredMbps != null ? ` of ${result.qualityRequiredMbps.toFixed(2)} required` : ""}
                                            </p>
                                          </div>
                                          <div className="bg-gray-900 rounded-lg p-2">
                                            <p className="text-xs uppercase tracking-wide text-gray-500">Picture quality</p>
                                            <p className={`text-sm font-mono ${scoreColor(result.qualityQualityScore)}`}>
                                              {result.qualityQualityScore ?? "—"}/10
                                            </p>
                                            <p className="text-xs text-gray-500 mt-0.5">{result.qualityCodec ?? "codec unknown"}</p>
                                          </div>
                                          <div className="bg-gray-900 rounded-lg p-2">
                                            <p className="text-xs uppercase tracking-wide text-gray-500">Stability</p>
                                            <p className={`text-sm font-mono ${scoreColor(result.qualityStabilityScore)}`}>
                                              {result.qualityStabilityScore ?? "—"}/10
                                            </p>
                                            <p className="text-xs text-gray-500 mt-0.5">
                                              {result.qualityChannelsProbed != null
                                                ? `${result.qualityChannelsPlayable ?? 0}/${result.qualityChannelsProbed} channels playable`
                                                : "channels not probed"}
                                              {result.qualityCheckedAt ? ` · ${new Date(result.qualityCheckedAt).toLocaleString()}` : ""}
                                            </p>
                                          </div>
                                        </div>
                                      ) : (
                                        <p className="text-xs text-gray-500">
                                          No stream measurement recorded for this MAC yet — use “Re-check streams” to measure it now.
                                        </p>
                                      )}

                                      {/* Evidence badges: frozen picture, mislabels, retries, catch-up, history */}
                                      {result.qualityVerdict && (
                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                          {result.qualityFrozen === 1 && (
                                            <span className="px-2 py-0.5 rounded border border-red-900 bg-red-950/40 text-red-200">
                                              ❄ frozen picture detected
                                            </span>
                                          )}
                                          {result.qualityLabelMismatch && (
                                            <span className="px-2 py-0.5 rounded border border-yellow-900 bg-yellow-950/30 text-yellow-200">
                                              ⚠ {result.qualityLabelMismatch}
                                            </span>
                                          )}
                                          {!!result.qualityRetries && result.qualityRetries > 0 && (
                                            <span className="px-2 py-0.5 rounded border border-gray-700 text-gray-300">
                                              ↻ {result.qualityRetries} transient retr{result.qualityRetries === 1 ? "y" : "ies"}
                                            </span>
                                          )}
                                          {result.qualityThroughputCv != null && (
                                            <span className="px-2 py-0.5 rounded border border-gray-700 text-gray-300">
                                              throughput CV {result.qualityThroughputCv.toFixed(2)}
                                            </span>
                                          )}
                                          {result.qualityCatchUpStatus && result.qualityCatchUpStatus !== "not_checked" && (
                                            <span
                                              className={`px-2 py-0.5 rounded border ${
                                                result.qualityCatchUpStatus === "verified"
                                                  ? "border-green-900 text-green-200"
                                                  : result.qualityCatchUpStatus === "advertised_but_failed"
                                                    ? "border-orange-900 text-orange-200"
                                                    : "border-gray-700 text-gray-400"
                                              }`}
                                            >
                                              ⏪ catch-up {result.qualityCatchUpStatus.replace(/_/g, " ")}
                                              {result.qualityCatchUpDays ? ` (~${result.qualityCatchUpDays.toFixed(1)} d)` : ""}
                                            </span>
                                          )}
                                          {result.qualityEwma != null && (
                                            <span className="px-2 py-0.5 rounded border border-purple-900 text-purple-200">
                                              EWMA {result.qualityEwma.toFixed(1)}/10
                                              {result.qualityTrend && result.qualityTrend !== "insufficient_data"
                                                ? ` · ${result.qualityTrend}`
                                                : ""}
                                            </span>
                                          )}
                                          {result.qualityTrend === "degrading" && (
                                            <span className="px-2 py-0.5 rounded border border-orange-900 text-orange-200">
                                              ↘ degrading vs its own history
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {/* Genre aggregation (Wave 3) */}
                                      {result.qualityGenreSummary && result.qualityGenreSummary.length > 0 && (
                                        <div className="rounded border border-gray-800 bg-gray-950/40 p-2">
                                          <p className="text-xs text-gray-400 mb-1">Quality by genre (measured)</p>
                                          <div className="flex flex-wrap gap-2">
                                            {result.qualityGenreSummary.map((group) => (
                                              <span
                                                key={group.genreId ?? group.genreTitle}
                                                className="px-2 py-0.5 rounded border border-gray-700 text-xs text-gray-300"
                                              >
                                                {group.genreTitle}:{" "}
                                                <span className={scoreColor(group.averageOverall)}>
                                                  {group.averageOverall ?? "—"}/10
                                                </span>{" "}
                                                <span className="text-gray-500">
                                                  ({group.channelsPlayable}/{group.channelsProbed} playable)
                                                </span>
                                              </span>
                                            ))}
                                          </div>
                                          <p className="text-xs text-gray-600 mt-1">
                                            One sample per genre — use it to spot a broken category, not as a full
                                            genre audit.
                                          </p>
                                        </div>
                                      )}

                                      {/* Thumbnail from the newest measurement */}
                                      {result.qualityThumbnail && (
                                        <div className="flex items-center gap-3">
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img
                                            src={`/api/scan/thumbnail?name=${encodeURIComponent(result.qualityThumbnail)}`}
                                            alt="Captured stream frame"
                                            className="h-20 rounded border border-gray-700"
                                          />
                                          <p className="text-xs text-gray-500">
                                            Frame captured through ffmpeg at the moment of measurement. Stored on this
                                            host (never uploaded) and pruned after two weeks.
                                          </p>
                                        </div>
                                      )}

                                      {/* Stable subscription URL */}
                                      {playlistTokenByResult[result.id] && (
                                        <div className="rounded border border-green-900/60 bg-green-950/10 p-2">
                                          <p className="text-xs text-green-200">
                                            Stable subscription URL {copiedToken === playlistTokenByResult[result.id] ? "(copied)" : ""}
                                          </p>
                                          <code className="block text-xs text-gray-300 break-all mt-1">
                                            {playlistTokenByResult[result.id]}
                                          </code>
                                          <div className="flex gap-2 mt-2">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                void navigator.clipboard.writeText(playlistTokenByResult[result.id]);
                                                setCopiedToken(playlistTokenByResult[result.id]);
                                              }}
                                              className="px-2 py-0.5 text-xs border border-green-900 text-green-200 rounded"
                                            >
                                              Copy
                                            </button>
                                            <button
                                              type="button"
                                              onClick={async () => {
                                                const url = playlistTokenByResult[result.id];
                                                const token = url.split("token=")[1] || "";
                                                await fetch(`/api/scan/playlist-token?token=${encodeURIComponent(token)}`, {
                                                  method: "DELETE",
                                                });
                                                setPlaylistTokenByResult((current) => {
                                                  const next = { ...current };
                                                  delete next[result.id];
                                                  return next;
                                                });
                                              }}
                                              className="px-2 py-0.5 text-xs border border-red-900 text-red-300 rounded"
                                            >
                                              Revoke
                                            </button>
                                          </div>
                                        </div>
                                      )}

                                      {/* Monitoring state for this result */}
                                      {monitorByResult[result.id]?.enabled === 1 &&
                                        (() => {
                                          const activeMonitor = monitorByResult[result.id] as MonitorInfo;
                                          return (
                                            <p className="text-xs text-amber-200/80">
                                              Monitored every {activeMonitor.intervalMinutes} min ·
                                              {activeMonitor.lastRunAt
                                                ? ` last check ${new Date(activeMonitor.lastRunAt).toLocaleString()}`
                                                : " not checked yet"}
                                              {activeMonitor.lastAlertReason ? ` · ⚠ ${activeMonitor.lastAlertReason}` : ""}
                                            </p>
                                          );
                                        })()}

                                      {/* Trend history */}
                                      {historyByResult[result.id] && (
                                        <div className="rounded border border-purple-900/60 bg-purple-950/10 p-2 space-y-1">
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <p className="text-xs text-purple-200">
                                              Probe history: {historyByResult[result.id].runs.length} run(s) · EWMA{" "}
                                              {historyByResult[result.id].summary.ewma ?? "—"}/10 · trend{" "}
                                              {historyByResult[result.id].summary.trend.replace(/_/g, " ")} · worst{" "}
                                              {historyByResult[result.id].summary.worstOverall ?? "—"} / best{" "}
                                              {historyByResult[result.id].summary.bestOverall ?? "—"}
                                            </p>
                                            {renderSparkline(historyByResult[result.id].runs)}
                                          </div>
                                          <div className="max-h-40 overflow-y-auto">
                                            <table className="w-full text-xs">
                                              <thead>
                                                <tr className="text-gray-500">
                                                  <th className="text-left py-1 pr-3">When</th>
                                                  <th className="text-left py-1 pr-3">Overall</th>
                                                  <th className="text-left py-1 pr-3">Verdict</th>
                                                  <th className="text-left py-1 pr-3">Notes</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {historyByResult[result.id].runs.slice(0, 20).map((run) => (
                                                  <tr key={run.id} className="border-t border-gray-800">
                                                    <td className="py-1 pr-3 text-gray-400">
                                                      {new Date(run.measuredAt).toLocaleString()}
                                                    </td>
                                                    <td className={`py-1 pr-3 font-mono ${scoreColor(run.overall)}`}>
                                                      {run.overall ?? "—"}
                                                    </td>
                                                    <td className={`py-1 pr-3 ${verdictColor(run.verdict)}`}>{run.verdict ?? "—"}</td>
                                                    <td className="py-1 pr-3 text-gray-500">
                                                      {[run.source, run.frozen ? "frozen" : null, run.labelMismatches ? `${run.labelMismatches} mislabeled` : null, run.viaProxy ? `via ${run.viaProxy}` : null]
                                                        .filter(Boolean)
                                                        .join(" · ") || "—"}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      )}

                                      {qualityDetailByResult[result.id] && (
                                        <div className="space-y-2">
                                          <p className="text-xs text-gray-400">
                                            {qualityDetailByResult[result.id].aggregate.label}
                                            {qualityDetailByResult[result.id].aggregate.headroomSummary
                                              ? ` · ${qualityDetailByResult[result.id].aggregate.headroomSummary}`
                                              : ""}
                                          </p>
                                          <div className="overflow-x-auto">
                                            <table className="w-full text-xs">
                                              <thead>
                                                <tr className="text-gray-500">
                                                  <th className="text-left py-1 pr-3">Channel</th>
                                                  <th className="text-left py-1 pr-3">Verdict</th>
                                                  <th className="text-left py-1 pr-3">Overall</th>
                                                  <th className="text-left py-1 pr-3">Speed</th>
                                                  <th className="text-left py-1 pr-3">Quality</th>
                                                  <th className="text-left py-1 pr-3">Stability</th>
                                                  <th className="text-left py-1">Evidence</th>
                                                </tr>
                                              </thead>
                                              <tbody className="divide-y divide-gray-800/60">
                                                {qualityDetailByResult[result.id].channels.map((channel, index) => (
                                                  <tr key={`${channel.name}-${index}`}>
                                                    <td className="py-1 pr-3 text-gray-300 max-w-48 truncate" title={channel.name}>
                                                      {channel.name}
                                                    </td>
                                                    <td className={`py-1 pr-3 ${verdictColor(channel.score?.verdict)}`}>
                                                      {channel.score?.verdict ?? channel.linkError ?? "not measured"}
                                                    </td>
                                                    <td className="py-1 pr-3 font-mono">{channel.score?.overall ?? "—"}</td>
                                                    <td className="py-1 pr-3 font-mono">{channel.score?.speed ?? "—"}</td>
                                                    <td className="py-1 pr-3 font-mono">{channel.score?.quality ?? "—"}</td>
                                                    <td className="py-1 pr-3 font-mono">{channel.score?.stability ?? "—"}</td>
                                                    <td className="py-1 text-gray-500 max-w-96 whitespace-pre-wrap break-words">
                                                      {channel.score?.evidence?.slice(0, 2).join(" · ") ?? "—"}
                                                      {channel.score?.penalties && channel.score.penalties.length > 0
                                                        ? `\n! ${channel.score.penalties.join(" · ")}`
                                                        : ""}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                          <ul className="list-disc pl-5 space-y-0.5 text-xs text-gray-500">
                                            {qualityDetailByResult[result.id].limitations.map((limitation) => (
                                              <li key={limitation}>{limitation}</li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
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
                                colSpan={selectedFields.length + 2}
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
                <div className="flex items-center gap-3 flex-wrap">
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

                  {/* Auto-refresh toggle */}
                  <div className="flex items-center gap-2 border-l border-gray-800 pl-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={logAutoRefresh}
                      aria-label="Auto-refresh console logs"
                      onClick={toggleLogAutoRefresh}
                      title={
                        logAutoRefresh
                          ? "Pause automatic log refresh"
                          : "Resume automatic log refresh"
                      }
                      className="flex items-center gap-2 px-2 py-1 text-xs rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 transition-colors"
                    >
                      <span
                        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                          logAutoRefresh ? "bg-green-600" : "bg-gray-600"
                        }`}
                      >
                        <span
                          className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                            logAutoRefresh ? "translate-x-3.5" : "translate-x-0.5"
                          }`}
                        />
                      </span>
                      <span className={logAutoRefresh ? "text-green-300" : "text-gray-400"}>
                        Auto-refresh {logAutoRefresh ? "on" : "off"}
                      </span>
                    </button>
                    {!logAutoRefresh && (
                      <button
                        type="button"
                        onClick={refreshLogsNow}
                        title="Fetch the latest log entries once"
                        className="px-2 py-1 text-xs rounded border border-blue-700/50 bg-blue-900/40 text-blue-300 hover:bg-blue-900/70 transition-colors"
                      >
                        🔄 Refresh now
                      </button>
                    )}
                  </div>
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
              <div className="px-4 py-2 bg-gray-900 border-t border-gray-800 text-xs text-gray-500 flex items-center justify-between flex-wrap gap-2">
                <span>
                  Showing {filteredLogs.length} of {logs.length} log entries
                </span>
                {logAutoRefresh ? (
                  logsUpdatedAt && (
                    <span className="text-gray-600">
                      Live · updated {logsUpdatedAt.toLocaleTimeString()}
                    </span>
                  )
                ) : (
                  <span className="text-yellow-400/90">
                    ⏸️ Auto-refresh paused
                    {logsUpdatedAt ? ` · last update ${logsUpdatedAt.toLocaleTimeString()}` : ""}
                  </span>
                )}
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
                  <strong className="text-gray-400">Auto-refresh:</strong>{" "}
                  Toggle <em>Auto-refresh</em> above the console to pause or resume live log
                  updates — handy for reading back through output while a scan runs. While paused
                  you can pull the newest entries on demand with <em>Refresh now</em>. The setting
                  is remembered in your browser.
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
