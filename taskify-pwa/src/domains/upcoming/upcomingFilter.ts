/**
 * The Upcoming "Calendars" filter: which boards and lists are shown. A filter is `null` (show
 * everything) or a list of option ids, `board:<id>` and `board:<id>:col:<columnId>`. Selecting a
 * list implies its board; a board with lists stays selected only while one of its lists is.
 */
import type { Board } from "../tasks/taskTypes";

export type UpcomingFilterOption = { id: string; label: string; boardId: string; columnId?: string };
export type UpcomingFilterGroup = {
  id: string;
  label: string;
  boardId: string;
  boardOption: UpcomingFilterOption;
  listOptions: UpcomingFilterOption[];
};
export type UpcomingFilterPreset = { id: string; name: string; selection: string[] };

export function upcomingFilterGroups(visibleBoards: Board[]): UpcomingFilterGroup[] {
  return visibleBoards
    .filter((board) => board.kind !== "bible" && board.kind !== "compound")
    .map((board) => {
      const label = board.name || "Board";
      return {
        id: board.id,
        label,
        boardId: board.id,
        boardOption: { id: `board:${board.id}`, label, boardId: board.id },
        listOptions: board.kind === "lists"
          ? board.columns.map((column) => ({
              id: `board:${board.id}:col:${column.id}`,
              label: column.name,
              boardId: board.id,
              columnId: column.id,
            }))
          : [],
      };
    });
}

export function upcomingFilterOptions(groups: UpcomingFilterGroup[]): UpcomingFilterOption[] {
  return groups.flatMap((group) => [group.boardOption, ...group.listOptions]);
}

function sameMembers(a: string[], b: Set<string>): boolean {
  return a.length === b.size && a.every((id) => b.has(id));
}

/**
 * The stored filter brought in line with the current boards: unknown ids dropped, a selected
 * list's board selected, and a selected board with no selected list given all its lists.
 * Returns the same array when nothing changes.
 */
export function reconcileUpcomingFilter(filter: string[] | null, groups: UpcomingFilterGroup[]): string[] | null {
  const options = upcomingFilterOptions(groups);
  if (filter === null || !options.length) return filter;
  const allowed = new Set(options.map((option) => option.id));
  const next = new Set(filter.filter((id) => allowed.has(id)));
  for (const option of options) {
    if (option.columnId && next.has(option.id)) next.add(`board:${option.boardId}`);
  }
  for (const group of groups) {
    if (!next.has(group.boardOption.id) || group.listOptions.length === 0) continue;
    if (!group.listOptions.some((option) => next.has(option.id))) group.listOptions.forEach((option) => next.add(option.id));
  }
  return sameMembers(filter, next) ? filter : Array.from(next);
}

/** Toggles one board or list. Selecting everything is stored as `null`. */
export function toggleUpcomingFilterOption(
  filter: string[] | null,
  optionId: string,
  groups: UpcomingFilterGroup[],
): string[] | null {
  const options = upcomingFilterOptions(groups);
  const option = options.find((candidate) => candidate.id === optionId);
  if (!option) return filter;
  const next = new Set(filter ?? options.map((candidate) => candidate.id));
  const listIds = groups.find((group) => group.boardId === option.boardId)?.listOptions.map((list) => list.id) ?? [];
  const boardOptionId = `board:${option.boardId}`;
  if (!option.columnId) {
    const selecting = !next.has(optionId);
    for (const id of [optionId, ...listIds]) {
      if (selecting) next.add(id);
      else next.delete(id);
    }
  } else {
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId).add(boardOptionId);
    if (!listIds.some((id) => next.has(id))) next.delete(boardOptionId);
  }
  return next.size === options.length ? null : Array.from(next);
}

export function upcomingFilterSelection(filter: string[] | null, groups: UpcomingFilterGroup[]): Set<string> {
  return new Set(filter ?? upcomingFilterOptions(groups).map((option) => option.id));
}

/** The selection as the boards and lists `filterUpcomingTasks` checks. */
export function upcomingFilterMap(selection: Set<string>, groups: UpcomingFilterGroup[]) {
  const selectedBoards = new Set<string>();
  const selectedLists = new Map<string, Set<string>>();
  for (const option of upcomingFilterOptions(groups)) {
    if (!selection.has(option.id)) continue;
    if (option.columnId) {
      const lists = selectedLists.get(option.boardId) ?? new Set<string>();
      lists.add(option.columnId);
      selectedLists.set(option.boardId, lists);
    } else {
      selectedBoards.add(option.boardId);
    }
  }
  return { selectedBoards, selectedLists };
}

export function upcomingFilterLabel(
  filter: string[] | null,
  groups: UpcomingFilterGroup[],
  holidays: { enabled: boolean; label: string },
): string {
  const options = upcomingFilterOptions(groups);
  const withHolidays = (base: string) => (holidays.enabled ? `${base} + US holidays` : base);
  if (!options.length) return holidays.enabled ? holidays.label : "No boards";
  if (filter === null) return withHolidays("All boards");
  if (filter.length === 0) return holidays.enabled ? holidays.label : "None";
  if (filter.length === 1) return withHolidays(options.find((option) => option.id === filter[0])?.label || "1 selected");
  return withHolidays(`${filter.length} selected`);
}

/** A preset's selection limited to the boards and lists that still exist. */
export function presetFilter(preset: UpcomingFilterPreset, groups: UpcomingFilterGroup[]): string[] {
  const wanted = new Set(preset.selection);
  return upcomingFilterOptions(groups).filter((option) => wanted.has(option.id)).map((option) => option.id);
}

/** Saves the selection under `name`, replacing a preset of the same name (any case), newest first. */
export function savePreset(
  presets: UpcomingFilterPreset[],
  name: string,
  selection: string[],
  newId: () => string = () => crypto.randomUUID(),
): UpcomingFilterPreset[] {
  const existing = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  const saved = { id: existing?.id ?? newId(), name, selection: Array.from(new Set(selection)) };
  return [saved, ...presets.filter((preset) => preset !== existing)];
}
