import { parseTimeValue } from "./dateTime.js";

export type BuiltinReminderPreset = "0h" | "5m" | "15m" | "30m" | "1h" | "1d" | "1w" | "0d";
export type CustomReminderPreset = `custom-${number}`;
export type ReminderPreset = BuiltinReminderPreset | CustomReminderPreset;
export type ReminderPresetMode = "timed" | "date";

export const DEFAULT_DATE_REMINDER_TIME = "09:00";

export const TIMED_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  { id: "0h", label: "At due/start time", badge: "0h", minutes: 0 },
  { id: "5m", label: "5 minutes before", badge: "5m", minutes: 5 },
  { id: "15m", label: "15 minutes before", badge: "15m", minutes: 15 },
  { id: "30m", label: "30 minutes before", badge: "30m", minutes: 30 },
  { id: "1h", label: "1 hour before", badge: "1h", minutes: 60 },
  { id: "1d", label: "1 day before", badge: "1d", minutes: 1440 },
];

export const DATE_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  { id: "1w", label: "1 week before", badge: "1w", minutes: 10080 },
  { id: "1d", label: "1 day before", badge: "1d", minutes: 1440 },
  { id: "0d", label: "On the day", badge: "day of", minutes: 0 },
];

export const BUILTIN_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  ...DATE_REMINDER_PRESETS,
  ...TIMED_REMINDER_PRESETS,
];

export const BUILTIN_REMINDER_IDS = new Set<BuiltinReminderPreset>(BUILTIN_REMINDER_PRESETS.map((opt) => opt.id));
export const BUILTIN_REMINDER_MINUTES = new Map<BuiltinReminderPreset, number>(BUILTIN_REMINDER_PRESETS.map((opt) => [opt.id, opt.minutes] as const));

export const MS_PER_DAY = 86400000;

export const CUSTOM_REMINDER_PATTERN = /^custom-(-?\d{1,8})$/;
export const MIN_CUSTOM_REMINDER_MINUTES = -99_999_999;
export const MAX_CUSTOM_REMINDER_MINUTES = 99_999_999;

export function clampCustomReminderMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_CUSTOM_REMINDER_MINUTES, Math.min(MAX_CUSTOM_REMINDER_MINUTES, Math.round(value)));
}

export function normalizeReminderTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parseTimeValue(value);
  if (!parsed) return undefined;
  return `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
}

export function minutesToReminderId(minutes: number): ReminderPreset {
  if (!Number.isFinite(minutes)) return "0d";
  const normalized = clampCustomReminderMinutes(minutes);
  if (normalized === 0) return "0d";
  for (const [id, builtinMinutes] of BUILTIN_REMINDER_MINUTES) {
    if (builtinMinutes === normalized) return id;
  }
  return `custom-${normalized}`;
}

export function reminderPresetIdForMode(minutes: number, mode: ReminderPresetMode): ReminderPreset {
  if (!Number.isFinite(minutes)) {
    return mode === "timed" ? "0h" : "0d";
  }
  const normalized = clampCustomReminderMinutes(minutes);
  if (normalized === 0) {
    return mode === "timed" ? "0h" : "0d";
  }
  return minutesToReminderId(normalized);
}

export function reminderPresetToMinutes(id: ReminderPreset): number {
  if (BUILTIN_REMINDER_IDS.has(id as BuiltinReminderPreset)) {
    return BUILTIN_REMINDER_MINUTES.get(id as BuiltinReminderPreset) ?? 0;
  }
  const match = typeof id === "string" ? id.match(CUSTOM_REMINDER_PATTERN) : null;
  if (!match) return 0;
  return clampCustomReminderMinutes(parseInt(match[1] ?? "0", 10));
}

export function formatReminderLabel(minutes: number): { label: string; badge: string } {
  if (!Number.isFinite(minutes)) {
    return {
      label: "On the day",
      badge: "day of",
    };
  }
  if (minutes === 0) {
    return {
      label: "On the day",
      badge: "day of",
    };
  }
  const mins = clampCustomReminderMinutes(minutes);
  const direction = mins < 0 ? "after" : "before";
  const signPrefix = mins < 0 ? "+" : "";
  const absMins = Math.abs(mins);
  if (absMins % 1440 === 0) {
    const days = absMins / 1440;
    return {
      label: `${days} day${days === 1 ? "" : "s"} ${direction}`,
      badge: `${signPrefix}${days}d`,
    };
  }
  if (absMins % 60 === 0) {
    const hours = absMins / 60;
    return {
      label: `${hours} hour${hours === 1 ? "" : "s"} ${direction}`,
      badge: `${signPrefix}${hours}h`,
    };
  }
  return {
    label: `${absMins} minute${absMins === 1 ? "" : "s"} ${direction}`,
    badge: `${signPrefix}${absMins}m`,
  };
}

export type ReminderOption = { id: ReminderPreset; label: string; badge: string; minutes: number; builtin: boolean };

export function buildReminderOptions(extraPresetIds: ReminderPreset[] = [], mode: ReminderPresetMode = "timed"): ReminderOption[] {
  const modePresets = mode === "date" ? DATE_REMINDER_PRESETS : TIMED_REMINDER_PRESETS;
  const options = new Map<ReminderPreset, ReminderOption>(
    modePresets.map((preset) => [preset.id, { ...preset, builtin: true }] as const),
  );
  const extras: ReminderOption[] = [];
  for (const id of extraPresetIds) {
    if (options.has(id)) continue;
    const minutes = reminderPresetToMinutes(id);
    if (!Number.isFinite(minutes)) continue;
    const { label, badge } = formatReminderLabel(minutes);
    extras.push({ id, label, badge, minutes, builtin: !String(id).startsWith("custom-") });
  }
  extras.sort((a, b) => a.minutes - b.minutes);
  return [...options.values(), ...extras];
}

export function sanitizeReminderList(value: unknown): ReminderPreset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dedupByMinutes = new Map<number, ReminderPreset>();
  const addByMinutes = (id: ReminderPreset) => {
    const minutes = reminderPresetToMinutes(id);
    if (!Number.isFinite(minutes)) return;
    if (!dedupByMinutes.has(minutes)) {
      dedupByMinutes.set(minutes, id);
    }
  };
  for (const item of value) {
    if (typeof item === "string") {
      if (BUILTIN_REMINDER_IDS.has(item as BuiltinReminderPreset)) {
        addByMinutes(item as ReminderPreset);
        continue;
      }
      if (CUSTOM_REMINDER_PATTERN.test(item)) {
        const minutes = reminderPresetToMinutes(item as ReminderPreset);
        if (Number.isFinite(minutes)) addByMinutes(minutesToReminderId(minutes));
      }
      continue;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      const remId = minutesToReminderId(item);
      addByMinutes(remId);
    }
  }
  const sorted = [...dedupByMinutes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, id]) => id);
  return sorted;
}
