/**
 * Choosing reminders for a task or event: one reminder per offset, ordered the way the picker
 * lists them (soonest first for timed items, earliest day first for all-day ones).
 */
import type { ReminderPreset } from "../tasks/taskTypes";
import {
  buildReminderOptions,
  formatReminderLabel,
  reminderPresetIdForMode,
  reminderPresetToMinutes,
  type ReminderPresetMode,
} from "./reminderUtils";

export function sortReminderSelection(selection: readonly ReminderPreset[], mode: ReminderPresetMode): ReminderPreset[] {
  return [...selection].sort((a, b) =>
    mode === "date"
      ? reminderPresetToMinutes(b) - reminderPresetToMinutes(a)
      : reminderPresetToMinutes(a) - reminderPresetToMinutes(b),
  );
}

/** Turns a reminder on or off; turning one on replaces any other at the same offset. */
export function toggleReminderSelection(
  selection: readonly ReminderPreset[],
  id: ReminderPreset,
  mode: ReminderPresetMode,
): ReminderPreset[] {
  const minutes = reminderPresetToMinutes(id);
  const next = selection.includes(id)
    ? selection.filter((item) => item !== id)
    : [...selection.filter((item) => reminderPresetToMinutes(item) !== minutes), id];
  return sortReminderSelection(next, mode);
}

/** Adds a reminder `minutesBefore` the anchor, replacing any other at that offset. */
export function addCustomReminderSelection(
  selection: readonly ReminderPreset[],
  minutesBefore: number,
  mode: ReminderPresetMode,
): ReminderPreset[] {
  const id = reminderPresetIdForMode(minutesBefore, mode);
  const minutes = reminderPresetToMinutes(id);
  const kept = selection.filter((item) => reminderPresetToMinutes(item) !== minutes || item === id);
  return sortReminderSelection(kept.includes(id) ? kept : [...kept, id], mode);
}

/** The chosen reminders as short badges ("15m, 1h"), or "" for none. */
export function reminderSelectionSummary(selection: readonly ReminderPreset[], mode: ReminderPresetMode): string {
  if (!selection.length) return "";
  const options = new Map(buildReminderOptions([...selection], mode).map((option) => [option.id, option]));
  return selection
    .map((id) => {
      const option = options.get(id);
      if (option) return option.badge;
      const minutes = reminderPresetToMinutes(id);
      return Number.isFinite(minutes) ? formatReminderLabel(minutes).badge : String(id);
    })
    .join(", ");
}
