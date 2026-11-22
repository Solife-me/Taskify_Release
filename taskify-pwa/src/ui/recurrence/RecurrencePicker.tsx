import { useState, useCallback, useEffect, useMemo } from "react";
import type { Recurrence, Weekday } from "../../domains/tasks/taskTypes";
import { WD_SHORT } from "../../domains/appTypes";
import { isoDatePart, isoFromDateTime } from "../../domains/dateTime/dateUtils";
import { Modal } from "../Modal";
import { ActionSheet } from "../../components/ActionSheet";
import { DatePickerCalendar } from "../../domains/dateTime/calendarPickerHook";

/* Advanced recurrence modal & picker */
export function RecurrenceModal({
  initial,
  allowHourly = false,
  onClose,
  onApply,
  initialSchedule,
}: {
  initial: Recurrence;
  allowHourly?: boolean;
  onClose: () => void;
  onApply: (r: Recurrence, scheduleISO?: string) => void;
  initialSchedule?: string;
}) {
  const [value, setValue] = useState<Recurrence>(initial);
  const [schedule, setSchedule] = useState(initialSchedule ?? "");

  return (
    <Modal
      onClose={onClose}
      title="Advanced recurrence"
      showClose={false}
      actions={
        <>
          <button
            className="ghost-button button-sm pressable"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="accent-button button-sm pressable"
            onClick={() =>
              onApply(
                value,
                initialSchedule !== undefined ? schedule : undefined
              )
            }
          >
            Apply
          </button>
        </>
      }
    >
      {initialSchedule !== undefined && (
        <div className="mb-4">
          <label htmlFor="advanced-schedule" className="block mb-1 text-sm font-medium">Scheduled for</label>
          <input
            id="advanced-schedule"
            type="date"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="pill-input w-full"
            title="Scheduled date"
          />
        </div>
      )}
      <RecurrencePicker value={value} onChange={setValue} allowHourly={allowHourly} />
    </Modal>
  );
}

type RepeatSheetOption = {
  id: string;
  label: string;
  description?: string;
  rule?: Recurrence;
  action?: "custom";
};

