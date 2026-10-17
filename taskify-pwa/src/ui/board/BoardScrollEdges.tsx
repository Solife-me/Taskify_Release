import type { RefObject } from "react";
import { useBoardScrollAssist } from "./useBoardScrollAssist";

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

/**
 * Mouse-friendly sideways scrolling for a board (see `useBoardScrollAssist`), with buttons at
 * the edges while lists are hidden off that side. The buttons only show on desktop (CSS).
 */
export function BoardScrollEdges({ boardRef, layoutKey }: { boardRef: RefObject<HTMLElement | null>; layoutKey: unknown }) {
  const { edges, scrollByPage } = useBoardScrollAssist(boardRef, layoutKey);
  return (
    <>
      {edges.left && (
        <button type="button" className="board-scroll-edge board-scroll-edge--left pressable" onClick={() => scrollByPage(-1)} aria-label="Scroll board left" title="Scroll left">
          <Chevron direction="left" />
        </button>
      )}
      {edges.right && (
        <button type="button" className="board-scroll-edge board-scroll-edge--right pressable" onClick={() => scrollByPage(1)} aria-label="Scroll board right" title="Scroll right">
          <Chevron direction="right" />
        </button>
      )}
    </>
  );
}
