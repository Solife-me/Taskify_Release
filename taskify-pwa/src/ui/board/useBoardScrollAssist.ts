import { useCallback, useEffect, useState, type RefObject } from "react";

/** Mouse and trackpad desktops; touch screens scroll sideways natively. */
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const PAN_THRESHOLD_PX = 4;
/** Elements a press starts something on (editing, dragging a card), so it must not pan. */
const INTERACTIVE = 'button, a, input, textarea, select, label, form, [draggable], [contenteditable="true"]';

/** Whether a vertical wheel over `target` belongs to a list that scrolls, not to the board. */
function insideScrollingList(target: EventTarget | null, board: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== board; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return true;
  }
  return false;
}

function wheelPixels(event: WheelEvent, page: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 40;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * page;
  return event.deltaY;
}

/**
 * Sideways scrolling for a board with an ordinary mouse, which has no sideways wheel:
 * - the wheel scrolls the board sideways, except over a list long enough to scroll itself;
 * - dragging empty board space pans it;
 * - `edges` says whether lists are hidden off either side, for the edge buttons.
 * Touch screens and trackpad sideways swipes are left alone.
 */
export function useBoardScrollAssist(boardRef: RefObject<HTMLElement | null>, layoutKey: unknown) {
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const board = boardRef.current;
    if (!board || typeof window === "undefined") return;
    const finePointer = window.matchMedia(FINE_POINTER);

    const updateEdges = () => {
      const left = board.scrollLeft > 2;
      const right = board.scrollLeft + board.clientWidth < board.scrollWidth - 2;
      setEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
    };

    const onWheel = (event: WheelEvent) => {
      if (!finePointer.matches || event.ctrlKey || event.defaultPrevented) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (board.scrollWidth <= board.clientWidth + 1) return;
      if (insideScrollingList(event.target, board)) return;
      board.scrollLeft += wheelPixels(event, board.clientWidth);
      event.preventDefault();
    };

    let pan: { pointerId: number; startX: number; startScroll: number; active: boolean } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (!finePointer.matches || event.pointerType !== "mouse" || event.button !== 0) return;
      if (board.scrollWidth <= board.clientWidth + 1) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
      pan = { pointerId: event.pointerId, startX: event.clientX, startScroll: board.scrollLeft, active: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      const dx = event.clientX - pan.startX;
      if (!pan.active) {
        if (Math.abs(dx) < PAN_THRESHOLD_PX) return;
        pan.active = true;
        board.setPointerCapture(event.pointerId);
        board.dataset.panning = "true";
      }
      board.scrollLeft = pan.startScroll - dx;
      event.preventDefault();
    };
    const endPan = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      if (pan.active && board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
      delete board.dataset.panning;
      pan = null;
    };

    updateEdges();
    const resize = new ResizeObserver(updateEdges);
    resize.observe(board);
    if (board.firstElementChild) resize.observe(board.firstElementChild);
    board.addEventListener("scroll", updateEdges, { passive: true });
    board.addEventListener("wheel", onWheel, { passive: false });
    board.addEventListener("pointerdown", onPointerDown);
    board.addEventListener("pointermove", onPointerMove);
    board.addEventListener("pointerup", endPan);
    board.addEventListener("pointercancel", endPan);
    return () => {
      resize.disconnect();
      board.removeEventListener("scroll", updateEdges);
      board.removeEventListener("wheel", onWheel);
      board.removeEventListener("pointerdown", onPointerDown);
      board.removeEventListener("pointermove", onPointerMove);
      board.removeEventListener("pointerup", endPan);
      board.removeEventListener("pointercancel", endPan);
      delete board.dataset.panning;
    };
  }, [boardRef, layoutKey]);

  /** Moves most of a screen's width, so one list stays in view for context. */
  const scrollByPage = useCallback((direction: -1 | 1) => {
    const board = boardRef.current;
    if (board) board.scrollBy({ left: direction * board.clientWidth * 0.8, behavior: "smooth" });
  }, [boardRef]);

  return { edges, scrollByPage };
}
