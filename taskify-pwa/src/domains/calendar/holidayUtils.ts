import type { CalendarEvent } from "../tasks/taskTypes";
import type { Weekday } from "../appTypes";
import { ISO_DATE_PATTERN } from "../appTypes";
import {
  formatDateKeyFromParts,
  nthWeekdayOfMonthDateKey,
  lastWeekdayOfMonthDateKey,
  observedUsHolidayDateKey,
  daysInCalendarMonth,
  monthKeyFromYearMonth,
  startOfDay,
} from "../dateTime/dateUtils";

const SPECIAL_CALENDAR_US_HOLIDAYS_ID = "special:us-holidays";

export function easterDateKey(year: number): string | null {
  if (!Number.isFinite(year)) return null;
  const y = Math.trunc(year);
  if (y < 1583) return null;
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return formatDateKeyFromParts(y, month, day);
}

type UsHolidayDefinition = {
  id: string;
  title: string;
  dateForYear: (year: number) => string | null;
  includeObserved?: boolean;
  summary?: string;
};

export function buildUsHolidayCalendarEvents(startYear: number, endYear: number): CalendarEvent[] {
  const fromYear = Math.min(startYear, endYear);
  const toYear = Math.max(startYear, endYear);
  const definitions: UsHolidayDefinition[] = [
    {
      id: "new-years-day",
      title: "New Year's Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 1, 1),
    },
    {
      id: "mlk-day",
      title: "Martin Luther King Jr. Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 0, 1, 3),
    },
    {
      id: "presidents-day",
      title: "Presidents Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 1, 1, 3),
    },
    {
      id: "valentines-day",
      title: "Valentine's Day",
      dateForYear: (year) => formatDateKeyFromParts(year, 2, 14),
      summary: "US holiday",
    },
    {
      id: "easter",
      title: "Easter",
      dateForYear: (year) => easterDateKey(year),
      summary: "US holiday",
    },
    {
      id: "memorial-day",
      title: "Memorial Day",
      dateForYear: (year) => lastWeekdayOfMonthDateKey(year, 4, 1),
    },
    {
      id: "juneteenth",
      title: "Juneteenth",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 6, 19),
    },
    {
      id: "independence-day",
      title: "Independence Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 7, 4),
    },
    {
      id: "labor-day",
      title: "Labor Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 8, 1, 1),
    },
    {
      id: "columbus-day",
      title: "Columbus Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 9, 1, 2),
    },
    {
      id: "veterans-day",
      title: "Veterans Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 11, 11),
    },
    {
      id: "thanksgiving-day",
      title: "Thanksgiving Day",
      dateForYear: (year) => nthWeekdayOfMonthDateKey(year, 10, 4, 4),
    },
    {
      id: "christmas-eve",
      title: "Christmas Eve",
      dateForYear: (year) => formatDateKeyFromParts(year, 12, 24),
      summary: "US holiday",
    },
    {
      id: "christmas-day",
      title: "Christmas Day",
      includeObserved: true,
      dateForYear: (year) => formatDateKeyFromParts(year, 12, 25),
    },
  ];

  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  const addEvent = (id: string, title: string, dateKey: string, summary: string) => {
    if (!ISO_DATE_PATTERN.test(dateKey)) return;
    const dedupeKey = `${id}|${dateKey}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    events.push({
      id,
      kind: "date",
      boardId: SPECIAL_CALENDAR_US_HOLIDAYS_ID,
      title,
      summary,
      startDate: dateKey,
      readOnly: true,
    });
  };

  for (let year = fromYear; year <= toYear; year += 1) {
    definitions.forEach((definition) => {
      const dateKey = definition.dateForYear(year);
      if (!dateKey) return;
      addEvent(
        `us-holiday:${definition.id}:${year}`,
        definition.title,
        dateKey,
        definition.summary ?? "US federal holiday",
      );

      if (!definition.includeObserved) return;
      const observedDateKey = observedUsHolidayDateKey(dateKey);
      if (!observedDateKey) return;
      addEvent(
        `us-holiday:${definition.id}:${year}:observed`,
        `${definition.title} (Observed)`,
        observedDateKey,
        `${definition.summary ?? "US federal holiday"} (observed date)`,
      );
    });

    const dstStart = nthWeekdayOfMonthDateKey(year, 2, 0, 2);
    if (dstStart) {
      addEvent(
        `us-holiday:dst-start:${year}`,
        "Daylight Saving Time Begins",
        dstStart,
        "Clocks move forward one hour in most US time zones",
      );
    }

    const dstEnd = nthWeekdayOfMonthDateKey(year, 10, 0, 1);
    if (dstEnd) {
      addEvent(
        `us-holiday:dst-end:${year}`,
        "Daylight Saving Time Ends",
        dstEnd,
        "Clocks move back one hour in most US time zones",
      );
    }
  }

  events.sort((a, b) => {
    if (a.kind !== "date" || b.kind !== "date") return a.id.localeCompare(b.id);
    const dateDiff = a.startDate.localeCompare(b.startDate);
    if (dateDiff !== 0) return dateDiff;
    const titleDiff = a.title.localeCompare(b.title);
    if (titleDiff !== 0) return titleDiff;
    return a.id.localeCompare(b.id);
  });

  return events;
}

export function isUsHolidayCalendarEvent(event: CalendarEvent): boolean {
  return event.boardId === SPECIAL_CALENDAR_US_HOLIDAYS_ID;
}

export function hashStringToUint32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    if (j === i) continue;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

export type FastingRemindersMode = "weekday" | "random";

export function fastingReminderDueTimesForMonth(
  year: number,
  monthIndex: number,
  options: { mode: FastingRemindersMode; weekday: Weekday; perMonth: number; seed: string },
): number[] {
  const totalDays = daysInCalendarMonth(year, monthIndex);
  const perMonth = Number.isFinite(options.perMonth) ? Math.max(1, Math.round(options.perMonth)) : 1;
  if (options.mode === "weekday") {
    const out: number[] = [];
    for (let day = 1; day <= totalDays; day++) {
      const date = new Date(year, monthIndex, day);
      if ((date.getDay() as Weekday) !== options.weekday) continue;
      const midnight = startOfDay(date);
      if (!Number.isNaN(midnight.getTime())) out.push(midnight.getTime());
    }
    return out.slice(0, perMonth);
  }

  const candidates = Array.from({ length: totalDays }, (_, i) => i + 1);
  const rng = mulberry32(hashStringToUint32(`${options.seed}|${monthKeyFromYearMonth(year, monthIndex)}`));
  shuffleInPlace(candidates, rng);
  return candidates
    .slice(0, Math.min(perMonth, totalDays))
    .sort((a, b) => a - b)
    .map((day) => startOfDay(new Date(year, monthIndex, day)).getTime())
    .filter((time) => Number.isFinite(time) && !Number.isNaN(time));
}

/**
 * Date-derived id for a fasting reminder, identical on every client (native's
 * `TaskifySnapshot.fastingReminderTaskID`), so devices generating the same reminder
 * independently produce one task.
 */
export function fastingReminderTaskId(seriesId: string, dueTime: number): string {
  const date = new Date(dueTime);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${seriesId}:${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
