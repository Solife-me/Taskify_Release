import { useCallback, useEffect, useState } from "react";
import type { TaskSort } from "../../domains/tasks/taskSort";
import { DEFAULT_BOARD_SORT_DIRECTION, normalizeBoardSortState, type BoardSortMode } from "../../domains/tasks/taskUtils";
import { nextSortForMode } from "../../domains/upcoming/upcomingPreferences";
import { kvStorage } from "../../storage/kvStorage";

const LS_BOARD_SORT = "taskify_board_sort_v1";

function readBoardSort(): TaskSort {
  const fallback: TaskSort = { mode: "due", direction: DEFAULT_BOARD_SORT_DIRECTION.due };
  try {
    return normalizeBoardSortState(JSON.parse(kvStorage.getItem(LS_BOARD_SORT) || "null")) ?? fallback;
  } catch {
    return fallback;
  }
}

/** How boards sort their tasks on this device, and the sheet that changes it. */
export function useBoardSort() {
  const [boardSort, setBoardSort] = useState<TaskSort>(readBoardSort);
  const [boardSortSheetOpen, setBoardSortSheetOpen] = useState(false);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_BOARD_SORT, JSON.stringify(boardSort));
    } catch {}
  }, [boardSort]);
  const selectBoardSort = useCallback((mode: BoardSortMode) => {
    setBoardSort((current) => nextSortForMode(current, mode));
  }, []);
  return { boardSort, boardSortSheetOpen, selectBoardSort, setBoardSortSheetOpen };
}
