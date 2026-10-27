/**
 * The reminder picker in the task and event editors: a chip per preset, "Custom…" for any offset,
 * and, for all-day items, the time of day the reminders fire.
 */
import { useMemo, useState } from "react";
import type { ReminderPreset } from "../../../domains/tasks/taskTypes";
import { buildReminderOptions, type ReminderPresetMode } from "../../../domains/dateTime/reminderUtils";
import { addCustomReminderSelection, toggleReminderSelection } from "../../../domains/dateTime/reminderSelection";
import { CustomReminderSheet } from "../../reminders/CustomReminderSheet";
import { WheelTimePicker } from "./WheelTimePicker";

export type ReminderTimeOfDay = {
  /** The chosen time, already formatted for the button. */
  label: string;
  open: boolean;
  onToggle: () => void;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
};

export function ReminderChips({
  selection,
  mode,
  onChange,
  disabled = false,
  anchorISO,
  anchorTimeZone,
  anchorLabel,
  timeOfDay,
}: {
  selection: ReminderPreset[];
  mode: ReminderPresetMode;
  onChange: (selection: ReminderPreset[]) => void;
  disabled?: boolean;
  /** What custom reminders count back from (due time, event start, or the reminder time). */
  anchorISO: string | null;
  anchorTimeZone: string;
  anchorLabel: string;
  /** Shown for all-day items. */
  timeOfDay?: ReminderTimeOfDay;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const options = useMemo(() => buildReminderOptions(selection, mode), [mode, selection]);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={selection.includes(option.id) ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
            onClick={() => onChange(toggleReminderSelection(selection, option.id, mode))}
            disabled={disabled}
            title={option.label}
          >
            {option.badge}
          </button>
        ))}
        <button
          type="button"
          className="ghost-button button-sm pressable"
          onClick={() => setCustomOpen(true)}
          disabled={disabled}
          title="Add a custom reminder"
        >
          Custom…
        </button>
      </div>
      {timeOfDay && (
        <div className="space-y-2">
          <div className="text-xs text-secondary">Reminder time (current timezone)</div>
          <button
            type="button"
            className={`pressable rounded-full border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium ${
              timeOfDay.open ? "text-primary" : "text-secondary"
            }`}
            onClick={timeOfDay.onToggle}
            aria-pressed={timeOfDay.open}
            disabled={disabled}
          >
            {timeOfDay.label}
          </button>
          {timeOfDay.open && (
            <WheelTimePicker
              value={timeOfDay.value}
              fallback={timeOfDay.fallback}
              onChange={timeOfDay.onChange}
              ariaLabel="Select reminder time"
            />
          )}
        </div>
      )}
      <CustomReminderSheet
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        anchorISO={anchorISO}
        anchorTimeZone={anchorTimeZone}
        anchorLabel={anchorLabel}
        onApply={(minutesBefore) => onChange(addCustomReminderSelection(selection, minutesBefore, mode))}
      />
    </>
  );
}
