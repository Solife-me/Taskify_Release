// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { kvStorage } from "../../storage/kvStorage";
import type { Board } from "../tasks/taskTypes";
import {
  presetFilter,
  reconcileUpcomingFilter,
  savePreset,
  toggleUpcomingFilterOption,
  upcomingFilterGroups,
  upcomingFilterLabel,
  upcomingFilterMap,
  upcomingFilterSelection,
} from "./upcomingFilter";
import {
  nextSortForMode,
  parseUpcomingPreferences,
  resetUpcomingPreferencesForTests,
  updateUpcomingPreferences,
  upcomingPreferencesStore,
} from "./upcomingPreferences";

const boards = [
  { id: "home", name: "Home", kind: "week" },
  { id: "work", name: "Work", kind: "lists", columns: [{ id: "now", name: "Now" }, { id: "later", name: "Later" }] },
  { id: "bible", name: "Bible", kind: "bible" },
] as unknown as Board[];
const groups = upcomingFilterGroups(boards);
const HOME = "board:home";
const WORK = "board:work";
const NOW = "board:work:col:now";
const LATER = "board:work:col:later";

describe("upcoming filter", () => {
  it("offers boards and their lists, not Bible boards", () => {
    expect(groups.map((g) => [g.boardOption.id, g.listOptions.map((o) => o.id)])).toEqual([[HOME, []], [WORK, [NOW, LATER]]]);
  });

  it("toggles a board with its lists, and a list with its board", () => {
    expect(toggleUpcomingFilterOption(null, WORK, groups)).toEqual([HOME]);
    expect(toggleUpcomingFilterOption([HOME], WORK, groups)).toBeNull();
    expect(toggleUpcomingFilterOption(null, NOW, groups)).toEqual([HOME, WORK, LATER]);
    expect(toggleUpcomingFilterOption([HOME, WORK, LATER], LATER, groups)).toEqual([HOME]);
    expect(toggleUpcomingFilterOption([HOME], "board:gone", groups)).toEqual([HOME]);
  });

  it("brings a stored filter in line with the current boards", () => {
    const stored = [HOME];
    expect(reconcileUpcomingFilter(stored, groups)).toBe(stored);
    expect(reconcileUpcomingFilter(["board:gone", LATER], groups)).toEqual([LATER, WORK]);
    expect(reconcileUpcomingFilter([WORK], groups)).toEqual([WORK, NOW, LATER]);
    expect(reconcileUpcomingFilter(null, groups)).toBeNull();
  });

  it("maps a selection to boards and lists", () => {
    const map = upcomingFilterMap(upcomingFilterSelection([WORK, NOW], groups), groups);
    expect([...map.selectedBoards]).toEqual(["work"]);
    expect([...map.selectedLists.get("work")!]).toEqual(["now"]);
    expect(upcomingFilterSelection(null, groups).size).toBe(4);
  });

  it("labels the selection", () => {
    const holidays = { enabled: true, label: "US Holidays" };
    expect(upcomingFilterLabel(null, groups, holidays)).toBe("All boards + US holidays");
    expect(upcomingFilterLabel([], groups, holidays)).toBe("US Holidays");
    expect(upcomingFilterLabel([HOME], groups, { ...holidays, enabled: false })).toBe("Home");
    expect(upcomingFilterLabel([HOME, WORK], groups, { ...holidays, enabled: false })).toBe("2 selected");
    expect(upcomingFilterLabel(null, [], { ...holidays, enabled: false })).toBe("No boards");
  });

  it("saves presets newest first, replacing one with the same name, and applies only what still exists", () => {
    const first = savePreset([], "Work", [WORK, WORK], () => "p1");
    expect(first).toEqual([{ id: "p1", name: "Work", selection: [WORK] }]);
    const replaced = savePreset([...first, { id: "p2", name: "Home", selection: [HOME] }], "work", [NOW], () => "p3");
    expect(replaced.map((p) => [p.id, p.name])).toEqual([["p1", "work"], ["p2", "Home"]]);
    expect(presetFilter({ id: "x", name: "x", selection: [HOME, "board:gone"] }, groups)).toEqual([HOME]);
  });
});

describe("upcoming preferences", () => {
  afterEach(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("taskify_upcoming_")) kvStorage.removeItem(key);
    resetUpcomingPreferencesForTests();
  });

  it("defaults sensibly and survives malformed storage", () => {
    const parsed = parseUpcomingPreferences((key) => (key.includes("sort") ? "{bad" : key.includes("presets") ? '[{"name":" "},{"name":"A","selection":[1,"x"]}]' : null));
    expect(parsed.sort).toEqual({ mode: "due", direction: "asc" });
    expect(parsed.grouping).toBe("mixed");
    expect(parsed.filter).toBeNull();
    expect(parsed.usHolidaysEnabled).toBe(true);
    expect(parsed.view).toBe("details");
    expect(parsed.filterPresets).toEqual([{ id: expect.any(String), name: "A", selection: ["x"] }]);
  });

  it("saves each change under the keys earlier versions used", () => {
    updateUpcomingPreferences({ grouping: "grouped", usHolidaysEnabled: false, filter: [HOME], view: "list" });
    expect(kvStorage.getItem("taskify_upcoming_board_grouping_v1")).toBe("grouped");
    expect(kvStorage.getItem("taskify_upcoming_us_holidays_enabled_v1")).toBe("0");
    expect(kvStorage.getItem("taskify_upcoming_filter_v1")).toBe(JSON.stringify([HOME]));
    resetUpcomingPreferencesForTests();
    expect(upcomingPreferencesStore().get()).toMatchObject({ grouping: "grouped", usHolidaysEnabled: false, filter: [HOME], view: "list" });
  });

  it("flips direction when the same sort is chosen again", () => {
    expect(nextSortForMode({ mode: "due", direction: "asc" }, "due")).toEqual({ mode: "due", direction: "desc" });
    expect(nextSortForMode({ mode: "due", direction: "asc" }, "priority")).toEqual({ mode: "priority", direction: "desc" });
    const manual = { mode: "manual" as const, direction: "asc" as const };
    expect(nextSortForMode(manual, "manual")).toBe(manual);
  });
});
