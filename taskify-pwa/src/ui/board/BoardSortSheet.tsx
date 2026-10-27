import { ActionSheet } from "../../components/ActionSheet";
import type { TaskSort } from "../../domains/tasks/taskSort";
import type { BoardSortMode } from "../../domains/tasks/taskUtils";
import { SortModeButtons } from "../sort/SortModeButtons";

export function BoardSortSheet({
  open,
  sort,
  onSelect,
  onClose,
}: {
  open: boolean;
  sort: TaskSort;
  onSelect: (mode: BoardSortMode) => void;
  onClose: () => void;
}) {
  return (
    <ActionSheet open={open} onClose={onClose} title="Filter and sort">
      <div className="wallet-section space-y-3 text-sm">
        <div className="text-xs uppercase tracking-wide text-secondary">Sort tasks by</div>
        <SortModeButtons sort={sort} onSelect={onSelect} />
      </div>
    </ActionSheet>
  );
}
