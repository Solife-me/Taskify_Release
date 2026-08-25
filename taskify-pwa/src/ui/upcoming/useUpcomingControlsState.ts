import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  Board,
  BoardSortDirection,
  BoardSortMode,
  UpcomingBoardGrouping,
} from "taskify-core";
import { kvStorage } from "../../storage/kvStorage";
import {
  DEFAULT_BOARD_SORT_DIRECTION,
  normalizeBoardSortState,
} from "../../domains/tasks/taskUtils";

const LS_BOARD_SORT = "taskify_board_sort_v1";
const LS_UPCOMING_FILTER = "taskify_upcoming_filter_v1";
const LS_UPCOMING_US_HOLIDAYS_ENABLED = "taskify_upcoming_us_holidays_enabled_v1";
const LS_UPCOMING_VIEW = "taskify_upcoming_view_v1";
const LS_UPCOMING_SORT = "taskify_upcoming_sort_v1";
const LS_UPCOMING_BOARD_GROUPING = "taskify_upcoming_board_grouping_v1";
const LS_UPCOMING_FILTER_PRESETS = "taskify_upcoming_filter_presets_v1";

type UpcomingFilterOption = {
  id: string;
  label: string;
  boardId: string;
  columnId?: string;
};

type UpcomingFilterGroup = {
  id: string;
  label: string;
  boardId: string;
  boardOption: UpcomingFilterOption;
  listOptions: UpcomingFilterOption[];
};

type UpcomingFilterPreset = {
  id: string;
  name: string;
  selection: string[];
};

type UseUpcomingControlsStateParams = {
  usHolidaysLabel: string;
  visibleBoards: Board[];
};

