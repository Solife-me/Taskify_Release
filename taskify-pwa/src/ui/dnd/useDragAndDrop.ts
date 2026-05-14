// Drag-and-drop UI state, extracted from App.tsx (Item #10, next pass after
// `@ts-nocheck` removal).
//
// Owns the full coordinated state for a single drag interaction across the
// app: what's being dragged (a task or an event), which drop zones are
// currently being hovered (the trash bin, the upcoming-zone, the board-
// switcher dropdown), and the two debounce timers for opening/closing the
// board-switcher dropdown when the user pauses a drag over the board pill.
//
// `handleDragEnd` resets everything atomically — call it from every
// `onDragEnd` handler in the JSX so a successful drop OR a cancelled drag
// both leave the UI in a clean state.

import { useCallback, useRef, useState } from "react";

export type BoardDropPos = { top: number; left: number };

export function useDragAndDrop() {
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [upcomingHover, setUpcomingHover] = useState(false);
  const [boardDropOpen, setBoardDropOpen] = useState(false);
  const [boardDropPos, setBoardDropPos] = useState<BoardDropPos | null>(null);
  const boardDropTimer = useRef<number | undefined>(undefined);
  const boardDropCloseTimer = useRef<number | undefined>(undefined);

  const scheduleBoardDropClose = useCallback(() => {
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
    boardDropCloseTimer.current = window.setTimeout(() => {
      setBoardDropOpen(false);
      setBoardDropPos(null);
      boardDropCloseTimer.current = undefined;
    }, 100);
  }, []);

  const cancelBoardDropClose = useCallback(() => {
    if (boardDropCloseTimer.current) {
      window.clearTimeout(boardDropCloseTimer.current);
      boardDropCloseTimer.current = undefined;
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDraggingEventId(null);
    setTrashHover(false);
    setUpcomingHover(false);
    setBoardDropOpen(false);
    setBoardDropPos(null);
    if (boardDropTimer.current) {
      window.clearTimeout(boardDropTimer.current);
      boardDropTimer.current = undefined;
    }
    if (boardDropCloseTimer.current) {
      window.clearTimeout(boardDropCloseTimer.current);
      boardDropCloseTimer.current = undefined;
    }
  }, []);

  return {
    // State
    draggingTaskId,
    draggingEventId,
    trashHover,
    upcomingHover,
    boardDropOpen,
    boardDropPos,
    // Timer refs (exposed because some drop-zone handlers schedule/cancel
    // them inline; e.g., the board-pill `onDragOver` opens the dropdown after
    // a 500ms hover).
    boardDropTimer,
    boardDropCloseTimer,
    // Setters
    setDraggingTaskId,
    setDraggingEventId,
    setTrashHover,
    setUpcomingHover,
    setBoardDropOpen,
    setBoardDropPos,
    // Handlers
    handleDragEnd,
    scheduleBoardDropClose,
    cancelBoardDropClose,
  };
}
