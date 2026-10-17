import type { TaskSort } from "../../domains/tasks/taskSort";
import type { BoardSortDirection, BoardSortMode } from "../../domains/tasks/taskUtils";

export const TASK_SORT_OPTIONS: readonly { id: BoardSortMode; label: string; supportsDirection: boolean }[] = [
  { id: "manual", label: "Manual", supportsDirection: false },
  { id: "due", label: "Due Date", supportsDirection: true },
  { id: "priority", label: "Priority", supportsDirection: true },
  { id: "created", label: "Creation Date", supportsDirection: true },
  { id: "alpha", label: "A-Z", supportsDirection: true },
];

/** Due date and A-Z read "ascending" as earliest/first, so their arrow points down the list. */
function sortArrow(mode: BoardSortMode, direction: BoardSortDirection): string {
  const invert = mode === "due" || mode === "alpha";
  return (direction === "asc") !== invert ? "↑" : "↓";
}

export function SortModeButtons({ sort, onSelect }: { sort: TaskSort; onSelect: (mode: BoardSortMode) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {TASK_SORT_OPTIONS.map((option) => {
        const active = sort.mode === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className={active ? "accent-button button-sm pressable" : "ghost-button button-sm pressable"}
            onClick={() => onSelect(option.id)}
            aria-pressed={active}
          >
            <span>{option.label}</span>
            {active && option.supportsDirection && <span className="ml-1 text-xs">{sortArrow(option.id, sort.direction)}</span>}
          </button>
        );
      })}
    </div>
  );
}
