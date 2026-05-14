// Upcoming page footer-controls — Today + Filter buttons. Extracted from
// App.tsx (Item #10 page-component series). Small, self-contained.

import type { ReactNode } from "react";

export type UpcomingControlsProps = {
  /** When true, the Today button is greyed out (no upcoming groups in details view). */
  todayDisabled: boolean;
  onTodayClick: () => void;
  /** Filter button: shown active when a filter is applied or the filter sheet is open. */
  filterActive: boolean;
  filterLabel: string;
  onOpenFilter: () => void;
};

export function UpcomingControls({
  todayDisabled,
  onTodayClick,
  filterActive,
  filterLabel,
  onOpenFilter,
}: UpcomingControlsProps): ReactNode {
  return (
    <div className="upcoming-controls">
      <div className="upcoming-controls__left">
        <button
          type="button"
          className="upcoming-controls__today pressable"
          onClick={onTodayClick}
          disabled={todayDisabled}
          title="Jump to today"
          aria-label="Jump to today"
        >
          Today
        </button>
      </div>
      <div className="upcoming-controls__right">
        <button
          type="button"
          className="app-header__icon-btn pressable"
          onClick={onOpenFilter}
          title={`Filter upcoming tasks (${filterLabel})`}
          aria-label={`Filter upcoming tasks (${filterLabel})`}
          data-active={filterActive}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-[18px] w-[18px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
            <circle cx="9" cy="6" r="2" />
            <circle cx="15" cy="12" r="2" />
            <circle cx="11" cy="18" r="2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
