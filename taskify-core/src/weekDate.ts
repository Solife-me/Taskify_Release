import { startOfDay } from "./dateTime.js";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

function addDaysLocal(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfWeekLocal(date: Date, weekStart: Weekday): Date {
  const sd = startOfDay(date);
  const current = sd.getDay() as Weekday;
  const ws = weekStart === 1 || weekStart === 6 ? weekStart : 0;
  let diff = current - ws;
  if (diff < 0) diff += 7;
  return startOfDay(addDaysLocal(sd, -diff));
}

export function isoForWeekdayLocal(
  target: Weekday,
  options: { base?: Date; weekStart?: Weekday } = {},
): string {
  const { base = new Date(), weekStart = 0 } = options;
  const anchor = startOfWeekLocal(base, weekStart);
  const anchorDay = anchor.getDay() as Weekday;
  const offset = ((target - anchorDay) % 7 + 7) % 7;
  const day = startOfDay(addDaysLocal(anchor, offset));
  return day.toISOString();
}
