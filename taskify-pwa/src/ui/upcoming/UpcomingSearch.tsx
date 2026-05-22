// Upcoming page search-input — collapsible field above the calendar/list.
// Extracted from App.tsx (Item #10 page-component series).
//
// State (`value`/`onChange`/`onClose`) lives in the parent so the search query
// can filter the grouped-upcoming list rendered alongside. Pressing `Escape`
// or clicking the × button both call `onClose` (which also clears the value,
// per the existing behavior of `closeUpcomingSearch`).

import type { ReactNode, RefObject } from "react";

export type UpcomingSearchProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
};

export function UpcomingSearch({
  inputRef,
  value,
  onChange,
  onClose,
}: UpcomingSearchProps): ReactNode {
  return (
    <div className="upcoming-search">
      <div className="upcoming-search__field">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="upcoming-search__icon"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.65" y1="16.65" x2="21" y2="21" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          className="upcoming-search__input"
          placeholder="Search title or notes"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          aria-label="Search tasks by title or notes"
        />
        <button
          type="button"
          className="upcoming-search__clear pressable"
          onClick={onClose}
          aria-label={value ? "Clear search" : "Close search"}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
