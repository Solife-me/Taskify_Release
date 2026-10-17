/**
 * The Upcoming page: every dated task and event across the user's boards, as a day-by-day list
 * ("details") or a month calendar with one day's items ("list"). Loaded on first visit.
 *
 * `App` owns the layout: it gives this page a slot in the header for its actions, a slot above
 * the tab bar for its controls, and the scroll container. Cards are rendered by `App`, which owns
 * the task and event actions.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { formatDateKeyLocal, isoDatePart } from "taskify-core";
import { MONTH_NAMES, WD_SHORT } from "../../domains/appTypes";
import {
  SPECIAL_CALENDAR_US_HOLIDAY_RANGE_FUTURE_YEARS,
  SPECIAL_CALENDAR_US_HOLIDAY_RANGE_PAST_YEARS,
  SPECIAL_CALENDAR_US_HOLIDAYS_LABEL,
} from "../../domains/calendar/calendarUtils";
import { buildUsHolidayCalendarEvents } from "../../domains/calendar/holidayUtils";
import { useCalendarPicker } from "../../domains/dateTime/calendarPickerHook";
import { daysInCalendarMonth, startOfDay } from "../../domains/dateTime/dateUtils";
import type { Board, CalendarEvent, Task } from "../../domains/tasks/taskTypes";
import {
  reconcileUpcomingFilter,
  upcomingFilterGroups,
  upcomingFilterLabel,
  upcomingFilterMap,
  upcomingFilterSelection,
} from "../../domains/upcoming/upcomingFilter";
import {
  filterUpcomingEvents,
  filterUpcomingTasks,
  groupUpcomingByDay,
  selectUpcomingEvents,
  selectUpcomingTasks,
  upcomingBoardOrder,
  upcomingDayGroups,
  type UpcomingFilter,
} from "../../domains/upcoming/upcomingModel";
import { updateUpcomingPreferences, useUpcomingPreferences } from "../../domains/upcoming/upcomingPreferences";
import { buildUpcomingDateKeyIndex, flattenUpcomingGroups, type UpcomingFlatRow } from "../../lib/upcomingRows";
import type { AppRoute } from "../../routing/appRoute";
import type { AppHistoryRouter } from "../../routing/appRouter";
import { useOverlayHistory } from "../../routing/useOverlayHistory";
import { UpcomingControls } from "./UpcomingControls";
import { UpcomingSearch } from "./UpcomingSearch";
import { UpcomingSheets } from "./UpcomingSheets";

export type UpcomingPageProps = {
  tasks: Task[];
  calendarEvents: CalendarEvent[];
  visibleBoards: Board[];
  boardMap: Map<string, Board>;
  messagesBoardId?: string | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  headerSlot: HTMLElement | null;
  footerSlot: HTMLElement | null;
  renderTaskCard: (task: Task) => ReactNode;
  renderEventCard: (event: CalendarEvent) => ReactNode;
  /** Opens the task editor for a new task due on `dateKey`. */
  onAddTask: (dateKey: string) => void;
  router: AppHistoryRouter;
  route: AppRoute;
};

