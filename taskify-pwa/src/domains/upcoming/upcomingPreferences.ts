/**
 * The user's Upcoming preferences on this device: sort, board grouping, calendar filter and its
 * presets, US holidays, and view. One store, so the Upcoming page and a board's "upcoming"
 * section (which uses the same sort) always agree. Each change is saved at once.
 */
import { useSyncExternalStore } from "react";
import { createStateStore, type StateStore } from "../../state/stateStore";
import { kvStorage } from "../../storage/kvStorage";
import type { TaskSort } from "../tasks/taskSort";
import type { UpcomingBoardGrouping } from "../tasks/taskTypes";
import { DEFAULT_BOARD_SORT_DIRECTION, normalizeBoardSortState, type BoardSortMode } from "../tasks/taskUtils";
import type { UpcomingFilterPreset } from "./upcomingFilter";

export type UpcomingView = "details" | "list";

export type UpcomingPreferences = {
  sort: TaskSort;
  grouping: UpcomingBoardGrouping;
  /** null: every board and list. */
  filter: string[] | null;
  filterPresets: UpcomingFilterPreset[];
  usHolidaysEnabled: boolean;
  view: UpcomingView;
};

const STORAGE_KEYS = {
  sort: "taskify_upcoming_sort_v1",
  grouping: "taskify_upcoming_board_grouping_v1",
  filter: "taskify_upcoming_filter_v1",
  filterPresets: "taskify_upcoming_filter_presets_v1",
  usHolidaysEnabled: "taskify_upcoming_us_holidays_enabled_v1",
  view: "taskify_upcoming_view_v1",
} as const satisfies Record<keyof UpcomingPreferences, string>;

const DEFAULT_SORT: TaskSort = { mode: "due", direction: DEFAULT_BOARD_SORT_DIRECTION.due };

function json(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Reads stored preferences, falling back to defaults for anything missing or malformed. */
export function parseUpcomingPreferences(read: (key: string) => string | null): UpcomingPreferences {
  const filter = json(read(STORAGE_KEYS.filter));
  const presets = json(read(STORAGE_KEYS.filterPresets));
  const holidays = read(STORAGE_KEYS.usHolidaysEnabled);
  return {
    sort: normalizeBoardSortState(json(read(STORAGE_KEYS.sort))) ?? DEFAULT_SORT,
    grouping: read(STORAGE_KEYS.grouping) === "grouped" ? "grouped" : "mixed",
    filter: Array.isArray(filter) ? filter.filter((id): id is string => typeof id === "string") : null,
    filterPresets: Array.isArray(presets)
      ? presets.flatMap((entry) => {
          const name = typeof entry?.name === "string" ? entry.name.trim() : "";
          if (!name) return [];
          const id = typeof entry?.id === "string" && entry.id ? entry.id : crypto.randomUUID();
          const selection = Array.isArray(entry?.selection)
            ? entry.selection.filter((value: unknown): value is string => typeof value === "string")
            : [];
          return [{ id, name, selection }];
        })
      : [],
    usHolidaysEnabled: !holidays || holidays === "1" || holidays.toLowerCase() === "true",
    view: read(STORAGE_KEYS.view) === "list" ? "list" : "details",
  };
}

function serialize<K extends keyof UpcomingPreferences>(key: K, value: UpcomingPreferences[K]): string {
  if (key === "grouping" || key === "view") return value as string;
  if (key === "usHolidaysEnabled") return value ? "1" : "0";
  return JSON.stringify(value);
}

let store: StateStore<UpcomingPreferences> | null = null;

export function upcomingPreferencesStore(): StateStore<UpcomingPreferences> {
  if (!store) {
    store = createStateStore(parseUpcomingPreferences((key) => {
      try {
        return kvStorage.getItem(key);
      } catch {
        return null;
      }
    }));
  }
  return store;
}

export function useUpcomingPreferences(): UpcomingPreferences {
  const preferences = upcomingPreferencesStore();
  return useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get);
}

/** Applies a change and saves the keys it touched. */
export function updateUpcomingPreferences(
  change: Partial<UpcomingPreferences> | ((current: UpcomingPreferences) => Partial<UpcomingPreferences>),
): void {
  const preferences = upcomingPreferencesStore();
  const current = preferences.get();
  const patch = typeof change === "function" ? change(current) : change;
  const changed = (Object.keys(patch) as (keyof UpcomingPreferences)[]).filter((key) => patch[key] !== current[key]);
  if (!changed.length) return;
  preferences.set({ ...current, ...patch });
  for (const key of changed) {
    try {
      kvStorage.setItem(STORAGE_KEYS[key], serialize(key, patch[key] as never));
    } catch {}
  }
}

/** Choosing the current mode again flips its direction; a new mode starts in its usual direction. */
export function nextSortForMode(current: TaskSort, mode: BoardSortMode): TaskSort {
  if (current.mode !== mode) return { mode, direction: DEFAULT_BOARD_SORT_DIRECTION[mode] };
  if (mode === "manual") return current;
  return { mode, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** Drops the loaded preferences so the next use reads storage again. Tests only. */
export function resetUpcomingPreferencesForTests(): void {
  store = null;
}
