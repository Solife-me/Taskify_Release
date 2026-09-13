type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function parts(instant: Date, timeZone: string, offsetMinutes: number): LocalParts {
  try {
    const fields = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const n = (type: string) => Number(fields.find((field) => field.type === type)?.value);
    return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute') };
  } catch {
    const local = new Date(instant.getTime() - offsetMinutes * 60_000);
    return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
  }
}

function dayKey(value: Pick<LocalParts, 'year' | 'month' | 'day'>): string {
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

export function voiceLocalDates(referenceDate: string, timeZone: string, offsetMinutes: number) {
  const instant = new Date(referenceDate);
  const local = parts(Number.isNaN(instant.getTime()) ? new Date() : instant, timeZone, offsetMinutes);
  const after = (days: number) => {
    const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
    return dayKey({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
  };
  return { today: after(0), tomorrow: after(1), dayAfterTomorrow: after(2) };
}

function wallClockISO(day: string, hour: number, minute: number, timeZone: string, offsetMinutes: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  let guess = wall + offsetMinutes * 60_000;
  // Resolve using the offset on the target date, including daylight-saving transitions.
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = parts(new Date(guess), timeZone, offsetMinutes);
    const delta = wall - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess).toISOString();
}

/** Anchor relative days deterministically and resolve unqualified daytime appointment ranges. */
export function normalizeVoiceDue(
  dueISO: string | undefined, dueText: string | undefined, title: string,
  referenceDate: string, timeZone: string, offsetMinutes: number,
): string | undefined {
  const text = dueText?.trim() ?? '';
  const anchors = voiceLocalDates(referenceDate, timeZone, offsetMinutes);
  const relativeDay = /\bday after tomorrow\b/i.test(text) ? anchors.dayAfterTomorrow
    : /\btomorrow\b/i.test(text) ? anchors.tomorrow : /\btoday\b/i.test(text) ? anchors.today : undefined;
  if (relativeDay && /^(?:(?:due|on)\s+)?(?:today|tomorrow|(?:the )?day after tomorrow)[.!]?$/i.test(text)) return relativeDay;

  const parsed = dueISO ? new Date(dueISO) : undefined;
  const valid = parsed && !Number.isNaN(parsed.getTime());
  const dateOnly = dueISO && /^\d{4}-\d{2}-\d{2}$/.test(dueISO);
  const local = valid ? parts(parsed, timeZone, offsetMinutes) : undefined;
  const day = relativeDay ?? (dateOnly ? dueISO : local ? dayKey(local) : undefined);
  if (!day) return dueISO;

  const range = text.match(/\b(?:from|between)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:[-–—]|to|and)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/i);
  if (range) {
    let hour = Number(range[1]);
    const minute = Number(range[2] ?? 0);
    const endHour = Number(range[4]);
    const meridiem = (range[3] ?? range[6] ?? '').toLowerCase().replaceAll('.', '');
    if (hour <= 23 && endHour <= 23 && minute <= 59) {
      if (meridiem && hour <= 12) {
        hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
        // An omitted start meridiem in "11 to 1 PM" means 11 AM.
        if (!range[3] && Number(range[1]) < 12 && Number(range[1]) > endHour) hour = (hour + 12) % 24;
      } else if (!meridiem && hour >= 1 && hour <= 7 && endHour > hour && endHour <= 8
        && /\b(meet|meeting|appointment|technician|repair|delivery|installer|spectrum)\b/i.test(`${title} ${text}`)
        && !/\b(morning|night|overnight|midnight)\b/i.test(`${title} ${text}`)) {
        hour += 12;
      }
      return wallClockISO(day, hour, minute, timeZone, offsetMinutes);
    }
  }
  if (relativeDay && dateOnly) return relativeDay;
  if (relativeDay && local) return wallClockISO(relativeDay, local.hour, local.minute, timeZone, offsetMinutes);
  return dueISO;
}
