import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  isListLikeBoard,
  type Board,
  type ListColumn,
  type Weekday,
} from "taskify-core";
import { nudgeHorizontalScroller } from "../../domains/dateTime/dateUtils";

type DayChoice = Weekday | string;
type BoardView = "board" | "completed" | "board-upcoming" | "bible";
type ListColumnSourceMap = Map<string, { boardId: string; columnId: string; boardName: string }>;

type UseBoardViewScrollStateParams = {
  activePage: string;
  boards: Board[];
  currentBoard: Board | undefined;
  currentBoardId: string;
  listColumns: ListColumn[];
  listColumnSources: ListColumnSourceMap;
  view: BoardView;
};

export function useBoardViewScrollState({
  activePage,
  boards,
  currentBoard,
  currentBoardId,
  listColumns,
  listColumnSources,
  view,
}: UseBoardViewScrollStateParams) {
  const [dayChoice, setDayChoiceRaw] = useState<DayChoice>(() => {
    const firstBoard = boards.find((board) => !board.archived) ?? boards[0];
    if (firstBoard?.kind === "lists") {
      return firstBoard.columns[0]?.id || "items";
    }
    return new Date().getDay() as Weekday;
  });
  const dayChoiceRef = useRef<DayChoice>(dayChoice);
  const setDayChoice = useCallback((next: DayChoice) => {
    dayChoiceRef.current = next;
    setDayChoiceRaw(next);
  }, []);
  const lastListViewRef = useRef<Map<string, string>>(new Map());
  const lastBoardScrollRef = useRef<Map<string, number>>(new Map());
  const autoCenteredIndexRef = useRef<Set<string>>(new Set());
  const autoCenteredWeekRef = useRef<Set<string>>(new Set());
  const activeWeekBoardRef = useRef<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bibleScrollerRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());

  const setColumnRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) columnRefs.current.set(key, el);
    else columnRefs.current.delete(key);
  }, []);
  const getColumnElement = useCallback((key: string) => columnRefs.current.get(key) || null, []);

  const scrollColumnIntoView = useCallback((key: string, behavior: ScrollBehavior = "smooth") => {
    const scroller = scrollerRef.current;
    const column = columnRefs.current.get(key);
    if (!scroller || !column) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const offset =
      scroller.scrollLeft +
      (columnRect.left - scrollerRect.left) -
      scroller.clientWidth / 2 +
      column.clientWidth / 2;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const target = Math.min(Math.max(offset, 0), maxScroll);
    scroller.scrollTo({ left: target, behavior });
  }, []);

  useEffect(() => {
    const autoCenteredSet = autoCenteredWeekRef.current;
    const prevActive = activeWeekBoardRef.current;

    if (activePage !== "boards" || view !== "board") {
      if (prevActive) {
        autoCenteredSet.delete(prevActive);
        activeWeekBoardRef.current = null;
      }
      return;
    }

    if (!currentBoardId || currentBoard?.kind !== "week") {
      if (prevActive) {
        autoCenteredSet.delete(prevActive);
        activeWeekBoardRef.current = null;
      }
      return;
    }

    if (prevActive && prevActive !== currentBoardId) {
      autoCenteredSet.delete(prevActive);
    }

    activeWeekBoardRef.current = currentBoardId;
  }, [activePage, currentBoardId, currentBoard?.kind, view]);

  useEffect(() => {
    if (!currentBoard || view !== "board" || activePage !== "boards") return;
    if (currentBoard.kind === "bible") {
      return;
    }
    if (isListLikeBoard(currentBoard)) {
      const valid = typeof dayChoice === "string" && listColumnSources.has(dayChoice);
      if (valid) {
        lastListViewRef.current.set(currentBoard.id, dayChoice);
        return;
      }

      const stored = lastListViewRef.current.get(currentBoard.id);
      const storedValid = stored ? listColumnSources.has(stored) : false;
      const nextChoice =
        (storedValid && stored) ||
        listColumns[0]?.id ||
        (typeof dayChoice === "string" ? dayChoice : undefined);

      if (nextChoice && nextChoice !== dayChoice) {
        setDayChoice(nextChoice);
        lastListViewRef.current.set(currentBoard.id, nextChoice);
      }
    } else {
      const today = new Date().getDay() as Weekday;
      const boardId = currentBoard.id;
      const autoCenteredSet = autoCenteredWeekRef.current;
      const hasCentered = autoCenteredSet.has(boardId);
      const isValidDayChoice = typeof dayChoice === "number" && dayChoice >= 0 && dayChoice <= 6;

      if ((!hasCentered || !isValidDayChoice) && dayChoice !== today) {
        setDayChoice(today);
      }

      if (!hasCentered) {
        requestAnimationFrame(() => {
          const scroller = scrollerRef.current;
          if (!scroller) return;
          const el = scroller.querySelector(`[data-day='${today}']`) as HTMLElement | null;
          if (!el) return;
          const offset = el.offsetLeft - scroller.clientWidth / 2 + el.clientWidth / 2;
          scroller.scrollTo({ left: offset, behavior: "smooth" });
          autoCenteredSet.add(boardId);
        });
      }
    }
  }, [activePage, currentBoardId, currentBoard?.id, currentBoard?.kind, dayChoice, listColumnSources, listColumns, setDayChoice, view]);

  useEffect(() => {
    const board = currentBoard;
    if (view !== "board") return;
    if (!isListLikeBoard(board)) return;
    if (typeof dayChoice !== "string") return;
    if (!listColumnSources.has(dayChoice)) return;
    const prev = lastListViewRef.current.get(board.id);
    if (prev !== dayChoice) {
      lastListViewRef.current.set(board.id, dayChoice);
    }
  }, [currentBoard, dayChoice, listColumnSources, view]);

  useLayoutEffect(() => {
    const board = currentBoard;
    if (view !== "board") return;
    if (!isListLikeBoard(board)) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const boardId = board.id;
    const scrollStore = lastBoardScrollRef.current;
    const stored = scrollStore.has(boardId) ? scrollStore.get(boardId)! : null;
    const shouldCenterIndex = !!board.indexCardEnabled;
    const autoCenteredIndexSet = autoCenteredIndexRef.current;

    const applyInitialScroll = () => {
      const latest = scrollerRef.current;
      if (!latest) return;
      const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
      if (shouldCenterIndex && !autoCenteredIndexSet.has(boardId)) {
        scrollColumnIntoView("list-index", "auto");
        autoCenteredIndexSet.add(boardId);
        requestAnimationFrame(() => {
          const latestScroller = scrollerRef.current;
          if (!latestScroller) return;
          const maxScroll = Math.max(0, latestScroller.scrollWidth - latestScroller.clientWidth);
          const clamped = Math.min(Math.max(latestScroller.scrollLeft, 0), maxScroll);
          scrollStore.set(boardId, clamped);
        });
        nudgeHorizontalScroller(latest);
        return;
      }
      const target = stored == null ? 0 : Math.min(Math.max(stored, 0), maxScroll);
      if (Math.abs(latest.scrollLeft - target) > 1) {
        latest.scrollTo({ left: target, behavior: "auto" });
      } else {
        latest.scrollLeft = target;
      }
      nudgeHorizontalScroller(latest);
    };

    applyInitialScroll();
    const raf = requestAnimationFrame(applyInitialScroll);
    let timeout: number | undefined;
    if (typeof window !== "undefined") {
      timeout = window.setTimeout(applyInitialScroll, 150);
    }
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        applyInitialScroll();
      });
      resizeObserver.observe(scroller);
    }

    const handleScroll = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (typeof timeout === "number") {
        window.clearTimeout(timeout);
      }
      resizeObserver?.disconnect();
      cancelAnimationFrame(raf);
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
      if (!board.indexCardEnabled) {
        autoCenteredIndexSet.delete(boardId);
      }
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [currentBoard, scrollColumnIntoView, view]);

  useLayoutEffect(() => {
    if (currentBoard?.kind !== "bible") return;
    if (view === "completed") return;
    const scroller = bibleScrollerRef.current;
    if (!scroller) return;

    const boardId = currentBoard.id;
    const scrollStore = lastBoardScrollRef.current;
    const stored = scrollStore.get(boardId) ?? 0;

    const applyStoredScroll = () => {
      const latest = bibleScrollerRef.current;
      if (!latest) return;
      const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
      const target = Math.min(Math.max(stored, 0), maxScroll);
      if (Math.abs(latest.scrollLeft - target) > 1) {
        latest.scrollTo({ left: target, behavior: "auto" });
      } else {
        latest.scrollLeft = target;
      }
    };

    applyStoredScroll();
    const raf = requestAnimationFrame(applyStoredScroll);
    let timeout: number | undefined;
    if (typeof window !== "undefined") {
      timeout = window.setTimeout(applyStoredScroll, 150);
    }

    const handleScroll = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (typeof timeout === "number") {
        window.clearTimeout(timeout);
      }
      cancelAnimationFrame(raf);
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [currentBoard?.id, currentBoard?.kind, view]);

  return {
    bibleScrollerRef,
    dayChoice,
    dayChoiceRef,
    getColumnElement,
    scrollerRef,
    scrollColumnIntoView,
    setColumnRef,
    setDayChoice,
  };
}
