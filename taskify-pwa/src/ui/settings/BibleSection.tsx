// @ts-nocheck
import React, { useState, useEffect, useMemo } from "react";
import type { Settings } from "../../domains/tasks/settingsTypes";
import type { Board, Weekday } from "../../domains/tasks/taskTypes";
import type { ScriptureMemoryFrequency, ScriptureMemorySort } from "../../domains/scripture/scriptureTypes";
import { SCRIPTURE_MEMORY_FREQUENCIES, SCRIPTURE_MEMORY_SORTS } from "../../domains/scripture/scriptureUtils";
import { pillButtonClass, WD_FULL } from "./settingsConstants";

export function BibleSection({
  settings,
  setSettings,
  boards,
  currentBoard,
  embedded = false,
}: {
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
  boards: Board[];
  currentBoard: Board | null;
  embedded?: boolean;
}) {
  const [bibleExpanded, setBibleExpanded] = useState(false);
  const [fastingPerMonthDraft, setFastingPerMonthDraft] = useState(() => String(settings.fastingRemindersPerMonth));

  const availableMemoryBoards = useMemo(
    () => boards.filter((board) => !board.archived && board.kind !== "bible"),
    [boards],
  );
  const defaultScriptureMemoryBoardId = useMemo(
    () => availableMemoryBoards[0]?.id ?? null,
    [availableMemoryBoards],
  );

  useEffect(() => {
    setFastingPerMonthDraft(String(settings.fastingRemindersPerMonth));
  }, [settings.fastingRemindersMode, settings.fastingRemindersPerMonth]);

  return (
    <section className="wallet-section space-y-3">
      {!embedded && (
        <button
          className="flex w-full items-center gap-2 mb-3 text-left"
          onClick={() => setBibleExpanded((prev) => !prev)}
          aria-expanded={bibleExpanded}
        >
          <div className="text-sm font-medium flex-1">Bible</div>
          <span className="text-xs text-tertiary">{bibleExpanded ? "Hide" : "Show"}</span>
          <span className="text-tertiary">{bibleExpanded ? "−" : "+"}</span>
        </button>
      )}
      {(embedded || bibleExpanded) && (
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium mb-2">Bible tracker</div>
            <div className="flex gap-2">
              <button
                className={pillButtonClass(settings.bibleTrackerEnabled)}
                onClick={() => setSettings({ bibleTrackerEnabled: true })}
              >On</button>
              <button
                className={pillButtonClass(!settings.bibleTrackerEnabled)}
                onClick={() => setSettings({ bibleTrackerEnabled: false })}
              >Off</button>
            </div>
            <div className="text-xs text-secondary mt-2">Track your Bible reading, reset progress, and review archived snapshots.</div>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">Scripture memory</div>
            <div className="flex gap-2">
              <button
                className={pillButtonClass(settings.scriptureMemoryEnabled)}
                onClick={() => {
                  const preferredBoardId =
                    settings.scriptureMemoryBoardId
                      || (currentBoard && currentBoard.kind !== "bible" ? currentBoard.id : defaultScriptureMemoryBoardId)
                      || null;
                  setSettings({
                    bibleTrackerEnabled: true,
                    scriptureMemoryEnabled: true,
                    scriptureMemoryBoardId: preferredBoardId,
                  });
                }}
              >On</button>
              <button
                className={pillButtonClass(!settings.scriptureMemoryEnabled)}
                onClick={() => setSettings({ scriptureMemoryEnabled: false })}
              >Off</button>
            </div>
            <div className="text-xs text-secondary mt-2">
              Keep passages you&apos;re memorizing and let Taskify schedule gentle review reminders.
            </div>
          </div>
          {settings.scriptureMemoryEnabled && (
            <>
              <div>
                <div className="text-sm font-medium mb-2">Review board</div>
                <select
                  value={settings.scriptureMemoryBoardId || ""}
                  onChange={(event) => setSettings({ scriptureMemoryBoardId: event.target.value || null })}
                  className="pill-select w-full"
                >
                  <option value="">Select a board…</option>
                  {availableMemoryBoards.map((board) => (
                    <option key={board.id} value={board.id}>{board.name}</option>
                  ))}
                </select>
                <div className="text-xs text-secondary mt-2">
                  Scripture memory tasks will appear on this board.
                </div>
                {availableMemoryBoards.length === 0 && (
                  <div className="text-xs text-secondary mt-1">
                    Create a board (besides the Bible board) to receive scripture memory tasks.
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Review frequency</div>
                <select
                  value={settings.scriptureMemoryFrequency}
                  onChange={(event) =>
                    setSettings({ scriptureMemoryFrequency: event.target.value as ScriptureMemoryFrequency })
                  }
                  className="pill-select w-full"
                >
                  {SCRIPTURE_MEMORY_FREQUENCIES.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
                <div className="text-xs text-secondary mt-2">
                  {SCRIPTURE_MEMORY_FREQUENCIES.find((opt) => opt.id === settings.scriptureMemoryFrequency)?.description}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Sort scriptures by</div>
                <select
                  value={settings.scriptureMemorySort}
                  onChange={(event) =>
                    setSettings({ scriptureMemorySort: event.target.value as ScriptureMemorySort })
                  }
                  className="pill-select w-full"
                >
                  {SCRIPTURE_MEMORY_SORTS.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div>
            <div className="text-sm font-medium mb-2">Fasting reminders</div>
            <div className="flex gap-2">
              <button
                className={pillButtonClass(settings.fastingRemindersEnabled)}
                onClick={() => setSettings({ fastingRemindersEnabled: true })}
              >
                On
              </button>
              <button
                className={pillButtonClass(!settings.fastingRemindersEnabled)}
                onClick={() => setSettings({ fastingRemindersEnabled: false })}
              >
                Off
              </button>
            </div>
            <div className="text-xs text-secondary mt-2">
              Create fasting reminder tasks on your Week board.
            </div>
          </div>
          {settings.fastingRemindersEnabled && (
            <>
              <div>
                <div className="text-sm font-medium mb-2">Schedule mode</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.fastingRemindersMode === "weekday")}
                    onClick={() => setSettings({ fastingRemindersMode: "weekday" })}
                  >
                    Weekday
                  </button>
                  <button
                    className={pillButtonClass(settings.fastingRemindersMode === "random")}
                    onClick={() => setSettings({ fastingRemindersMode: "random" })}
                  >
                    Random
                  </button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  {settings.fastingRemindersMode === "random"
                    ? "Taskify randomly picks days in the month."
                    : "Taskify schedules reminders on a consistent weekday."}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">
                  {settings.fastingRemindersMode === "random" ? "Days per month" : "Times per month"}
                </div>
                <input
                  className="pill-input w-full"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={settings.fastingRemindersMode === "random" ? 31 : 5}
                  value={fastingPerMonthDraft}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFastingPerMonthDraft(value);
                    if (!value.trim()) return;
                    const raw = Number(value);
                    if (!Number.isFinite(raw)) return;
                    const max = settings.fastingRemindersMode === "random" ? 31 : 5;
                    const nextValue = Math.max(1, Math.min(max, Math.round(raw)));
                    setSettings({ fastingRemindersPerMonth: nextValue });
                  }}
                  onBlur={() => {
                    if (!fastingPerMonthDraft.trim()) {
                      setFastingPerMonthDraft(String(settings.fastingRemindersPerMonth));
                      return;
                    }
                    const raw = Number(fastingPerMonthDraft);
                    if (!Number.isFinite(raw)) {
                      setFastingPerMonthDraft(String(settings.fastingRemindersPerMonth));
                      return;
                    }
                    const max = settings.fastingRemindersMode === "random" ? 31 : 5;
                    const nextValue = Math.max(1, Math.min(max, Math.round(raw)));
                    setFastingPerMonthDraft(String(nextValue));
                    if (nextValue !== settings.fastingRemindersPerMonth) {
                      setSettings({ fastingRemindersPerMonth: nextValue });
                    }
                  }}
                />
              </div>
              {settings.fastingRemindersMode === "weekday" && (
                <div>
                  <div className="text-sm font-medium mb-2">Day of week</div>
                  <select
                    value={String(settings.fastingRemindersWeekday)}
                    onChange={(event) => setSettings({ fastingRemindersWeekday: Number(event.target.value) as Weekday })}
                    className="pill-select w-full"
                  >
                    {WD_FULL.map((label, day) => (
                      <option key={label} value={String(day)}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
