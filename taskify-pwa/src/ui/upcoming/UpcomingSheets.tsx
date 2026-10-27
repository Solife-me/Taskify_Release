import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from "react";
import { ActionSheet } from "../../components/ActionSheet";
import {
  presetFilter,
  savePreset,
  toggleUpcomingFilterOption,
  upcomingFilterOptions,
  upcomingFilterSelection,
  type UpcomingFilterGroup,
  type UpcomingFilterPreset,
} from "../../domains/upcoming/upcomingFilter";
import {
  nextSortForMode,
  updateUpcomingPreferences,
  useUpcomingPreferences,
} from "../../domains/upcoming/upcomingPreferences";
import { SortModeButtons } from "../sort/SortModeButtons";

const GROUPING_OPTIONS = [
  { id: "mixed", label: "Across boards" },
  { id: "grouped", label: "Group by board" },
] as const;

const PRESET_HOLD_MS = 650;
const PRESET_HOLD_SLOP_PX = 12;

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l4 4 10-10" />
    </svg>
  );
}

function FilterRow({ label, checked, child, onToggle }: { label: string; checked: boolean; child?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`upcoming-filter__row${child ? " upcoming-filter__row--child" : ""} pressable`}
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
    >
      <span className={`upcoming-filter__check${checked ? " is-checked" : ""}`} aria-hidden="true">
        {checked && <CheckIcon />}
      </span>
      <span className="upcoming-filter__label">{label}</span>
    </button>
  );
}

/** Press and hold a preset to delete it; a tap applies it. */
function usePresetHold(onHold: (preset: UpcomingFilterPreset) => void) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const triggeredRef = useRef(false);
  const cancel = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const start = useCallback((preset: UpcomingFilterPreset, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    cancel();
    triggeredRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      startRef.current = null;
      triggeredRef.current = true;
      onHold(preset);
    }, PRESET_HOLD_MS);
  }, [cancel, onHold]);
  const move = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const origin = startRef.current;
    if (!origin) return;
    if (Math.abs(event.clientX - origin.x) > PRESET_HOLD_SLOP_PX || Math.abs(event.clientY - origin.y) > PRESET_HOLD_SLOP_PX) cancel();
  }, [cancel]);
  /** True (once) when the click that follows a hold should be ignored. */
  const consumeHold = useCallback(() => {
    const held = triggeredRef.current;
    triggeredRef.current = false;
    return held;
  }, []);
  return { start, move, cancel, consumeHold };
}

export function UpcomingSheets({
  sortOpen,
  onCloseSort,
  filterOpen,
  onCloseFilter,
  filterGroups,
}: {
  sortOpen: boolean;
  onCloseSort: () => void;
  filterOpen: boolean;
  onCloseFilter: () => void;
  filterGroups: UpcomingFilterGroup[];
}) {
  const preferences = useUpcomingPreferences();
  const selection = useMemo(() => upcomingFilterSelection(preferences.filter, filterGroups), [filterGroups, preferences.filter]);

  const deletePreset = useCallback((preset: UpcomingFilterPreset) => {
    if (typeof window.confirm === "function" && !window.confirm(`Delete preset "${preset.name}"?`)) return;
    updateUpcomingPreferences((current) => ({ filterPresets: current.filterPresets.filter((p) => p.id !== preset.id) }));
  }, []);
  const hold = usePresetHold(deletePreset);

  const saveCurrentAsPreset = () => {
    if (!upcomingFilterOptions(filterGroups).length) return;
    const name = window.prompt("Name this preset")?.trim();
    if (!name) return;
    const chosen = upcomingFilterOptions(filterGroups).filter((option) => selection.has(option.id)).map((option) => option.id);
    updateUpcomingPreferences((current) => ({ filterPresets: savePreset(current.filterPresets, name, chosen) }));
  };

  return (
    <>
      <ActionSheet open={sortOpen} onClose={onCloseSort} title="Sort">
        <div className="wallet-section space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-secondary">Sort tasks by</div>
          <SortModeButtons
            sort={preferences.sort}
            onSelect={(mode) => updateUpcomingPreferences((current) => ({ sort: nextSortForMode(current.sort, mode) }))}
          />
          <div className="text-xs uppercase tracking-wide text-secondary">Boards</div>
          <div className="flex flex-wrap gap-2">
            {GROUPING_OPTIONS.map((option) => {
              const active = preferences.grouping === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
                  onClick={() => updateUpcomingPreferences({ grouping: option.id })}
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet open={filterOpen} onClose={onCloseFilter} title="Calendars" panelClassName="sheet-panel--tall">
        <div className="upcoming-filter">
          <div className="upcoming-filter__controls">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => updateUpcomingPreferences({ filter: null, usHolidaysEnabled: true })}
            >
              Select all
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => updateUpcomingPreferences({ filter: [], usHolidaysEnabled: false })}
            >
              Clear all
            </button>
            {preferences.filterPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="ghost-button button-sm pressable"
                onClick={(event) => {
                  if (hold.consumeHold()) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  if (upcomingFilterOptions(filterGroups).length) updateUpcomingPreferences({ filter: presetFilter(preset, filterGroups) });
                }}
                onPointerDown={(event) => hold.start(preset, event)}
                onPointerUp={hold.cancel}
                onPointerCancel={hold.cancel}
                onPointerLeave={hold.cancel}
                onPointerMove={hold.move}
                onContextMenu={(event) => event.preventDefault()}
                title="Press and hold to delete"
              >
                {preset.name}
              </button>
            ))}
          </div>
          <div className="upcoming-filter__list">
            {filterGroups.length === 0 ? (
              <div className="text-sm text-secondary">No boards yet.</div>
            ) : (
              filterGroups.map((group) => (
                <div key={group.id} className="upcoming-filter__group">
                  <FilterRow
                    label={group.label}
                    checked={selection.has(group.boardOption.id)}
                    onToggle={() => updateUpcomingPreferences((current) => ({
                      filter: toggleUpcomingFilterOption(current.filter, group.boardOption.id, filterGroups),
                    }))}
                  />
                  {group.listOptions.length > 0 && (
                    <div className="upcoming-filter__sublist">
                      {group.listOptions.map((option) => (
                        <FilterRow
                          key={option.id}
                          child
                          label={option.label}
                          checked={selection.has(option.id)}
                          onToggle={() => updateUpcomingPreferences((current) => ({
                            filter: toggleUpcomingFilterOption(current.filter, option.id, filterGroups),
                          }))}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            <div className="upcoming-filter__group">
              <FilterRow
                label="US Holidays"
                checked={preferences.usHolidaysEnabled}
                onToggle={() => updateUpcomingPreferences((current) => ({ usHolidaysEnabled: !current.usHolidaysEnabled }))}
              />
            </div>
            <div>
              <button type="button" className="ghost-button button-sm pressable" onClick={saveCurrentAsPreset}>
                Save as preset
              </button>
            </div>
          </div>
        </div>
      </ActionSheet>
    </>
  );
}
