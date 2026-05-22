import type { Dispatch, MutableRefObject, PointerEvent, SetStateAction } from "react";
import type {
  BoardSortDirection,
  BoardSortMode,
  UpcomingBoardGrouping,
} from "taskify-core";
import { ActionSheet } from "../../components/ActionSheet";
import type { GcalCalendar, GcalConnectionStatus } from "../../hooks/useGoogleCalendar";

type SortOption = {
  id: BoardSortMode;
  label: string;
  supportsDirection?: boolean;
};

type BoardGroupingOption = {
  id: UpcomingBoardGrouping;
  label: string;
};

type FilterPreset = {
  id: string;
  name: string;
  selection: string[];
};

type FilterOption = {
  id: string;
  label: string;
};

type FilterGroup = {
  id: string;
  label: string;
  boardOption: FilterOption;
  listOptions: FilterOption[];
};

type AppSortSheetsProps = {
  applyUpcomingFilterPreset: (preset: FilterPreset) => void;
  boardSort: { mode: BoardSortMode; direction: BoardSortDirection };
  boardSortOptions: readonly SortOption[];
  boardSortSheetOpen: boolean;
  cancelUpcomingPresetHold: () => void;
  gcalCalendars: GcalCalendar[];
  gcalStatus: GcalConnectionStatus;
  handleBoardSortSelect: (id: BoardSortMode) => void;
  handleUpcomingSortSelect: (id: BoardSortMode) => void;
  handleUpcomingViewChange: (view: "details" | "list") => void;
  maybeCancelUpcomingPresetHold: (event: PointerEvent<HTMLButtonElement>) => void;
  saveUpcomingFilterPreset: () => void;
  setBoardSortSheetOpen: (open: boolean) => void;
  setUpcomingBoardGrouping: Dispatch<SetStateAction<UpcomingBoardGrouping>>;
  setUpcomingFilter: (value: string[] | null) => void;
  setUpcomingFilterOpen: (open: boolean) => void;
  setUpcomingSortSheetOpen: (open: boolean) => void;
  setUpcomingUsHolidaysEnabled: Dispatch<SetStateAction<boolean>>;
  setUpcomingViewSheetOpen: (open: boolean) => void;
  startUpcomingPresetHold: (preset: FilterPreset, event: PointerEvent<HTMLButtonElement>) => void;
  toggleUpcomingFilter: (id: string) => void;
  upcomingBoardGrouping: UpcomingBoardGrouping;
  upcomingBoardGroupingOptions: readonly BoardGroupingOption[];
  upcomingFilter: string[] | null;
  upcomingFilterGroups: FilterGroup[];
  upcomingFilterOpen: boolean;
  upcomingFilterOptions: FilterOption[];
  upcomingFilterPresets: FilterPreset[];
  upcomingFilterSelection: Set<string>;
  upcomingPresetHoldTriggeredRef: MutableRefObject<boolean>;
  upcomingSort: { mode: BoardSortMode; direction: BoardSortDirection };
  upcomingSortSheetOpen: boolean;
  upcomingUsHolidaysEnabled: boolean;
  upcomingView: "details" | "list";
  upcomingViewSheetOpen: boolean;
};

function sortArrow(direction: BoardSortDirection, invertArrow: boolean) {
  return direction === "asc"
    ? (invertArrow ? "↓" : "↑")
    : (invertArrow ? "↑" : "↓");
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l4 4 10-10" />
    </svg>
  );
}