export default function UpcomingPage({
  tasks,
  calendarEvents,
  visibleBoards,
  boardMap,
  messagesBoardId,
  scrollElementRef,
  headerSlot,
  footerSlot,
  renderTaskCard,
  renderEventCard,
  onAddTask,
  router,
  route,
}: UpcomingPageProps) {
  const { sort, grouping, filter, usHolidaysEnabled, view: upcomingView } = useUpcomingPreferences();
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [upcomingListDate, setUpcomingListDate] = useState(() => formatDateKeyLocal(new Date()));
  useOverlayHistory(router, route, sortSheetOpen ? { kind: "sheet", sheet: "upcoming-sort" } : null, () => setSortSheetOpen(false));
  useOverlayHistory(router, route, filterOpen ? { kind: "sheet", sheet: "upcoming-filter" } : null, () => setFilterOpen(false));

  const upcomingListRef = useRef<HTMLDivElement | null>(null);
  const upcomingSearchInputRef = useRef<HTMLInputElement | null>(null);
  const upcomingAutoScrollRef = useRef(false);
  const upcomingPendingDetailDateRef = useRef<string | null>(null);
  const upcomingCalendarSwipeRef = useRef<{ startX: number; startY: number } | null>(null);

  // ---- What is shown ----
  const filterGroups = useMemo(() => upcomingFilterGroups(visibleBoards), [visibleBoards]);
  useEffect(() => {
    // A stored filter follows boards and lists being added, removed or renamed.
    const reconciled = reconcileUpcomingFilter(filter, filterGroups);
    if (reconciled !== filter) updateUpcomingPreferences({ filter: reconciled });
  }, [filter, filterGroups]);
  const filterLabel = useMemo(
    () => upcomingFilterLabel(filter, filterGroups, { enabled: usHolidaysEnabled, label: SPECIAL_CALENDAR_US_HOLIDAYS_LABEL }),
    [filter, filterGroups, usHolidaysEnabled],
  );
  const searchTerm = search.trim().toLowerCase();
  const showSearch = searchOpen || searchTerm.length > 0;

  const boardOrder = useMemo(() => upcomingBoardOrder(visibleBoards), [visibleBoards]);
  const sortOptions = useMemo(() => ({ sort, grouping, boardOrder }), [boardOrder, grouping, sort]);
  const holidayEvents = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return buildUsHolidayCalendarEvents(
      currentYear - SPECIAL_CALENDAR_US_HOLIDAY_RANGE_PAST_YEARS,
      currentYear + SPECIAL_CALENDAR_US_HOLIDAY_RANGE_FUTURE_YEARS,
    );
  }, []);
  const upcoming = useMemo(
    () => selectUpcomingTasks(tasks, { boardOrder, messagesBoardId }),
    [boardOrder, messagesBoardId, tasks],
  );
  const upcomingEvents = useMemo(
    () => selectUpcomingEvents(calendarEvents, { boardOrder, messagesBoardId, holidays: usHolidaysEnabled ? holidayEvents : null }),
    [boardOrder, calendarEvents, holidayEvents, messagesBoardId, usHolidaysEnabled],
  );
  const filterValue = useMemo<UpcomingFilter>(() => ({
    selection: filter,
    hasOptions: filterGroups.length > 0,
    map: upcomingFilterMap(upcomingFilterSelection(filter, filterGroups), filterGroups),
    boardMap,
    searchTerm,
  }), [boardMap, filter, filterGroups, searchTerm]);
  const filteredUpcoming = useMemo(() => filterUpcomingTasks(upcoming, filterValue), [filterValue, upcoming]);
  const filteredUpcomingEvents = useMemo(
    () => filterUpcomingEvents(upcomingEvents, filterValue, usHolidaysEnabled),
    [filterValue, upcomingEvents, usHolidaysEnabled],
  );
  const filteredUpcomingCount = filteredUpcoming.length + filteredUpcomingEvents.length;
  const upcomingDayMap = useMemo(
    () => groupUpcomingByDay(filteredUpcoming, filteredUpcomingEvents, sortOptions),
    [filteredUpcoming, filteredUpcomingEvents, sortOptions],
  );
  const upcomingGroups = useMemo(() => upcomingDayGroups(upcomingDayMap), [upcomingDayMap]);

  // ---- Search ----
  useEffect(() => {
    if (searchOpen) upcomingSearchInputRef.current?.focus();
  }, [searchOpen]);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    scrollElementRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => upcomingSearchInputRef.current?.focus());
  }, [scrollElementRef]);
  const closeSearch = useCallback(() => {
    setSearch("");
    setSearchOpen(false);
  }, []);

  // ---- Scrolling, the month calendar and view changes ----
  // ── Virtualized upcoming list (Item #11) ──────────────────────────────────
  // The grouped upcoming view is the only surface that grows linearly with
  // total task/event count across days, so it's the highest-leverage place to
  // virtualize. We flatten {group → [header, ...events, ...tasks]} into a
  // single row array (in `lib/upcomingRows.ts`, so the logic is unit-testable
  // independent of React/jsdom plumbing), then drive a `react-virtual` list
  // over it. Day headers are small (~32px), cards are variable (~120px
  // estimate, refined by ResizeObserver via `measureElement`). Scroll parent
  // is the existing `.app-content` container (`scrollElementRef`).
  const upcomingFlatRows = useMemo<UpcomingFlatRow[]>(
    () => flattenUpcomingGroups(upcomingGroups),
    [upcomingGroups],
  );

  // Map dateKey → flat-row index of that day's header. Used by
  // `scrollUpcomingToDate` to call `virtualizer.scrollToIndex(...)` when the
  // target day is offscreen (and therefore not in the rendered DOM subtree).
  const upcomingDateKeyToIndex = useMemo(
    () => buildUpcomingDateKeyIndex(upcomingFlatRows),
    [upcomingFlatRows],
  );

  const upcomingVirtualizer = useVirtualizer({
    count: upcomingFlatRows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: (index) => {
      const row = upcomingFlatRows[index];
      return row?.kind === "day-header" ? 32 : 120;
    },
    overscan: 8,
  });
  const {
    calendarAnchor: upcomingListAnchor,
    calendarMonthLabel: upcomingListMonthLabel,
    calendarCells: upcomingListCalendar,
    showMonthPicker: upcomingListMonthPickerOpen,
    moveCalendarMonth: moveUpcomingListMonth,
    handleMonthLabelClick: handleUpcomingListMonthLabelClick,
    monthPickerYears: upcomingListMonthPickerYears,
    monthPickerMonth: upcomingListMonthPickerMonth,
    monthPickerYear: upcomingListMonthPickerYear,
    monthPickerMonthColumnRef: upcomingListMonthPickerMonthColumnRef,
    monthPickerYearColumnRef: upcomingListMonthPickerYearColumnRef,
    handleMonthPickerMonthScroll: handleUpcomingListMonthPickerMonthScroll,
    handleMonthPickerYearScroll: handleUpcomingListMonthPickerYearScroll,
  } = useCalendarPicker(upcomingListDate);
  const upcomingListSelectedDate = useMemo(() => {
    const parsed = new Date(`${upcomingListDate}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [upcomingListDate]);
	  const upcomingListToday = useMemo(() => startOfDay(new Date()), []);
	  const upcomingListDayMap = upcomingDayMap;
	  const upcomingListEntry = useMemo(
	    () => upcomingListDayMap.get(upcomingListDate) ?? { tasks: [], events: [] },
	    [upcomingListDayMap, upcomingListDate],
	  );
	  const upcomingListEvents = upcomingListEntry.events;
	  const upcomingListTasks = upcomingListEntry.tasks;
	  const upcomingListDateRef = useRef(upcomingListDate);
  useEffect(() => {
    const prevDate = upcomingListDateRef.current;
    const dateChanged = prevDate !== upcomingListDate;
    upcomingListDateRef.current = upcomingListDate;
    if (upcomingView !== "list") return;
    if (dateChanged) return;
    const selected = new Date(`${upcomingListDate}T00:00:00`);
    if (Number.isNaN(selected.getTime())) return;
    if (
      selected.getFullYear() === upcomingListAnchor.getFullYear() &&
      selected.getMonth() === upcomingListAnchor.getMonth()
    ) {
      return;
    }
    const maxDay = daysInCalendarMonth(upcomingListAnchor.getFullYear(), upcomingListAnchor.getMonth());
    const next = new Date(
      upcomingListAnchor.getFullYear(),
      upcomingListAnchor.getMonth(),
      Math.min(selected.getDate(), maxDay),
    );
    setUpcomingListDate(formatDateKeyLocal(next));
  }, [upcomingListAnchor, upcomingListDate, upcomingView]);

  const resolveUpcomingTargetDateKey = useCallback((preferredDateKey: string) => {
    if (!upcomingGroups.length) return null;
    if (upcomingGroups.some((group) => group.dateKey === preferredDateKey)) {
      return preferredDateKey;
    }
    const nextGroup = upcomingGroups.find((group) => group.dateKey > preferredDateKey);
    if (nextGroup) return nextGroup.dateKey;
    return upcomingGroups[upcomingGroups.length - 1].dateKey;
  }, [upcomingGroups]);
  const scrollUpcomingToDate = useCallback((dateKey: string, behavior: ScrollBehavior = "smooth") => {
    const list = upcomingListRef.current;
    const scrollContainer = scrollElementRef.current;
    if (!list || !scrollContainer) return false;
    const targetKey = resolveUpcomingTargetDateKey(dateKey);
    if (!targetKey) return false;

    // Grouped view is virtualized: target day's header may be outside the
    // rendered DOM range, so `querySelector` would miss it. Use the
    // virtualizer's scrollToIndex with the precomputed dateKey→index map.
    const virtualIndex = upcomingDateKeyToIndex.get(targetKey);
    if (typeof virtualIndex === "number") {
      upcomingVirtualizer.scrollToIndex(virtualIndex, { align: "start", behavior });
      return true;
    }

    const selector = `[data-upcoming-date="${targetKey}"]`;
    const target = list.querySelector(selector) as HTMLElement | null;
    const fallback = list.firstElementChild as HTMLElement | null;
    const scrollTarget = target ?? fallback;
    if (!scrollTarget) return false;
    requestAnimationFrame(() => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const targetRect = scrollTarget.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top + scrollContainer.scrollTop;
      scrollContainer.scrollTo({ top: offset, behavior });
    });
    return true;
  }, [resolveUpcomingTargetDateKey, scrollElementRef, upcomingDateKeyToIndex, upcomingVirtualizer]);
  const scrollUpcomingToToday = useCallback((behavior: ScrollBehavior = "smooth") => {
    const todayKey = isoDatePart(new Date().toISOString());
    return scrollUpcomingToDate(todayKey, behavior);
  }, [scrollUpcomingToDate]);
  const getFocusedUpcomingDateFromScroll = useCallback(() => {
    const list = upcomingListRef.current;
    const scrollContainer = scrollElementRef.current;
    if (!list || !scrollContainer) return null;
    const groups = Array.from(list.querySelectorAll<HTMLElement>("[data-upcoming-date]"));
    if (!groups.length) return null;
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const firstVisible = groups.find((group) => group.getBoundingClientRect().bottom >= containerTop + 1);
    const focused = firstVisible ?? groups[groups.length - 1];
    const key = focused.getAttribute("data-upcoming-date");
    return key && key.trim() ? key : null;
  }, [scrollElementRef]);
  const handleUpcomingViewChange = useCallback((nextView: "details" | "list") => {
    if (nextView === upcomingView) return;
    if (nextView === "details") {
      upcomingPendingDetailDateRef.current = upcomingListDate;
      upcomingAutoScrollRef.current = false;
    } else {
      const focusedDate = getFocusedUpcomingDateFromScroll();
      if (focusedDate) {
        setUpcomingListDate(focusedDate);
      }
    }
    updateUpcomingPreferences({ view: nextView });
  }, [getFocusedUpcomingDateFromScroll, upcomingListDate, upcomingView]);
  const handleUpcomingCalendarTouchStart = useCallback((event: React.TouchEvent) => {
    if (upcomingListMonthPickerOpen) return;
    if (!event.touches.length) return;
    const touch = event.touches[0];
    upcomingCalendarSwipeRef.current = { startX: touch.clientX, startY: touch.clientY };
  }, [upcomingListMonthPickerOpen]);
  const handleUpcomingCalendarTouchEnd = useCallback((event: React.TouchEvent) => {
    if (upcomingListMonthPickerOpen) return;
    const swipe = upcomingCalendarSwipeRef.current;
    upcomingCalendarSwipeRef.current = null;
    if (!swipe) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - swipe.startX;
    const deltaY = touch.clientY - swipe.startY;
    if (Math.abs(deltaY) < 40 || Math.abs(deltaY) < Math.abs(deltaX)) return;
    moveUpcomingListMonth(deltaY < 0 ? 1 : -1);
  }, [moveUpcomingListMonth, upcomingListMonthPickerOpen]);
  const handleUpcomingListDaySelect = useCallback((day: number) => {
    const next = new Date(upcomingListCalendar.year, upcomingListCalendar.month, day);
    if (Number.isNaN(next.getTime())) return;
    setUpcomingListDate(formatDateKeyLocal(next));
  }, [upcomingListCalendar.month, upcomingListCalendar.year]);
  const handleUpcomingToday = useCallback(() => {
    if (upcomingView === "list") {
      const today = isoDatePart(new Date().toISOString());
      setUpcomingListDate(today);
      return;
    }
    scrollUpcomingToToday("smooth");
  }, [scrollUpcomingToToday, upcomingView]);

  // On arrival, details view shows the day the user was looking at, else today.
  useEffect(() => {
    if (upcomingView !== "details") return;
    if (upcomingAutoScrollRef.current) return;
    const targetDate = upcomingPendingDetailDateRef.current ?? upcomingListDate;
    upcomingPendingDetailDateRef.current = null;
    if ((targetDate && scrollUpcomingToDate(targetDate, "auto")) || scrollUpcomingToToday("auto")) {
      upcomingAutoScrollRef.current = true;
    }
  }, [scrollUpcomingToDate, scrollUpcomingToToday, upcomingListDate, upcomingView]);

  const headerActions = (
    <>
	                  <button
	                    type="button"
	                    className="app-header__icon-btn pressable"
	                    onClick={() => handleUpcomingViewChange(upcomingView === "list" ? "details" : "list")}
	                    title="Change upcoming view"
	                    aria-label="Change upcoming view"
	                    data-active={upcomingView === "list"}
	                  >
                    {upcomingView === "list" ? (
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
                        <rect x="4" y="5" width="16" height="15" rx="2" />
                        <path d="M8 3v4" />
                        <path d="M16 3v4" />
                        <path d="M4 11h16" />
                        <path d="M12 14v3l2 1" />
                      </svg>
                    ) : (
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
                        <line x1="5" y1="6" x2="21" y2="6" />
                        <line x1="5" y1="12" x2="21" y2="12" />
                        <line x1="5" y1="18" x2="21" y2="18" />
                        <circle cx="3" cy="6" r="1" />
                        <circle cx="3" cy="12" r="1" />
                        <circle cx="3" cy="18" r="1" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="app-header__icon-btn pressable"
                    onClick={() => setSortSheetOpen(true)}
                    title="Sort upcoming tasks"
                    aria-label="Sort upcoming tasks"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="8" y1="17" x2="8" y2="7" />
                      <polyline points="5 10 8 7 11 10" />
                      <line x1="16" y1="7" x2="16" y2="17" />
                      <polyline points="13 14 16 17 19 14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="app-header__icon-btn pressable"
                    onClick={openSearch}
                    title="Search upcoming tasks"
                    aria-label="Search upcoming tasks"
                    data-active={showSearch}
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
                      <circle cx="11" cy="11" r="7" />
                      <line x1="16.65" y1="16.65" x2="21" y2="21" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="app-header__icon-btn app-header__icon-btn--accent pressable"
                    onClick={() => onAddTask(upcomingListDate)}
                    title="Add task"
                    aria-label="Add task"
                  >
                    <span aria-hidden="true">+</span>
                  </button>
    </>
  );

  return (
    <>
      {headerSlot && createPortal(headerActions, headerSlot)}
          {showSearch && (
            <UpcomingSearch
              inputRef={upcomingSearchInputRef}
              value={search}
              onChange={setSearch}
              onClose={closeSearch}
            />
          )}
          {upcomingView === "list" ? (
            <div className="upcoming-list-view">
              <div className="surface-panel upcoming-list-view__calendar">
                <div className="upcoming-calendar">
                  <div className="upcoming-calendar__header">
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={() => moveUpcomingListMonth(-1)}
                      aria-label="Previous month"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="upcoming-calendar__title upcoming-calendar__title-button"
                      onClick={handleUpcomingListMonthLabelClick}
                      onTouchStart={(event) => {
                        event.preventDefault();
                        handleUpcomingListMonthLabelClick();
                      }}
                      aria-label="Select month and year"
                      aria-expanded={upcomingListMonthPickerOpen}
                    >
                      {upcomingListMonthLabel}
                    </button>
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={() => moveUpcomingListMonth(1)}
                      aria-label="Next month"
                    >
                      ›
                    </button>
                  </div>
                  {upcomingListMonthPickerOpen && (
                    <div className="edit-month-picker">
                      <div
                        className="edit-month-picker__column"
                        ref={upcomingListMonthPickerMonthColumnRef}
                        onScroll={handleUpcomingListMonthPickerMonthScroll}
                        role="listbox"
                        aria-label="Select month"
                      >
                        {MONTH_NAMES.map((name, idx) => (
                          <div
                            key={name}
                            className={`edit-month-picker__option ${upcomingListMonthPickerMonth === idx ? "is-active" : ""}`}
                            data-picker-index={idx}
                            role="option"
                            aria-selected={upcomingListMonthPickerMonth === idx}
                          >
                            {name.slice(0, 3)}
                          </div>
                        ))}
                      </div>
                      <div
                        className="edit-month-picker__column"
                        ref={upcomingListMonthPickerYearColumnRef}
                        onScroll={handleUpcomingListMonthPickerYearScroll}
                        role="listbox"
                        aria-label="Select year"
                      >
                        {upcomingListMonthPickerYears.map((year, idx) => (
                          <div
                            key={year}
                            className={`edit-month-picker__option ${upcomingListMonthPickerYear === year ? "is-active" : ""}`}
                            data-picker-index={idx}
                            role="option"
                            aria-selected={upcomingListMonthPickerYear === year}
                          >
                            {year}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="upcoming-calendar__weekdays">
                    {WD_SHORT.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                  <div
                    className="upcoming-calendar__grid"
                    onTouchStart={handleUpcomingCalendarTouchStart}
                    onTouchEnd={handleUpcomingCalendarTouchEnd}
                  >
                    {upcomingListCalendar.cells.map((cell, idx) => {
                      if (!cell) {
                        return (
                          <span
                            key={`empty-${idx}`}
                            className="upcoming-calendar__day upcoming-calendar__day--muted"
                          />
	                      );
	                    }
	                    const currentViewDate = new Date(
	                      upcomingListCalendar.year,
	                      upcomingListCalendar.month,
	                      cell,
	                    );
	                    const dateKey = isoDatePart(currentViewDate.toISOString());
	                    const hasItems = upcomingListDayMap.has(dateKey);
	                    const isSelected =
	                      !!upcomingListSelectedDate &&
	                      upcomingListSelectedDate.getFullYear() === upcomingListCalendar.year &&
	                      upcomingListSelectedDate.getMonth() === upcomingListCalendar.month &&
                        upcomingListSelectedDate.getDate() === cell;
                      const isToday =
                        !isSelected &&
                        upcomingListToday.getFullYear() === currentViewDate.getFullYear() &&
                        upcomingListToday.getMonth() === currentViewDate.getMonth() &&
                        upcomingListToday.getDate() === currentViewDate.getDate();
	                    const dayCls = [
	                      "upcoming-calendar__day",
	                      hasItems ? "upcoming-calendar__day--has-dot" : "",
	                      isSelected ? "upcoming-calendar__day--selected" : "",
	                      isToday ? "upcoming-calendar__day--today" : "",
	                    ]
	                      .filter(Boolean)
                        .join(" ");
                      return (
                        <button
                          key={`day-${idx}-${cell}`}
                          type="button"
                          className={dayCls}
                          onClick={() => handleUpcomingListDaySelect(cell)}
                        >
                          <span className="upcoming-calendar__day-number">{cell}</span>
                          <span className="upcoming-calendar__dot" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </div>
	            </div>
	            <div className="upcoming-list-view__tasks">
	              {upcomingListTasks.length + upcomingListEvents.length === 0 ? (
	                <div className="text-sm text-secondary">
	                  {filteredUpcomingCount === 0 ? "No upcoming items." : "No items scheduled for this day."}
	                </div>
	              ) : (
	                <div className="space-y-2">
	                  {upcomingListEvents.map((ev) => renderEventCard(ev))}
	                  {upcomingListTasks.map((task) => renderTaskCard(task))}
	                </div>
	              )}
	            </div>
	          </div>
	        ) : filteredUpcomingCount === 0 ? (
	          <div className="surface-panel p-6 text-center text-sm text-secondary">No upcoming items.</div>
	        ) : (
	          // Virtualized grouped upcoming list (Item #11). Total height set
	          // by virtualizer; rows are absolutely positioned via translateY
	          // so only ~visible items live in the DOM. `data-upcoming-date`
	          // attributes on rendered headers preserve the existing
	          // `getFocusedUpcomingDateFromScroll` lookup for the visible
	          // viewport; offscreen days are reachable via
	          // `scrollUpcomingToDate` which routes through
	          // `virtualizer.scrollToIndex`.
	          <div
	            className="upcoming-list"
	            ref={upcomingListRef}
	            style={{ height: upcomingVirtualizer.getTotalSize(), position: "relative", width: "100%" }}
	          >
	            {upcomingVirtualizer.getVirtualItems().map((virtualRow) => {
	              const row = upcomingFlatRows[virtualRow.index];
	              if (!row) return null;
	              const key =
	                row.kind === "day-header"
	                  ? `header-${row.dateKey}`
	                  : row.kind === "event"
	                  ? `event-${row.event.id}`
	                  : `task-${row.task.id}`;
	              return (
	                <div
	                  key={key}
	                  ref={upcomingVirtualizer.measureElement}
	                  data-index={virtualRow.index}
	                  data-upcoming-date={row.kind === "day-header" ? row.dateKey : undefined}
	                  style={{
	                    position: "absolute",
	                    top: 0,
	                    left: 0,
	                    width: "100%",
	                    transform: `translateY(${virtualRow.start}px)`,
	                  }}
	                >
	                  {row.kind === "day-header" ? (
	                    <div className="upcoming-day__label">{row.label}</div>
	                  ) : row.kind === "event" ? (
	                    renderEventCard(row.event)
	                  ) : (
	                    renderTaskCard(row.task)
	                  )}
	                </div>
	              );
	            })}
	          </div>
	        )}
      {footerSlot && createPortal(
        <UpcomingControls
          todayDisabled={upcomingView === "details" && upcomingGroups.length === 0}
          onTodayClick={handleUpcomingToday}
          filterActive={filter !== null || filterOpen}
          filterLabel={filterLabel}
          onOpenFilter={() => setFilterOpen(true)}
        />,
        footerSlot,
      )}
      <UpcomingSheets
        sortOpen={sortSheetOpen}
        onCloseSort={() => setSortSheetOpen(false)}
        filterOpen={filterOpen}
        onCloseFilter={() => setFilterOpen(false)}
        filterGroups={filterGroups}
      />
    </>
  );
}
