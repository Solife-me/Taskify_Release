/**
 * The hour : minute AM/PM wheels used for due times, event start and end times, and reminder
 * times. Scrolling a wheel snaps to the nearest option and commits once it settles; tapping an
 * option commits at once. Values are "HH:MM" (24-hour) strings.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject, type WheelEvent } from "react";
import { HOURS_12, MERIDIEMS, MINUTES, type Meridiem } from "../../../domains/appTypes";
import {
  formatTimePickerValue,
  getWheelNearestIndex,
  handleWheelPickerScroll,
  parseTimePickerValue,
  scheduleWheelSnap,
  scrollWheelColumnToIndex,
} from "../../../domains/dateTime/dateUtils";

type Parts = { hour: number; minute: number; meridiem: Meridiem };

function WheelColumn<T extends string | number>({
  columnRef,
  options,
  value,
  ariaLabel,
  className = "",
  formatOption,
  onScrollTo,
  onSettle,
  onPick,
}: {
  columnRef: RefObject<HTMLDivElement | null>;
  options: readonly T[];
  value: T;
  ariaLabel: string;
  className?: string;
  formatOption: (option: T) => string;
  /** The wheel is passing over `option` (no re-render while it scrolls). */
  onScrollTo: (option: T) => void;
  /** The wheel came to rest. */
  onSettle: () => void;
  onPick: (option: T) => void;
}) {
  const frame = useRef<number | null>(null);
  const snapTimeout = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      if (snapTimeout.current != null) window.clearTimeout(snapTimeout.current);
    },
    [],
  );
  const handleScroll = () => {
    const column = columnRef.current;
    if (!column) return;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const index = getWheelNearestIndex(column, options.length);
      if (index == null) return;
      const option = options[index];
      if (option === undefined) return;
      onScrollTo(option);
      scheduleWheelSnap(columnRef, snapTimeout, index, onSettle);
    });
  };
  return (
    <div
      className={`edit-time-picker__column${className ? ` ${className}` : ""}`}
      ref={columnRef}
      onScroll={handleScroll}
      role="listbox"
      aria-label={ariaLabel}
    >
      {options.map((option, index) => (
        <div
          key={option}
          className={`edit-time-picker__option ${value === option ? "is-active" : ""}`}
          data-picker-index={index}
          role="option"
          aria-selected={value === option}
          onClick={() => onPick(option)}
        >
          {formatOption(option)}
        </div>
      ))}
    </div>
  );
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

export function WheelTimePicker({
  value,
  fallback = "09:00",
  onChange,
  ariaLabel = "Select time",
}: {
  /** "HH:MM", or empty to show `fallback`. */
  value: string | null | undefined;
  fallback?: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  const { hour, minute, meridiem } = parseTimePickerValue(value, fallback);
  const hourRef = useRef<HTMLDivElement | null>(null);
  const minuteRef = useRef<HTMLDivElement | null>(null);
  const meridiemRef = useRef<HTMLDivElement | null>(null);
  // The wheels' live position, updated while they scroll so a settle commits all three.
  const live = useRef<Parts>({ hour, minute, meridiem });
  const latest = useRef({ value, onChange });
  useEffect(() => {
    live.current = { hour, minute, meridiem };
  }, [hour, minute, meridiem]);
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  });

  const commit = useCallback((next: Partial<Parts> = {}) => {
    live.current = { ...live.current, ...next };
    const nextValue = formatTimePickerValue(live.current.hour, live.current.minute, live.current.meridiem);
    if (nextValue !== latest.current.value) latest.current.onChange(nextValue);
  }, []);

  // Keep each wheel on its value ("instant", so no scroll events fire mid-animation and re-snap).
  useLayoutEffect(() => {
    scrollWheelColumnToIndex(hourRef.current, HOURS_12.indexOf(hour), "instant");
    scrollWheelColumnToIndex(minuteRef.current, MINUTES.indexOf(minute), "instant");
    scrollWheelColumnToIndex(meridiemRef.current, MERIDIEMS.indexOf(meridiem), "instant");
  }, [hour, minute, meridiem]);

  const handleWheel = (event: WheelEvent<HTMLElement>) =>
    handleWheelPickerScroll(event, [
      { ref: hourRef, optionCount: HOURS_12.length },
      { ref: minuteRef, optionCount: MINUTES.length },
      { ref: meridiemRef, optionCount: MERIDIEMS.length },
    ]);

  return (
    <div className="edit-time-picker" role="group" aria-label={ariaLabel} onWheel={handleWheel}>
      <WheelColumn
        columnRef={hourRef}
        options={HOURS_12}
        value={hour}
        ariaLabel="Select hour"
        formatOption={twoDigits}
        onScrollTo={(option) => {
          live.current.hour = option;
        }}
        onSettle={() => commit()}
        onPick={(option) => commit({ hour: option })}
      />
      <div className="edit-time-picker__separator" aria-hidden="true">
        :
      </div>
      <WheelColumn
        columnRef={minuteRef}
        options={MINUTES}
        value={minute}
        ariaLabel="Select minute"
        formatOption={twoDigits}
        onScrollTo={(option) => {
          live.current.minute = option;
        }}
        onSettle={() => commit()}
        onPick={(option) => commit({ minute: option })}
      />
      <WheelColumn
        columnRef={meridiemRef}
        options={MERIDIEMS}
        value={meridiem}
        ariaLabel="Select AM or PM"
        className="edit-time-picker__column--meridiem"
        formatOption={(option) => option}
        onScrollTo={(option) => {
          live.current.meridiem = option;
        }}
        onSettle={() => commit()}
        onPick={(option) => commit({ meridiem: option })}
      />
    </div>
  );
}
