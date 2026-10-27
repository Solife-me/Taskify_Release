/** How a repeat rule reads in the editors' "Repeat" and "End Repeat" rows. */
import { ISO_DATE_PATTERN } from "taskify-core";
import { isoDatePart } from "../dateTime/dateUtils";
import type { Recurrence, Weekday } from "./taskTypes";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function sameDays(days: readonly Weekday[], expected: readonly Weekday[]): boolean {
  return days.length === expected.length && expected.every((day) => days.includes(day));
}

/** The rule in the picker's own words where it is one of its presets ("Weekdays", "Biweekly"). */
export function recurrenceLabel(rule: Recurrence | null | undefined): string {
  if (!rule || rule.type === "none") return "Never";
  switch (rule.type) {
    case "daily":
      return "Daily";
    case "weekly": {
      const days = [...(rule.days ?? [])].sort((a, b) => a - b);
      if (!days.length) return "Weekly";
      if (days.length === 7) return "Every day";
      if (sameDays(days, [1, 2, 3, 4, 5])) return "Weekdays";
      if (sameDays(days, [0, 6])) return "Weekends";
      if (days.length === 1) return `Weekly on ${WEEKDAY_SHORT[days[0]]}`;
      return days.map((day) => WEEKDAY_SHORT[day]).join(", ");
    }
    case "every":
      if (rule.n === 1 && rule.unit === "hour") return "Hourly";
      if (rule.n === 2 && rule.unit === "week") return "Biweekly";
      return rule.n === 1 ? `Every ${rule.unit}` : `Every ${rule.n} ${rule.unit}s`;
    case "monthlyDay": {
      const interval = rule.interval && rule.interval > 1 ? rule.interval : 1;
      const base = interval === 12 ? "Yearly" : interval === 1 ? "Monthly" : `Every ${interval} months`;
      return `${base} (day ${rule.day})`;
    }
  }
}

/** When the repeat stops: "Never", or the last date as a calendar day in `timeZone`. */
export function endRepeatLabel(rule: Recurrence | null | undefined, timeZone?: string): string {
  if (!rule?.untilISO) return "Never";
  if (Number.isNaN(Date.parse(rule.untilISO))) return "Custom date";
  const dateKey = isoDatePart(rule.untilISO, timeZone);
  if (!ISO_DATE_PATTERN.test(dateKey)) return "Custom date";
  const day = new Date(`${dateKey}T00:00:00`);
  return day.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
