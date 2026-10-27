/**
 * The editors' "Repeat" and "End Repeat" rows, with the preset sheet, the custom sheet, the end
 * date sheet and the advanced dialog behind them.
 */
import { useState } from "react";
import type { Recurrence } from "../../../domains/tasks/taskTypes";
import { endRepeatLabel, recurrenceLabel } from "../../../domains/tasks/recurrenceLabel";
import { EndRepeatSheet, RecurrenceModal, RepeatCustomSheet, RepeatPickerSheet } from "../../recurrence/RecurrencePicker";

type Sheet = null | "presets" | "custom" | "end" | "advanced";

function RowIcon({ kind }: { kind: "repeat" | "end" }) {
  return (
    <span className="edit-row__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        {kind === "repeat" ? (
          <path d="M4 12h16M7 7l-3 5 3 5M17 17l3-5-3-5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <path d="M6 6h12v12H6z" opacity="0.35" />
            <path d="M6 12h12" />
          </>
        )}
      </svg>
    </span>
  );
}

export function RepeatField({
  rule,
  onChange,
  anchorDate,
  timeZone,
  disabled = false,
  showIcons = false,
  rowClassName = "edit-row edit-row--interactive",
}: {
  rule: Recurrence;
  onChange: (rule: Recurrence) => void;
  /** The date the series starts from (YYYY-MM-DD), used for weekday and day-of-month presets. */
  anchorDate: string;
  /** The zone an end date is read in. */
  timeZone: string;
  disabled?: boolean;
  showIcons?: boolean;
  rowClassName?: string;
}) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);
  // Choosing a new pattern keeps the end date already set.
  const select = (next: Recurrence) => {
    onChange(rule.untilISO ? { ...next, untilISO: rule.untilISO } : next);
    close();
  };
  const setEnd = (untilISO: string | null | undefined) => {
    const next: Recurrence = { ...rule };
    if (untilISO) next.untilISO = untilISO;
    else delete next.untilISO;
    onChange(next);
  };

  return (
    <>
      <button type="button" className={rowClassName} onClick={() => setSheet("presets")} disabled={disabled}>
        {showIcons && <RowIcon kind="repeat" />}
        <div className="edit-row__content">
          <div className="edit-row__label">Repeat</div>
        </div>
        <div className="edit-row__value">{recurrenceLabel(rule)}</div>
        <span className="edit-row__chevron" aria-hidden="true">›</span>
      </button>
      {rule.type !== "none" && (
        <button type="button" className={rowClassName} onClick={() => setSheet("end")} disabled={disabled}>
          {showIcons && <RowIcon kind="end" />}
          <div className="edit-row__content">
            <div className="edit-row__label">End Repeat</div>
          </div>
          <div className="edit-row__value">{endRepeatLabel(rule, timeZone)}</div>
          <span className="edit-row__chevron" aria-hidden="true">›</span>
        </button>
      )}

      <RepeatPickerSheet
        open={sheet === "presets"}
        onClose={close}
        rule={rule}
        scheduledDate={anchorDate}
        onSelect={select}
        onOpenCustom={() => setSheet("custom")}
        onOpenAdvanced={() => setSheet("advanced")}
      />
      <RepeatCustomSheet
        open={sheet === "custom"}
        onClose={close}
        scheduledDate={anchorDate}
        rule={rule}
        onApply={select}
        onOpenAdvanced={() => setSheet("advanced")}
      />
      <EndRepeatSheet
        open={sheet === "end"}
        onClose={close}
        rule={rule}
        scheduledDate={anchorDate}
        timeZone={timeZone}
        onSelect={setEnd}
      />
      {sheet === "advanced" && (
        <RecurrenceModal
          initial={rule}
          onClose={close}
          onApply={(next) => {
            onChange(next);
            close();
          }}
        />
      )}
    </>
  );
}
