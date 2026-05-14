// Drag-to-delete trash zone — extracted from App.tsx (Item #10).
//
// Floating bottom-left bubble that's only rendered while a drag is in
// progress (`draggingTaskId || draggingEventId`). Drops route to:
//   - Multi-task delete (when bulk-selected): delete every id in
//     `getDraggedTaskIds` without confirmation
//   - Single task: confirmation-prompted `deleteTask`
//   - Single event: `deleteCalendarEvent`

import type { ReactNode } from "react";
import { getDraggedTaskId, getDraggedTaskIds } from "../task/Card";
import { getDraggedEventId } from "../calendar/EventCard";

export type TrashDropZoneProps = {
  visible: boolean;
  hovered: boolean;
  setHovered: (next: boolean) => void;
  onDragEnd: () => void;
  deleteTask: (id: string, opts?: { skipPrompt?: boolean }) => void;
  deleteCalendarEvent: (id: string) => void;
  isSelectionMode: boolean;
  exitSelectionMode: () => void;
};

export function TrashDropZone({
  visible,
  hovered,
  setHovered,
  onDragEnd,
  deleteTask,
  deleteCalendarEvent,
  isSelectionMode,
  exitSelectionMode,
}: TrashDropZoneProps): ReactNode {
  if (!visible) return null;
  return (
    <div
      className="fixed bottom-4 left-4 z-50"
      onDragOver={(e) => {
        e.preventDefault();
        setHovered(true);
      }}
      onDragLeave={() => setHovered(false)}
      onDrop={(e) => {
        e.preventDefault();
        const allIds = getDraggedTaskIds(e.dataTransfer);
        if (allIds && allIds.length > 1) {
          allIds.forEach((id) => deleteTask(id, { skipPrompt: true }));
          if (isSelectionMode) exitSelectionMode();
        } else {
          const taskId = getDraggedTaskId(e.dataTransfer);
          if (taskId) {
            deleteTask(taskId);
          } else {
            const eventId = getDraggedEventId(e.dataTransfer);
            if (eventId) deleteCalendarEvent(eventId);
          }
        }
        onDragEnd();
      }}
    >
      <div
        className={`w-14 h-14 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-secondary transition-transform ${hovered ? "scale-110" : ""}`}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="pointer-events-none"
        >
          <path d="M9 3h6l1 1h5v2H3V4h5l1-1z" />
          <path d="M5 7h14l-1.5 13h-11L5 7z" />
        </svg>
      </div>
    </div>
  );
}
