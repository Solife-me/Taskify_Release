import React, { useCallback, useEffect, useRef, useState } from "react";
import { getDraggedTaskId, getDraggedTaskIds } from "../task/Card";

/* ================= DroppableColumn ================= */
export const DroppableColumn = React.memo(React.forwardRef<HTMLDivElement, {
  title: string;
  header?: React.ReactNode;
  onDropCard: (payload: { id: string; beforeId?: string; allIds?: string[] }) => void;
  onDropEnd?: () => void;
  onTitleClick?: () => void;
  onSelectAll?: () => void;
  selectionState?: "none" | "some" | "all";
  children: React.ReactNode;
  footer?: React.ReactNode;
  scrollable?: boolean;
} & React.HTMLAttributes<HTMLDivElement>>((
  {
    title,
    header,
    onDropCard,
    onDropEnd,
    onTitleClick,
    onSelectAll,
    selectionState,
    children,
    footer,
    scrollable,
    className,
    ...props
  },
  forwardedRef
) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const setRef = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [forwardedRef]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const isTaskDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).some((type) => type === "text/task-id" || type === "text/plain");
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const id = getDraggedTaskId(e.dataTransfer);
      if (id) {
        let beforeId: string | undefined;
        const columnEl = innerRef.current;
        if (columnEl) {
          const cards = Array.from(
            columnEl.querySelectorAll<HTMLElement>("[data-task-id]")
          );
          const pointerY = e.clientY;
          for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (pointerY < rect.top + rect.height / 2) {
              beforeId = card.dataset.taskId || undefined;
              break;
            }
          }
        }
        const allIds = getDraggedTaskIds(e.dataTransfer) ?? undefined;
        onDropCard({ id, beforeId, allIds });
      }
      if (onDropEnd) onDropEnd();
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    const onDragEnter = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragOver(false);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragleave", onDragLeave);
    const resetDragState = () => {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    document.addEventListener("dragend", resetDragState);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragend", resetDragState);
    };
  }, [onDropCard, onDropEnd]);

  return (
    <div
      ref={setRef}
      data-column-title={title}
      data-drop-over={isDragOver || undefined}
      className={`board-column surface-panel w-[325px] shrink-0 ${scrollable ? 'flex h-full min-h-0 flex-col overflow-hidden pt-2 px-2 pb-1' : 'min-h-[320px] p-2'} ${isDragOver ? 'board-column--active' : ''} ${className ?? ''}`}
      {...props}
    >
      {header ?? (
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {selectionState && onSelectAll && (
              <button
                type="button"
                role="checkbox"
                aria-checked={selectionState === "all"}
                aria-label={selectionState === "all" ? `Deselect all in ${title}` : `Select all in ${title}`}
                onClick={(e) => { e.stopPropagation(); onSelectAll(); }}
                className="flex items-center justify-center shrink-0"
                title={selectionState === "all" ? "Deselect all in list" : "Select all in list"}
              >
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${selectionState === "all" ? "bg-[var(--accent)] border-[var(--accent)]" : "border-[var(--secondary)]"}`}>
                  {selectionState === "all" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : selectionState === "some" ? (
                    <div className="w-2 h-2 rounded-full bg-[var(--secondary)]" />
                  ) : null}
                </div>
              </button>
            )}
            <div
              className={`text-sm font-semibold tracking-wide text-secondary truncate ${onTitleClick ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
              onClick={onTitleClick}
              role={onTitleClick ? 'button' : undefined}
              tabIndex={onTitleClick ? 0 : undefined}
              aria-label={onTitleClick ? `Set ${title} as add target` : undefined}
              onKeyDown={(e) => {
                if (!onTitleClick) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTitleClick();
                }
              }}
              title={onTitleClick ? 'Set as add target' : undefined}
            >
              {title}
            </div>
          </div>
          <button
            type="button"
            className="p-1 text-secondary hover:text-primary rounded shrink-0"
            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('toggleSelectionMode')); }}
            title="Select tasks">
            <svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 12a2 2 0 11-4 0 2 2 0 014 0zm8 0a2 2 0 11-4 0 2 2 0 014 0zm8 0a2 2 0 11-4 0 2 2 0 014 0z" fill="currentColor"/></svg>
          </button>
        </div>
      )}
      <div className={scrollable ? 'flex-1 min-h-0 overflow-y-auto pr-1' : ''} data-column-scroll={scrollable ? "" : undefined}>
        <div className="space-y-.25">{children}</div>
      </div>
      {scrollable && footer ? <div className="mt-auto flex-shrink-0 pt-2">{footer}</div> : null}
      {!scrollable && footer}
    </div>
  );
}));
