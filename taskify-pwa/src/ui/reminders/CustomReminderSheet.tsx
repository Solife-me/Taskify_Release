import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type WheelEvent } from "react";
import type { Meridiem } from "../../domains/appTypes";
import { HOURS_12, MINUTES, MERIDIEMS } from "../../domains/appTypes";
import { MIN_CUSTOM_REMINDER_MINUTES, MAX_CUSTOM_REMINDER_MINUTES, formatReminderLabel, DEFAULT_DATE_REMINDER_TIME } from "../../domains/dateTime/reminderUtils";
import { isoDatePart, isoTimePart, isoFromDateTime, normalizeTimeZone, resolveSystemTimeZone, parseTimePickerValue, formatTimePickerValue, scrollWheelColumnToIndex, getWheelNearestIndex, scheduleWheelSnap, handleWheelPickerScroll } from "../../domains/dateTime/dateUtils";
import { ActionSheet } from "../../components/ActionSheet";
import { DatePickerCalendar } from "../../domains/dateTime/calendarPickerHook";

function CustomReminderSheet({
  open,
  onClose,
  anchorISO,
  anchorTimeZone,
  anchorLabel,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  anchorISO: string | null;
  anchorTimeZone?: string;
  anchorLabel: string;
  onApply: (minutesBefore: number) => void;
}) {
  const safeTimeZone = useMemo(
    () => normalizeTimeZone(anchorTimeZone) ?? resolveSystemTimeZone(),
    [anchorTimeZone],
  );
  const fallbackISO = useMemo(() => {
    if (anchorISO && !Number.isNaN(Date.parse(anchorISO))) return anchorISO;
    return new Date().toISOString();
  }, [anchorISO]);
  const initialTimeParts = useMemo(
    () => parseTimePickerValue(isoTimePart(fallbackISO, safeTimeZone), DEFAULT_DATE_REMINDER_TIME),
    [fallbackISO, safeTimeZone],
  );
  const [calendarBaseDate, setCalendarBaseDate] = useState(() => isoDatePart(fallbackISO, safeTimeZone));
  const [selectedDate, setSelectedDate] = useState(() => isoDatePart(fallbackISO, safeTimeZone));
  const [timePickerHour, setTimePickerHour] = useState(initialTimeParts.hour);
  const [timePickerMinute, setTimePickerMinute] = useState(initialTimeParts.minute);
  const [timePickerMeridiem, setTimePickerMeridiem] = useState<Meridiem>(initialTimeParts.meridiem);
  const timePickerHourColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerMinuteColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerMeridiemColumnRef = useRef<HTMLDivElement | null>(null);
  const timePickerHourScrollFrame = useRef<number | null>(null);
  const timePickerMinuteScrollFrame = useRef<number | null>(null);
  const timePickerMeridiemScrollFrame = useRef<number | null>(null);
  const timePickerHourSnapTimeout = useRef<number | null>(null);
  const timePickerMinuteSnapTimeout = useRef<number | null>(null);
  const timePickerMeridiemSnapTimeout = useRef<number | null>(null);
  const timePickerHourValueRef = useRef(initialTimeParts.hour);
  const timePickerMinuteValueRef = useRef(initialTimeParts.minute);
  const timePickerMeridiemValueRef = useRef<Meridiem>(initialTimeParts.meridiem);
  const selectedTime = useMemo(
    () => formatTimePickerValue(timePickerHour, timePickerMinute, timePickerMeridiem),
    [timePickerHour, timePickerMeridiem, timePickerMinute],
  );
  const selectedISO = useMemo(
    () => isoFromDateTime(selectedDate, selectedTime, safeTimeZone),
    [safeTimeZone, selectedDate, selectedTime],
  );
  const minutesBefore = useMemo(() => {
    if (!anchorISO) return null;
    const anchorMs = Date.parse(anchorISO);
    const selectedMs = Date.parse(selectedISO);
    if (Number.isNaN(anchorMs) || Number.isNaN(selectedMs)) return null;
    return Math.round((anchorMs - selectedMs) / 60000);
  }, [anchorISO, selectedISO]);
  const anchorDateTimeLabel = useMemo(() => {
    if (!anchorISO) return "";
    const parsed = new Date(anchorISO);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: safeTimeZone,
    });
  }, [anchorISO, safeTimeZone]);
  const selectedDateTimeLabel = useMemo(() => {
    const parsed = new Date(selectedISO);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: safeTimeZone,
    });
  }, [safeTimeZone, selectedISO]);
  const reminderSummary = useMemo(() => {
    if (minutesBefore == null || !Number.isFinite(minutesBefore)) {
      return "Pick a valid reminder date and time.";
    }
    if (minutesBefore === 0) {
      return `At ${anchorLabel}`;
    }
    return formatReminderLabel(minutesBefore).label;
  }, [anchorLabel, minutesBefore]);
  const canApply = !!(
    minutesBefore != null &&
    Number.isFinite(minutesBefore) &&
    minutesBefore >= MIN_CUSTOM_REMINDER_MINUTES &&
    minutesBefore <= MAX_CUSTOM_REMINDER_MINUTES
  );

  useEffect(() => {
    if (!open) return;
    const sourceISO = anchorISO && !Number.isNaN(Date.parse(anchorISO))
      ? anchorISO
      : new Date().toISOString();
    const nextDate = isoDatePart(sourceISO, safeTimeZone);
    const nextTime = isoTimePart(sourceISO, safeTimeZone);
    const parsed = parseTimePickerValue(nextTime, DEFAULT_DATE_REMINDER_TIME);
    setCalendarBaseDate(nextDate);
    setSelectedDate(nextDate);
    setTimePickerHour(parsed.hour);
    setTimePickerMinute(parsed.minute);
    setTimePickerMeridiem(parsed.meridiem);
  }, [anchorISO, open, safeTimeZone]);

  useEffect(() => {
    if (selectedDate) {
      setCalendarBaseDate(selectedDate);
    }
  }, [selectedDate]);

  useEffect(() => {
    timePickerHourValueRef.current = timePickerHour;
  }, [timePickerHour]);
  useEffect(() => {
    timePickerMinuteValueRef.current = timePickerMinute;
  }, [timePickerMinute]);
  useEffect(() => {
    timePickerMeridiemValueRef.current = timePickerMeridiem;
  }, [timePickerMeridiem]);

  useEffect(
    () => () => {
      if (timePickerHourScrollFrame.current != null) {
        cancelAnimationFrame(timePickerHourScrollFrame.current);
      }
      if (timePickerMinuteScrollFrame.current != null) {
        cancelAnimationFrame(timePickerMinuteScrollFrame.current);
      }
      if (timePickerMeridiemScrollFrame.current != null) {
        cancelAnimationFrame(timePickerMeridiemScrollFrame.current);
      }
      const snapRefs = [timePickerHourSnapTimeout, timePickerMinuteSnapTimeout, timePickerMeridiemSnapTimeout];
      for (const ref of snapRefs) {
        if (ref.current != null) {
          window.clearTimeout(ref.current);
          ref.current = null;
        }
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const hourIndex = HOURS_12.indexOf(timePickerHour);
    if (hourIndex >= 0) {
      scrollWheelColumnToIndex(timePickerHourColumnRef.current, hourIndex, "instant");
    }
    const minuteIndex = MINUTES.indexOf(timePickerMinute);
    if (minuteIndex >= 0) {
      scrollWheelColumnToIndex(timePickerMinuteColumnRef.current, minuteIndex, "instant");
    }
    const meridiemIndex = MERIDIEMS.indexOf(timePickerMeridiem);
    if (meridiemIndex >= 0) {
      scrollWheelColumnToIndex(timePickerMeridiemColumnRef.current, meridiemIndex, "instant");
    }
  }, [open, timePickerHour, timePickerMeridiem, timePickerMinute]);

  const setTimePickerFromParts = useCallback((hour: number, minute: number, meridiem: Meridiem) => {
    setTimePickerHour(hour);
    setTimePickerMinute(minute);
    setTimePickerMeridiem(meridiem);
  }, []);

  const handleTimePickerHourScroll = useCallback(() => {
    const column = timePickerHourColumnRef.current;
    if (!column) return;
    if (timePickerHourScrollFrame.current != null) {
      cancelAnimationFrame(timePickerHourScrollFrame.current);
    }
    timePickerHourScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, HOURS_12.length);
      if (clampedIndex == null) return;
      const nextHour = HOURS_12[clampedIndex];
      if (typeof nextHour === "number") {
        timePickerHourValueRef.current = nextHour;
        scheduleWheelSnap(timePickerHourColumnRef, timePickerHourSnapTimeout, clampedIndex, () => {
          setTimePickerFromParts(timePickerHourValueRef.current, timePickerMinuteValueRef.current, timePickerMeridiemValueRef.current);
        });
      }
    });
  }, [setTimePickerFromParts]);
  const handleTimePickerMinuteScroll = useCallback(() => {
    const column = timePickerMinuteColumnRef.current;
    if (!column) return;
    if (timePickerMinuteScrollFrame.current != null) {
      cancelAnimationFrame(timePickerMinuteScrollFrame.current);
    }
    timePickerMinuteScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, MINUTES.length);
      if (clampedIndex == null) return;
      const nextMinute = MINUTES[clampedIndex];
      if (typeof nextMinute === "number") {
        timePickerMinuteValueRef.current = nextMinute;
        scheduleWheelSnap(timePickerMinuteColumnRef, timePickerMinuteSnapTimeout, clampedIndex, () => {
          setTimePickerFromParts(timePickerHourValueRef.current, timePickerMinuteValueRef.current, timePickerMeridiemValueRef.current);
        });
      }
    });
  }, [setTimePickerFromParts]);
  const handleTimePickerMeridiemScroll = useCallback(() => {
    const column = timePickerMeridiemColumnRef.current;
    if (!column) return;
    if (timePickerMeridiemScrollFrame.current != null) {
      cancelAnimationFrame(timePickerMeridiemScrollFrame.current);
    }
    timePickerMeridiemScrollFrame.current = requestAnimationFrame(() => {
      const clampedIndex = getWheelNearestIndex(column, MERIDIEMS.length);
      if (clampedIndex == null) return;
      const nextMeridiem = MERIDIEMS[clampedIndex];
      if (nextMeridiem) {
        timePickerMeridiemValueRef.current = nextMeridiem;
        scheduleWheelSnap(timePickerMeridiemColumnRef, timePickerMeridiemSnapTimeout, clampedIndex, () => {
          setTimePickerFromParts(timePickerHourValueRef.current, timePickerMinuteValueRef.current, timePickerMeridiemValueRef.current);
        });
      }
    });
  }, [setTimePickerFromParts]);
  const handleTimePickerWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    handleWheelPickerScroll(event, [
      { ref: timePickerHourColumnRef, optionCount: HOURS_12.length },
      { ref: timePickerMinuteColumnRef, optionCount: MINUTES.length },
      { ref: timePickerMeridiemColumnRef, optionCount: MERIDIEMS.length },
    ]);
  }, []);

  const handleApply = useCallback(() => {
    if (!anchorISO || Number.isNaN(Date.parse(anchorISO))) {
      alert(`Set a valid ${anchorLabel} before adding a custom reminder.`);
      return;
    }
    if (minutesBefore == null || !Number.isFinite(minutesBefore)) {
      alert("Pick a valid reminder date and time.");
      return;
    }
    if (minutesBefore < MIN_CUSTOM_REMINDER_MINUTES) {
      alert(`Pick a value no less than ${MIN_CUSTOM_REMINDER_MINUTES.toLocaleString()} minutes relative to the ${anchorLabel}.`);
      return;
    }
    if (minutesBefore > MAX_CUSTOM_REMINDER_MINUTES) {
      alert(`Pick a value no greater than ${MAX_CUSTOM_REMINDER_MINUTES.toLocaleString()} minutes relative to the ${anchorLabel}.`);
      return;
    }
    onApply(minutesBefore);
    onClose();
  }, [anchorISO, anchorLabel, minutesBefore, onApply, onClose]);

  return (
    <ActionSheet open={open} onClose={onClose} title="Custom reminder" panelClassName="sheet-panel--tall" stackLevel={95}>
      <div className="space-y-3">
        <div className="rounded-2xl border border-border bg-elevated p-3 text-xs text-secondary">
          Choose an exact date and time relative to the {anchorLabel} (before or after).
        </div>
        <div className="rounded-2xl border border-border bg-elevated p-4">
          <DatePickerCalendar
            baseDate={calendarBaseDate}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
        </div>
        <div className="space-y-2 rounded-2xl border border-border bg-elevated p-4">
          <div className="text-xs text-secondary">Time ({safeTimeZone})</div>
          <div className="edit-time-picker" role="group" aria-label="Select custom reminder time" onWheel={handleTimePickerWheel}>
            <div
              className="edit-time-picker__column"
              ref={timePickerHourColumnRef}
              onScroll={handleTimePickerHourScroll}
              role="listbox"
              aria-label="Select hour"
            >
              {HOURS_12.map((hour, idx) => (
                <div
                  key={`custom-reminder-hour-${hour}`}
                  className={`edit-time-picker__option ${timePickerHour === hour ? "is-active" : ""}`}
                  data-picker-index={idx}
                  role="option"
                  aria-selected={timePickerHour === hour}
                  onClick={() => setTimePickerFromParts(hour, timePickerMinute, timePickerMeridiem)}
                >
                  {String(hour).padStart(2, "0")}
                </div>
              ))}
            </div>
            <div className="edit-time-picker__separator" aria-hidden="true">
              :
            </div>
            <div
              className="edit-time-picker__column"
              ref={timePickerMinuteColumnRef}
              onScroll={handleTimePickerMinuteScroll}
              role="listbox"
              aria-label="Select minute"
            >
              {MINUTES.map((minute, idx) => (
                <div
                  key={`custom-reminder-minute-${minute}`}
                  className={`edit-time-picker__option ${timePickerMinute === minute ? "is-active" : ""}`}
                  data-picker-index={idx}
                  role="option"
                  aria-selected={timePickerMinute === minute}
                  onClick={() => setTimePickerFromParts(timePickerHour, minute, timePickerMeridiem)}
                >
                  {String(minute).padStart(2, "0")}
                </div>
              ))}
            </div>
            <div
              className="edit-time-picker__column edit-time-picker__column--meridiem"
              ref={timePickerMeridiemColumnRef}
              onScroll={handleTimePickerMeridiemScroll}
              role="listbox"
              aria-label="Select AM or PM"
            >
              {MERIDIEMS.map((label, idx) => (
                <div
                  key={`custom-reminder-meridiem-${label}`}
                  className={`edit-time-picker__option ${timePickerMeridiem === label ? "is-active" : ""}`}
                  data-picker-index={idx}
                  role="option"
                  aria-selected={timePickerMeridiem === label}
                  onClick={() => setTimePickerFromParts(timePickerHour, timePickerMinute, label)}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-1 rounded-2xl border border-border bg-elevated p-3 text-xs">
          <div className="text-secondary">
            Anchor ({anchorLabel}): {anchorDateTimeLabel || "Not set"}
          </div>
          <div className="text-secondary">Reminder: {selectedDateTimeLabel || "Not set"}</div>
          <div className="text-primary">
            {reminderSummary}
          </div>
        </div>
        <button
          type="button"
          className="accent-button accent-button--tall pressable w-full"
          onClick={handleApply}
          disabled={!canApply}
        >
          Add reminder
        </button>
      </div>
    </ActionSheet>
  );
}

export { CustomReminderSheet };