export function AppSortSheets({
  applyUpcomingFilterPreset,
  boardSort,
  boardSortOptions,
  boardSortSheetOpen,
  cancelUpcomingPresetHold,
  gcalCalendars,
  gcalStatus,
  handleBoardSortSelect,
  handleUpcomingSortSelect,
  handleUpcomingViewChange,
  maybeCancelUpcomingPresetHold,
  saveUpcomingFilterPreset,
  setBoardSortSheetOpen,
  setUpcomingBoardGrouping,
  setUpcomingFilter,
  setUpcomingFilterOpen,
  setUpcomingSortSheetOpen,
  setUpcomingUsHolidaysEnabled,
  setUpcomingViewSheetOpen,
  startUpcomingPresetHold,
  toggleUpcomingFilter,
  upcomingBoardGrouping,
  upcomingBoardGroupingOptions,
  upcomingFilter,
  upcomingFilterGroups,
  upcomingFilterOpen,
  upcomingFilterOptions,
  upcomingFilterPresets,
  upcomingFilterSelection,
  upcomingPresetHoldTriggeredRef,
  upcomingSort,
  upcomingSortSheetOpen,
  upcomingUsHolidaysEnabled,
  upcomingView,
  upcomingViewSheetOpen,
}: AppSortSheetsProps) {
  return (
    <>
      <ActionSheet
        open={boardSortSheetOpen}
        onClose={() => setBoardSortSheetOpen(false)}
        title="Filter and sort"
      >
        <div className="wallet-section space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-secondary">Sort tasks by</div>
          <div className="flex flex-wrap gap-2">
            {boardSortOptions.map((option) => {
              const active = boardSort.mode === option.id;
              const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
              const showArrow = active && option.supportsDirection;
              const invertArrow = option.id === "due" || option.id === "alpha";
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cls}
                  onClick={() => handleBoardSortSelect(option.id)}
                >
                  <span>{option.label}</span>
                  {showArrow && <span className="ml-1 text-xs">{sortArrow(boardSort.direction, invertArrow)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={upcomingSortSheetOpen}
        onClose={() => setUpcomingSortSheetOpen(false)}
        title="Sort"
      >
        <div className="wallet-section space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-secondary">Sort tasks by</div>
          <div className="flex flex-wrap gap-2">
            {boardSortOptions.map((option) => {
              const active = upcomingSort.mode === option.id;
              const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
              const showArrow = active && option.supportsDirection;
              const invertArrow = option.id === "due" || option.id === "alpha";
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cls}
                  onClick={() => handleUpcomingSortSelect(option.id)}
                  aria-pressed={active}
                >
                  <span>{option.label}</span>
                  {showArrow && <span className="ml-1 text-xs">{sortArrow(upcomingSort.direction, invertArrow)}</span>}
                </button>
              );
            })}
          </div>
          <div className="text-xs uppercase tracking-wide text-secondary">Boards</div>
          <div className="flex flex-wrap gap-2">
            {upcomingBoardGroupingOptions.map((option) => {
              const active = upcomingBoardGrouping === option.id;
              const cls = active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable";
              return (
                <button
                  key={option.id}
                  type="button"
                  className={cls}
                  onClick={() => setUpcomingBoardGrouping(option.id)}
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </ActionSheet>

      <ActionSheet
        open={upcomingViewSheetOpen}
        onClose={() => setUpcomingViewSheetOpen(false)}
        title="View"
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
          {[
            { id: "details", label: "Details" },
            { id: "list", label: "List" },
          ].map((option) => {
            const active = upcomingView === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface"
                onClick={() => handleUpcomingViewChange(option.id as "details" | "list")}
                aria-pressed={active}
              >
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{option.label}</div>
                </div>
                {active && <span className="text-accent text-sm font-semibold">✓</span>}
              </button>
            );
          })}
        </div>
      </ActionSheet>

      <ActionSheet
        open={upcomingFilterOpen}
        onClose={() => setUpcomingFilterOpen(false)}
        title="Calendars"
        panelClassName="sheet-panel--tall"
      >
        <div className="upcoming-filter">
          <div className="upcoming-filter__controls">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setUpcomingFilter(null);
                setUpcomingUsHolidaysEnabled(true);
              }}
            >
              Select all
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setUpcomingFilter([]);
                setUpcomingUsHolidaysEnabled(false);
              }}
            >
              Clear all
            </button>
            {upcomingFilterPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="ghost-button button-sm pressable"
                onClick={(event) => {
                  if (upcomingPresetHoldTriggeredRef.current) {
                    upcomingPresetHoldTriggeredRef.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  applyUpcomingFilterPreset(preset);
                }}
                onPointerDown={(event) => startUpcomingPresetHold(preset, event)}
                onPointerUp={cancelUpcomingPresetHold}
                onPointerCancel={cancelUpcomingPresetHold}
                onPointerLeave={cancelUpcomingPresetHold}
                onPointerMove={maybeCancelUpcomingPresetHold}
                onContextMenu={(event) => event.preventDefault()}
                title="Press and hold to delete"
              >
                {preset.name}
              </button>
            ))}
          </div>
          <div className="upcoming-filter__list">
            {upcomingFilterGroups.length === 0 ? (
              <div className="text-sm text-secondary">No boards yet.</div>
            ) : (
              upcomingFilterGroups.map((group) => (
                <div key={group.id} className="upcoming-filter__group">
                  <button
                    type="button"
                    className="upcoming-filter__row pressable"
                    onClick={() => toggleUpcomingFilter(group.boardOption.id)}
                    role="checkbox"
                    aria-checked={upcomingFilterSelection.has(group.boardOption.id)}
                  >
                    <span
                      className={`upcoming-filter__check${upcomingFilterSelection.has(group.boardOption.id) ? " is-checked" : ""}`}
                      aria-hidden="true"
                    >
                      {upcomingFilterSelection.has(group.boardOption.id) && <CheckIcon />}
                    </span>
                    <span className="upcoming-filter__label">{group.label}</span>
                  </button>
                  {group.listOptions.length > 0 && (
                    <div className="upcoming-filter__sublist">
                      {group.listOptions.map((option) => {
                        const checked = upcomingFilterSelection.has(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className="upcoming-filter__row upcoming-filter__row--child pressable"
                            onClick={() => toggleUpcomingFilter(option.id)}
                            role="checkbox"
                            aria-checked={checked}
                          >
                            <span
                              className={`upcoming-filter__check${checked ? " is-checked" : ""}`}
                              aria-hidden="true"
                            >
                              {checked && <CheckIcon />}
                            </span>
                            <span className="upcoming-filter__label">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
            <div className="upcoming-filter__group">
              <button
                type="button"
                className="upcoming-filter__row pressable"
                onClick={() => setUpcomingUsHolidaysEnabled((prev) => !prev)}
                role="checkbox"
                aria-checked={upcomingUsHolidaysEnabled}
              >
                <span
                  className={`upcoming-filter__check${upcomingUsHolidaysEnabled ? " is-checked" : ""}`}
                  aria-hidden="true"
                >
                  {upcomingUsHolidaysEnabled && <CheckIcon />}
                </span>
                <span className="upcoming-filter__label">US Holidays</span>
              </button>
            </div>
            {gcalStatus.connected && gcalCalendars.map((cal) => {
              const boardId = `gcal:${cal.id}`;
              const isSelected = upcomingFilter === null || upcomingFilter.includes(boardId);
              return (
                <div key={cal.id} className="upcoming-filter__group">
                  <button
                    type="button"
                    className="upcoming-filter__row pressable"
                    onClick={() => {
                      if (upcomingFilter === null) {
                        const allIds = upcomingFilterOptions.map((option) => option.id);
                        setUpcomingFilter(allIds.filter((id) => id !== boardId));
                      } else if (isSelected) {
                        setUpcomingFilter(upcomingFilter.filter((id) => id !== boardId));
                      } else {
                        setUpcomingFilter([...upcomingFilter, boardId]);
                      }
                    }}
                    role="checkbox"
                    aria-checked={isSelected}
                  >
                    <span
                      className={`upcoming-filter__check${isSelected ? " is-checked" : ""}`}
                      aria-hidden="true"
                    >
                      {isSelected && <CheckIcon />}
                    </span>
                    <span className="upcoming-filter__label">
                      {cal.color && (
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-1.5"
                          style={{ backgroundColor: cal.color, verticalAlign: "middle" }}
                        />
                      )}
                      {cal.name}
                    </span>
                  </button>
                </div>
              );
            })}
            <div>
              <button
                type="button"
                className="ghost-button button-sm pressable"
                onClick={saveUpcomingFilterPreset}
              >
                Save as preset
              </button>
            </div>
          </div>
        </div>
      </ActionSheet>
    </>
  );
}