export function useUpcomingControlsState({
  usHolidaysLabel,
  visibleBoards,
}: UseUpcomingControlsStateParams) {
  const [upcomingFilterOpen, setUpcomingFilterOpen] = useState(false);
  const [upcomingUsHolidaysEnabled, setUpcomingUsHolidaysEnabled] = useState<boolean>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_US_HOLIDAYS_ENABLED);
    if (!raw) return true;
    return raw === "1" || raw.toLowerCase() === "true";
  });
  const [upcomingFilter, setUpcomingFilter] = useState<string[] | null>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_FILTER);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null) return null;
      if (Array.isArray(parsed)) {
        return parsed.filter((id) => typeof id === "string");
      }
    } catch {}
    return null;
  });
  const [upcomingFilterPresets, setUpcomingFilterPresets] = useState<UpcomingFilterPreset[]>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_FILTER_PRESETS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry) => {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (!name) return [];
        const id = typeof entry?.id === "string" && entry.id ? entry.id : crypto.randomUUID();
        const selection = Array.isArray(entry?.selection)
          ? entry.selection.filter((id: unknown) => typeof id === "string")
          : [];
        return [{ id, name, selection }];
      });
    } catch {
      return [];
    }
  });
  const [upcomingViewSheetOpen, setUpcomingViewSheetOpen] = useState(false);
  const [upcomingView, setUpcomingView] = useState<"details" | "list">(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_VIEW);
    return raw === "list" ? "list" : "details";
  });
  const [upcomingSearchOpen, setUpcomingSearchOpen] = useState(false);
  const [upcomingSearch, setUpcomingSearch] = useState("");
  const [upcomingListDate, setUpcomingListDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [upcomingSortSheetOpen, setUpcomingSortSheetOpen] = useState(false);
  const [upcomingSort, setUpcomingSort] = useState<{ mode: BoardSortMode; direction: BoardSortDirection }>(() => {
    const fallback = { mode: "due" as const, direction: DEFAULT_BOARD_SORT_DIRECTION.due };
    const raw = kvStorage.getItem(LS_UPCOMING_SORT);
    if (!raw) return fallback;
    try {
      return normalizeBoardSortState(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const [upcomingBoardGrouping, setUpcomingBoardGrouping] = useState<UpcomingBoardGrouping>(() => {
    const raw = kvStorage.getItem(LS_UPCOMING_BOARD_GROUPING);
    return raw === "grouped" ? "grouped" : "mixed";
  });
  const [boardSortSheetOpen, setBoardSortSheetOpen] = useState(false);
  const [boardSort, setBoardSort] = useState<{ mode: BoardSortMode; direction: BoardSortDirection }>(() => {
    const fallback = { mode: "due" as const, direction: DEFAULT_BOARD_SORT_DIRECTION.due };
    const raw = kvStorage.getItem(LS_BOARD_SORT);
    if (!raw) return fallback;
    try {
      return normalizeBoardSortState(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_SORT, JSON.stringify(upcomingSort));
    } catch {}
  }, [upcomingSort]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_BOARD_GROUPING, upcomingBoardGrouping);
    } catch {}
  }, [upcomingBoardGrouping]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_BOARD_SORT, JSON.stringify(boardSort));
    } catch {}
  }, [boardSort]);

  const boardSortOptions = useMemo(
    () => [
      { id: "manual", label: "Manual", supportsDirection: false },
      { id: "due", label: "Due Date", supportsDirection: true },
      { id: "priority", label: "Priority", supportsDirection: true },
      { id: "created", label: "Creation Date", supportsDirection: true },
      { id: "alpha", label: "A-Z", supportsDirection: true },
    ] as const,
    [],
  );
  const handleBoardSortSelect = useCallback((mode: BoardSortMode) => {
    setBoardSort((prev) => {
      if (prev.mode === mode) {
        if (mode === "manual") return prev;
        const nextDirection = prev.direction === "asc" ? "desc" : "asc";
        return { mode, direction: nextDirection };
      }
      return { mode, direction: DEFAULT_BOARD_SORT_DIRECTION[mode] };
    });
  }, []);
  const upcomingBoardGroupingOptions = useMemo(
    () => [
      { id: "mixed", label: "Across boards" },
      { id: "grouped", label: "Group by board" },
    ] as const,
    [],
  );
  const handleUpcomingSortSelect = useCallback((mode: BoardSortMode) => {
    setUpcomingSort((prev) => {
      if (prev.mode === mode) {
        if (mode === "manual") return prev;
        const nextDirection = prev.direction === "asc" ? "desc" : "asc";
        return { mode, direction: nextDirection };
      }
      return { mode, direction: DEFAULT_BOARD_SORT_DIRECTION[mode] };
    });
  }, []);

  const upcomingFilterGroups = useMemo<UpcomingFilterGroup[]>(() => {
    const groups: UpcomingFilterGroup[] = [];
    visibleBoards
      .filter((board) => board.kind !== "bible" && board.kind !== "compound")
      .forEach((board) => {
        const label = board.name || "Board";
        const boardOption: UpcomingFilterOption = {
          id: `board:${board.id}`,
          label,
          boardId: board.id,
        };
        const listOptions =
          board.kind === "lists"
            ? board.columns.map((column) => ({
                id: `board:${board.id}:col:${column.id}`,
                label: column.name,
                boardId: board.id,
                columnId: column.id,
              }))
            : [];
        groups.push({
          id: board.id,
          label,
          boardId: board.id,
          boardOption,
          listOptions,
        });
      });
    return groups;
  }, [visibleBoards]);

  const upcomingFilterOptions = useMemo(() => {
    return upcomingFilterGroups.flatMap((group) => [group.boardOption, ...group.listOptions]);
  }, [upcomingFilterGroups]);
  const upcomingFilterOptionMap = useMemo(() => {
    const map = new Map<string, UpcomingFilterOption>();
    upcomingFilterOptions.forEach((option) => {
      map.set(option.id, option);
    });
    return map;
  }, [upcomingFilterOptions]);
  const upcomingFilterGroupMap = useMemo(() => {
    const map = new Map<string, UpcomingFilterGroup>();
    upcomingFilterGroups.forEach((group) => {
      map.set(group.boardId, group);
    });
    return map;
  }, [upcomingFilterGroups]);

  const upcomingFilterOptionIds = useMemo(
    () => upcomingFilterOptions.map((option) => option.id),
    [upcomingFilterOptions],
  );

  useEffect(() => {
    if (upcomingFilter === null || !upcomingFilterOptionIds.length) return;
    const allowed = new Set(upcomingFilterOptionIds);
    const next = new Set(upcomingFilter.filter((id) => allowed.has(id)));
    upcomingFilterOptions.forEach((option) => {
      if (!option.columnId) return;
      if (next.has(option.id)) {
        next.add(`board:${option.boardId}`);
      }
    });
    upcomingFilterGroups.forEach((group) => {
      if (!next.has(group.boardOption.id)) return;
      if (group.listOptions.length === 0) return;
      const hasAnyList = group.listOptions.some((option) => next.has(option.id));
      if (!hasAnyList) {
        group.listOptions.forEach((option) => next.add(option.id));
      }
    });
    if (next.size !== upcomingFilter.length || upcomingFilter.some((id) => !next.has(id))) {
      setUpcomingFilter(Array.from(next));
    }
  }, [upcomingFilter, upcomingFilterGroups, upcomingFilterOptionIds, upcomingFilterOptions]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_FILTER, JSON.stringify(upcomingFilter));
    } catch {}
  }, [upcomingFilter]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_US_HOLIDAYS_ENABLED, upcomingUsHolidaysEnabled ? "1" : "0");
    } catch {}
  }, [upcomingUsHolidaysEnabled]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_FILTER_PRESETS, JSON.stringify(upcomingFilterPresets));
    } catch {}
  }, [upcomingFilterPresets]);
  useEffect(() => {
    try {
      kvStorage.setItem(LS_UPCOMING_VIEW, upcomingView);
    } catch {}
  }, [upcomingView]);

  const upcomingFilterLabel = useMemo(() => {
    if (!upcomingFilterOptions.length) {
      return upcomingUsHolidaysEnabled ? usHolidaysLabel : "No boards";
    }
    if (upcomingFilter === null) {
      return upcomingUsHolidaysEnabled ? "All boards + US holidays" : "All boards";
    }
    if (upcomingFilter.length === 0) {
      return upcomingUsHolidaysEnabled ? usHolidaysLabel : "None";
    }
    if (upcomingFilter.length === 1) {
      const baseLabel = upcomingFilterOptions.find((option) => option.id === upcomingFilter[0])?.label || "1 selected";
      return upcomingUsHolidaysEnabled ? `${baseLabel} + US holidays` : baseLabel;
    }
    const baseLabel = `${upcomingFilter.length} selected`;
    return upcomingUsHolidaysEnabled ? `${baseLabel} + US holidays` : baseLabel;
  }, [upcomingFilter, upcomingFilterOptions, upcomingUsHolidaysEnabled, usHolidaysLabel]);

  const upcomingFilterSelection = useMemo(() => {
    if (upcomingFilter === null) return new Set(upcomingFilterOptionIds);
    return new Set(upcomingFilter);
  }, [upcomingFilter, upcomingFilterOptionIds]);

  const upcomingFilterMap = useMemo(() => {
    const selectedBoards = new Set<string>();
    const selectedLists = new Map<string, Set<string>>();
    upcomingFilterOptions.forEach((option) => {
      if (!upcomingFilterSelection.has(option.id)) return;
      if (option.columnId) {
        const existing = selectedLists.get(option.boardId) ?? new Set<string>();
        existing.add(option.columnId);
        selectedLists.set(option.boardId, existing);
      } else {
        selectedBoards.add(option.boardId);
      }
    });
    return { selectedBoards, selectedLists };
  }, [upcomingFilterOptions, upcomingFilterSelection]);

  const upcomingSearchTerm = useMemo(() => upcomingSearch.trim().toLowerCase(), [upcomingSearch]);
  const showUpcomingSearch = upcomingSearchOpen || upcomingSearchTerm.length > 0;

  const toggleUpcomingFilter = useCallback((optionId: string) => {
    if (!upcomingFilterOptionIds.length) return;
    setUpcomingFilter((prev) => {
      const option = upcomingFilterOptionMap.get(optionId);
      if (!option) return prev;
      const next = new Set(prev ?? upcomingFilterOptionIds);
      const group = upcomingFilterGroupMap.get(option.boardId);
      const listIds = group?.listOptions.map((opt) => opt.id) ?? [];
      const boardId = `board:${option.boardId}`;

      if (!option.columnId) {
        if (next.has(optionId)) {
          next.delete(optionId);
          listIds.forEach((id) => next.delete(id));
        } else {
          next.add(optionId);
          listIds.forEach((id) => next.add(id));
        }
      } else {
        if (next.has(optionId)) {
          next.delete(optionId);
        } else {
          next.add(optionId);
          next.add(boardId);
        }
        const hasAnyList = listIds.some((id) => next.has(id));
        if (!hasAnyList) {
          next.delete(boardId);
        }
      }

      const output = Array.from(next);
      if (output.length === upcomingFilterOptionIds.length) return null;
      return output;
    });
  }, [upcomingFilterGroupMap, upcomingFilterOptionIds, upcomingFilterOptionMap]);

  const applyUpcomingFilterPreset = useCallback(
    (preset: UpcomingFilterPreset) => {
      if (!upcomingFilterOptions.length) return;
      const presetSet = new Set(preset.selection);
      const next = upcomingFilterOptions
        .filter((option) => presetSet.has(option.id))
        .map((option) => option.id);
      setUpcomingFilter(next.length ? next : []);
    },
    [upcomingFilterOptions],
  );

  const saveUpcomingFilterPreset = useCallback(() => {
    if (!upcomingFilterOptions.length) return;
    const name = window.prompt("Name this preset");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const selection = upcomingFilterOptions
      .filter((option) => upcomingFilterSelection.has(option.id))
      .map((option) => option.id);
    const uniqueSelection = Array.from(new Set(selection));
    setUpcomingFilterPresets((prev) => {
      const existingIndex = prev.findIndex((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
      const updatedPreset = {
        id: existingIndex === -1 ? crypto.randomUUID() : prev[existingIndex].id,
        name: trimmed,
        selection: uniqueSelection,
      };
      if (existingIndex === -1) {
        return [updatedPreset, ...prev];
      }
      return [updatedPreset, ...prev.filter((_, idx) => idx !== existingIndex)];
    });
  }, [upcomingFilterOptions, upcomingFilterSelection]);

  const deleteUpcomingFilterPreset = useCallback((preset: UpcomingFilterPreset) => {
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm(`Delete preset "${preset.name}"?`);
    }
    if (!confirmed) return;
    setUpcomingFilterPresets((prev) => prev.filter((p) => p.id !== preset.id));
  }, []);

  const upcomingPresetHoldTimerRef = useRef<number | null>(null);
  const upcomingPresetHoldTriggeredRef = useRef(false);
  const upcomingPresetHoldStartRef = useRef<{ x: number; y: number } | null>(null);
  const cancelUpcomingPresetHold = useCallback(() => {
    if (upcomingPresetHoldTimerRef.current != null) {
      window.clearTimeout(upcomingPresetHoldTimerRef.current);
      upcomingPresetHoldTimerRef.current = null;
    }
    upcomingPresetHoldStartRef.current = null;
  }, []);
  useEffect(() => cancelUpcomingPresetHold, [cancelUpcomingPresetHold]);

  const startUpcomingPresetHold = useCallback(
    (preset: UpcomingFilterPreset, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      cancelUpcomingPresetHold();
      upcomingPresetHoldTriggeredRef.current = false;
      upcomingPresetHoldStartRef.current = { x: event.clientX, y: event.clientY };
      upcomingPresetHoldTimerRef.current = window.setTimeout(() => {
        upcomingPresetHoldTimerRef.current = null;
        upcomingPresetHoldTriggeredRef.current = true;
        upcomingPresetHoldStartRef.current = null;
        deleteUpcomingFilterPreset(preset);
      }, 650);
    },
    [cancelUpcomingPresetHold, deleteUpcomingFilterPreset],
  );
  const maybeCancelUpcomingPresetHold = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const start = upcomingPresetHoldStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
        cancelUpcomingPresetHold();
      }
    },
    [cancelUpcomingPresetHold],
  );

  return {
    applyUpcomingFilterPreset,
    boardSort,
    boardSortOptions,
    boardSortSheetOpen,
    cancelUpcomingPresetHold,
    handleBoardSortSelect,
    handleUpcomingSortSelect,
    maybeCancelUpcomingPresetHold,
    saveUpcomingFilterPreset,
    setBoardSortSheetOpen,
    setUpcomingBoardGrouping,
    setUpcomingFilter,
    setUpcomingFilterOpen,
    setUpcomingSearch,
    setUpcomingSearchOpen,
    setUpcomingSortSheetOpen,
    setUpcomingUsHolidaysEnabled,
    setUpcomingView,
    setUpcomingViewSheetOpen,
    setUpcomingListDate,
    showUpcomingSearch,
    startUpcomingPresetHold,
    toggleUpcomingFilter,
    upcomingBoardGrouping,
    upcomingBoardGroupingOptions,
    upcomingFilter,
    upcomingFilterGroups,
    upcomingFilterLabel,
    upcomingFilterMap,
    upcomingFilterOpen,
    upcomingFilterOptions,
    upcomingFilterPresets,
    upcomingFilterSelection,
    upcomingListDate,
    upcomingPresetHoldTriggeredRef,
    upcomingSearch,
    upcomingSearchOpen,
    upcomingSearchTerm,
    upcomingSort,
    upcomingSortSheetOpen,
    upcomingUsHolidaysEnabled,
    upcomingView,
    upcomingViewSheetOpen,
  };
}
