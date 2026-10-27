// Shared primitive constants and types extracted from App.tsx

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun

export const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const WD_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1);
export const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
export const MERIDIEMS = ["AM", "PM"] as const;
export type Meridiem = (typeof MERIDIEMS)[number];

export { ISO_DATE_PATTERN, MS_PER_DAY } from "taskify-core";

export const SATS_PER_BTC = 100_000_000;