export function RepeatPickerSheet({
  open,
  onClose,
  rule,
  allowHourly = false,
  scheduledDate,
  onSelect,
  onOpenCustom,
  onOpenAdvanced,
}: {
  open: boolean;
  onClose: () => void;
  rule: Recurrence;
  allowHourly?: boolean;
  scheduledDate?: string;
  onSelect: (r: Recurrence) => void;
  onOpenCustom: () => void;
  onOpenAdvanced: () => void;
}) {
  const weekday = useMemo(() => repeatWeekdayFromInput(scheduledDate), [scheduledDate]);
  const monthDay = useMemo(() => repeatMonthDayFromInput(scheduledDate), [scheduledDate]);

  const options = useMemo<RepeatSheetOption[]>(() => {
    const clampDay = monthDay;
    const hourly: RepeatSheetOption[] = allowHourly
      ? [{ id: "hourly", label: "Hourly", rule: { type: "every", n: 1, unit: "hour" } }]
      : [];
    return [
      { id: "never", label: "Never", rule: { type: "none" } },
      ...hourly,
      { id: "daily", label: "Daily", rule: { type: "daily" } },
      { id: "weekdays", label: "Weekdays", rule: { type: "weekly", days: [1, 2, 3, 4, 5] } },
      { id: "weekends", label: "Weekends", rule: { type: "weekly", days: [0, 6] } },
      {
        id: "weekly",
        label: "Weekly",
        rule: { type: "weekly", days: [weekday] },
      },
      { id: "biweekly", label: "Biweekly", rule: { type: "every", n: 2, unit: "week" } },
      {
        id: "monthly",
        label: "Monthly",
        rule: { type: "monthlyDay", day: clampDay },
      },
      {
        id: "quarterly",
        label: "Every 3 Months",
        rule: { type: "monthlyDay", day: clampDay, interval: 3 },
      },
      {
        id: "semiannual",
        label: "Every 6 Months",
        rule: { type: "monthlyDay", day: clampDay, interval: 6 },
      },
      {
        id: "yearly",
        label: "Yearly",
        rule: { type: "monthlyDay", day: clampDay, interval: 12 },
      },
      { id: "custom", label: "Custom", action: "custom" },
    ];
  }, [allowHourly, monthDay, weekday]);

  return (
    <ActionSheet open={open} onClose={onClose} title="Repeat">
      <div className="space-y-4">
        <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
          {options.map((opt) => {
            const isCustom = opt.action === "custom";
            const active = opt.rule ? recurrenceMatchesPreset(rule, opt.rule) : false;
            return (
              <button
                key={opt.id}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface"
                onClick={() => {
                  if (isCustom) {
                    onOpenCustom();
                  } else if (opt.rule) {
                    onSelect(opt.rule);
                  }
                }}
              >
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{opt.label}</div>
                  {opt.description && <div className="text-xs text-secondary">{opt.description}</div>}
                </div>
                {active && <span className="text-accent text-sm font-semibold">✓</span>}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="ghost-button button-sm pressable w-full"
          onClick={onOpenAdvanced}
        >
          Advanced recurrence…
        </button>
      </div>
    </ActionSheet>
  );
}

type RepeatFrequency = "days" | "months" | "years";

export function RepeatCustomSheet({
  open,
  onClose,
  scheduledDate,
  rule,
  onApply,
  onOpenAdvanced,
}: {
  open: boolean;
  onClose: () => void;
  scheduledDate?: string;
  rule: Recurrence;
  onApply: (r: Recurrence) => void;
  onOpenAdvanced: () => void;
}) {
  const [frequency, setFrequency] = useState<RepeatFrequency>("days");
  const [amount, setAmount] = useState("1");
  const monthDay = useMemo(() => {
    if (rule.type === "monthlyDay") return rule.day;
    return repeatMonthDayFromInput(scheduledDate);
  }, [rule, scheduledDate]);

  useEffect(() => {
    if (!open) {
      setFrequency("days");
      setAmount("1");
      return;
    }

    if (rule.type === "every" && rule.unit === "day") {
      setFrequency("days");
      setAmount(String(rule.n));
    } else if (rule.type === "monthlyDay") {
      const interval = rule.interval ?? 1;
      if (interval % 12 === 0) {
        setFrequency("years");
        setAmount(String(Math.max(1, Math.floor(interval / 12))));
      } else {
        setFrequency("months");
        setAmount(String(interval));
      }
    } else {
      setFrequency("days");
      setAmount("1");
    }
  }, [open, rule]);

  const numericAmount = useMemo(() => {
    const parsed = Number.parseInt(amount || "1", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.min(parsed, 60);
  }, [amount]);

  const summary = useMemo(() => {
    const unitLabel = frequency.slice(0, -1); // crude singularization
    const plural = numericAmount === 1 ? unitLabel : frequency;
    return `Event will occur every ${numericAmount} ${plural}.`;
  }, [frequency, numericAmount]);

  function handleApply() {
    if (frequency === "days") {
      onApply({ type: "every", n: numericAmount, unit: "day" });
    } else {
      const interval = frequency === "months" ? numericAmount : numericAmount * 12;
      onApply({ type: "monthlyDay", day: monthDay, interval });
    }
  }

  return (
    <ActionSheet open={open} onClose={onClose} title="Custom">
      <div className="space-y-4">
        <div className="space-y-2 rounded-2xl border border-border bg-elevated p-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-secondary" htmlFor="repeat-frequency">
            Frequency
          </label>
          <select
            id="repeat-frequency"
            className="pill-select w-full"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RepeatFrequency)}
          >
            <option value="days">Days</option>
            <option value="months">Months</option>
            <option value="years">Years</option>
          </select>
        </div>
        <div className="space-y-2 rounded-2xl border border-border bg-elevated p-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-secondary" htmlFor="repeat-amount">
            Every
          </label>
          <input
            id="repeat-amount"
            type="number"
            min={1}
            max={60}
            inputMode="numeric"
            className="pill-input w-full text-center text-lg"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div className="text-xs text-secondary">{summary}</div>
        </div>
        <button type="button" className="accent-button accent-button--tall pressable w-full" onClick={handleApply}>
          Apply
        </button>
        <button type="button" className="ghost-button button-sm pressable w-full" onClick={onOpenAdvanced}>
          Advanced recurrence…
        </button>
      </div>
    </ActionSheet>
  );
}

export function EndRepeatSheet({
  open,
  onClose,
  rule,
  scheduledDate,
  onSelect,
  timeZone,
}: {
  open: boolean;
  onClose: () => void;
  rule: Recurrence;
  scheduledDate?: string;
  onSelect: (untilISO?: string) => void;
  timeZone?: string;
}) {
  const [mode, setMode] = useState<"menu" | "calendar">("menu");
  const [calendarBaseDate, setCalendarBaseDate] = useState(() =>
    rule.untilISO ? isoDatePart(rule.untilISO, timeZone) : scheduledDate
  );
  const [selectedDate, setSelectedDate] = useState(() => (rule.untilISO ? isoDatePart(rule.untilISO, timeZone) : ""));

  useEffect(() => {
    if (!open) return;
    setMode("menu");
    const baseDate = rule.untilISO ? isoDatePart(rule.untilISO, timeZone) : scheduledDate;
    setSelectedDate(rule.untilISO ? isoDatePart(rule.untilISO, timeZone) : "");
    setCalendarBaseDate(baseDate);
  }, [open, rule.untilISO, scheduledDate, timeZone]);

  const handleSelectCalendarDay = useCallback(
    (iso: string) => {
      setSelectedDate(iso);
      onSelect(isoFromDateTime(iso, "12:00", timeZone));
      setMode("menu");
      onClose();
    },
    [onClose, onSelect, timeZone],
  );

  return (
    <ActionSheet
      open={open}
      onClose={onClose}
      title="End repeat"
      actions={
        mode === "calendar" ? (
          <button className="ghost-button button-sm pressable" onClick={() => setMode("menu")}>Back</button>
        ) : undefined
      }
    >
      {mode === "menu" ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface"
            onClick={() => {
              onSelect(undefined);
              onClose();
            }}
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-primary">Never</div>
            </div>
            {!rule.untilISO && <span className="text-accent text-sm font-semibold">✓</span>}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface"
            onClick={() => setMode("calendar")}
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-primary">On date</div>
              {rule.untilISO && (
                <div className="text-xs text-secondary">
                  {(() => {
                    const dateKey = isoDatePart(rule.untilISO, timeZone);
                    const parsed = new Date(`${dateKey}T00:00:00`);
                    if (Number.isNaN(parsed.getTime())) return dateKey;
                    return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
                  })()}
                </div>
              )}
            </div>
            {rule.untilISO && <span className="text-accent text-sm font-semibold">✓</span>}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-2xl border border-border bg-elevated p-4">
            <DatePickerCalendar
              baseDate={calendarBaseDate}
              selectedDate={selectedDate}
              onSelectDate={handleSelectCalendarDay}
            />
          </div>
        </div>
      )}
    </ActionSheet>
  );
}

function repeatWeekdayFromInput(value?: string): Weekday {
  const base = repeatBaseDate(value);
  return base.getDay() as Weekday;
}

function repeatMonthDayFromInput(value?: string): number {
  const base = repeatBaseDate(value);
  return Math.min(28, Math.max(1, base.getDate()));
}

function repeatBaseDate(value?: string): Date {
  if (!value) return new Date();
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function recurrenceMatchesPreset(candidate: Recurrence, preset: Recurrence): boolean {
  const candidateRest = { ...(candidate as Record<string, unknown>) };
  const presetRest = { ...(preset as Record<string, unknown>) };
  delete candidateRest.untilISO;
  delete presetRest.untilISO;
  return JSON.stringify(candidateRest) === JSON.stringify(presetRest);
}

function RecurrencePicker({ value, onChange, allowHourly }: {
  value: Recurrence;
  onChange: (rule: Recurrence) => void;
  allowHourly: boolean;
}) {
  const [weekly, setWeekly] = useState<Set<Weekday>>(new Set());
  const [everyN, setEveryN] = useState(2);
  const [unit, setUnit] = useState<"hour"|"day"|"week">("day");
  const [monthDay, setMonthDay] = useState(15);
  const [monthInterval, setMonthInterval] = useState(1);
  const [end, setEnd] = useState(value.untilISO ? value.untilISO.slice(0,10) : "");

  useEffect(()=>{
    switch (value.type) {
      case "weekly": setWeekly(new Set(value.days)); break;
      case "every": setEveryN(value.n); setUnit(value.unit); break;
      case "monthlyDay": setMonthDay(value.day); setMonthInterval(value.interval ?? 1); break;
      default: setWeekly(new Set());
    }
    setEnd(value.untilISO ? value.untilISO.slice(0,10) : "");
  }, [value]);

  const withEnd = (r: Recurrence): Recurrence => ({ ...r, untilISO: end ? new Date(end).toISOString() : undefined });
  function setNone() { onChange(withEnd({ type: "none" })); }
  function setDaily() { onChange(withEnd({ type: "daily" })); }
    function toggleDay(d: Weekday) {
      const next = new Set(weekly);
      if (next.has(d)) {
        next.delete(d);
      } else {
        next.add(d);
      }
      setWeekly(next);
      const sorted = Array.from(next).sort((a,b)=>a-b);
      onChange(withEnd(sorted.length ? { type: "weekly", days: sorted } : { type: "none" }));
    }
  function applyEvery() { onChange(withEnd({ type:"every", n: Math.max(1, everyN || 1), unit })); }
  function applyMonthly() {
    onChange(
      withEnd({
        type:"monthlyDay",
        day: Math.min(28, Math.max(1, monthDay)),
        interval: Math.max(1, Math.min(24, monthInterval || 1)),
      })
    );
  }

  return (
    <div className="space-y-4">
      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Preset</div>
        <div className="flex flex-wrap gap-2">
          <button className="ghost-button button-sm pressable" onClick={setNone}>None</button>
          <button className="ghost-button button-sm pressable" onClick={setDaily}>Daily</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Weekly</div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
          {Array.from({length:7},(_,i)=>i as Weekday).map(d=>{
            const on = weekly.has(d);
            const cls = on ? 'accent-button button-sm pressable w-full justify-center' : 'ghost-button button-sm pressable w-full justify-center';
            return (
              <button key={d} onClick={()=>toggleDay(d)} className={cls}>
                {WD_SHORT[d]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Every N</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={30}
            value={everyN}
            onChange={e=>setEveryN(parseInt(e.target.value || "1",10))}
            className="pill-input w-24 text-center"
          />
          <select value={unit} onChange={e=>setUnit(e.target.value as "hour"|"day"|"week")}
                  className="pill-select w-32">
            {allowHourly && <option value="hour">Hours</option>}
            <option value="day">Days</option>
            <option value="week">Weeks</option>
          </select>
          <button className="accent-button button-sm pressable" onClick={applyEvery}>Apply</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Monthly</div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs uppercase tracking-wide text-secondary">Day</label>
          <input
            type="number"
            min={1}
            max={28}
            value={monthDay}
            onChange={e=>setMonthDay(parseInt(e.target.value || '1',10))}
            className="pill-input w-20 text-center"
          />
          <label className="text-xs uppercase tracking-wide text-secondary">Every</label>
          <input
            type="number"
            min={1}
            max={24}
            value={monthInterval}
            onChange={e=>setMonthInterval(parseInt(e.target.value || '1',10))}
            className="pill-input w-20 text-center"
          />
          <span className="text-xs uppercase tracking-wide text-secondary">Month(s)</span>
          <button className="accent-button button-sm pressable" onClick={applyMonthly}>Apply</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">End date</div>
        <input
          type="date"
          value={end}
          onChange={e=>{ const v = e.target.value; setEnd(v); onChange({ ...value, untilISO: v ? new Date(v).toISOString() : undefined }); }}
          className="pill-input w-full"
        />
      </div>
    </div>
  );
}

