export const WEEKDAYS = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
] as const;

export type WeekdayKey = (typeof WEEKDAYS)[number]["key"];

export interface DaySchedule {
  enabled: boolean;
  start: string;
  end: string;
}

export type WeekSchedule = Record<WeekdayKey, DaySchedule>;

export interface ScheduleSettings {
  enabled: boolean;
  timezone: string;
  days: WeekSchedule;
}

export const DEFAULT_WEEK_SCHEDULE: WeekSchedule = {
  mon: { enabled: true, start: "09:00", end: "17:00" },
  tue: { enabled: true, start: "09:00", end: "17:00" },
  wed: { enabled: true, start: "09:00", end: "17:00" },
  thu: { enabled: true, start: "09:00", end: "17:00" },
  fri: { enabled: true, start: "09:00", end: "17:00" },
  sat: { enabled: false, start: "09:00", end: "17:00" },
  sun: { enabled: false, start: "09:00", end: "17:00" },
};

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  enabled: false,
  timezone: "UTC",
  days: DEFAULT_WEEK_SCHEDULE,
};

const WEEKDAY_BY_INTL: Record<string, WeekdayKey> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validateScheduleSettings(
  input: unknown
): { settings?: ScheduleSettings; error?: string } {
  if (!input || typeof input !== "object") {
    return { error: "Schedule settings are required" };
  }

  const candidate = input as Partial<ScheduleSettings>;
  if (typeof candidate.enabled !== "boolean") {
    return { error: "Schedule enabled must be true or false" };
  }
  if (typeof candidate.timezone !== "string" || !candidate.timezone.trim()) {
    return { error: "A schedule time zone is required" };
  }

  const timezone = candidate.timezone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { error: `Unknown time zone: ${timezone}` };
  }

  if (!candidate.days || typeof candidate.days !== "object") {
    return { error: "A weekly schedule is required" };
  }

  const days = {} as WeekSchedule;
  for (const { key, label } of WEEKDAYS) {
    const day = (candidate.days as Partial<WeekSchedule>)[key];
    if (
      !day ||
      typeof day.enabled !== "boolean" ||
      !isValidTime(day.start) ||
      !isValidTime(day.end)
    ) {
      return { error: `Please enter valid start and end times for ${label}` };
    }
    if (day.enabled && day.start === day.end) {
      return { error: `${label}: start and end times cannot be the same` };
    }
    days[key] = { enabled: day.enabled, start: day.start, end: day.end };
  }

  if (candidate.enabled && !Object.values(days).some((day) => day.enabled)) {
    return { error: "Enable at least one day, or disable the schedule to run anytime" };
  }

  return { settings: { enabled: candidate.enabled, timezone, days } };
}

export function parseScheduleSettings(
  enabledValue: string | null | undefined,
  timezoneValue: string | null | undefined,
  daysValue: string | null | undefined
): ScheduleSettings {
  let days: unknown;
  try {
    days = daysValue ? JSON.parse(daysValue) : DEFAULT_WEEK_SCHEDULE;
  } catch {
    days = DEFAULT_WEEK_SCHEDULE;
  }

  const parsed = validateScheduleSettings({
    enabled: enabledValue === "true",
    timezone: timezoneValue || DEFAULT_SCHEDULE_SETTINGS.timezone,
    days,
  });

  if (parsed.settings) return parsed.settings;

  // Corrupt or unsupported saved schedules must never silently become an
  // unrestricted run. Require an explicit repair in the settings UI.
  const closedDays = Object.fromEntries(
    WEEKDAYS.map(({ key }) => [key, { enabled: false, start: "09:00", end: "17:00" }])
  ) as WeekSchedule;
  return {
    enabled: enabledValue === "true",
    timezone: DEFAULT_SCHEDULE_SETTINGS.timezone,
    days: closedDays,
  };
}

/** Returns whether the schedule permits work at the given instant. */
export function isWithinSchedule(schedule: ScheduleSettings, now = new Date()): boolean {
  if (!schedule.enabled) return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = WEEKDAY_BY_INTL[values.weekday];
  if (!today) return false;

  const currentMinute = Number(values.hour) * 60 + Number(values.minute);
  const todayIndex = WEEKDAYS.findIndex((day) => day.key === today);
  const previousDay = WEEKDAYS[(todayIndex + 6) % 7].key;
  const todaySchedule = schedule.days[today];
  const previousSchedule = schedule.days[previousDay];

  if (todaySchedule.enabled) {
    const start = timeToMinutes(todaySchedule.start);
    const end = timeToMinutes(todaySchedule.end);
    // Equal times are rejected by validation, but treat malformed stored data as closed.
    if (start < end && currentMinute >= start && currentMinute < end) return true;
    if (start > end && currentMinute >= start) return true;
  }

  // An overnight window belongs to the day on which it started.
  if (previousSchedule.enabled) {
    const start = timeToMinutes(previousSchedule.start);
    const end = timeToMinutes(previousSchedule.end);
    if (start > end && currentMinute < end) return true;
  }

  return false;
}
