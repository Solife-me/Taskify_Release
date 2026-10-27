// @vitest-environment jsdom
/**
 * Typing a task title or selecting one card must not re-render the rest of a large board.
 * The card is replaced by a counter; everything above it (board view, task actions and view
 * state) is real.
 */
import { act, memo, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task, Weekday } from "../../domains/tasks/taskTypes";
import { TaskActionsProvider, type TaskActions, type TaskView } from "../task/taskActions";
import { WeekBoardView } from "./WeekBoardView";
import type { GroupSelection, InlineAdd } from "./BoardViewParts";
import { clearInlineDraft, setInlineDraft } from "./inlineDrafts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renders = { cards: 0 };
vi.mock("../task/Card", () => ({
  Card: memo(function CountingCard() {
    renders.cards += 1;
    return null;
  }),
}));

const TASK_COUNT = 300;
const tasks: Task[] = Array.from({ length: TASK_COUNT }, (_, index) => ({
  id: `t${index}`,
  boardId: "week",
  title: `Task ${index}`,
  dueISO: "2026-10-18T12:00:00.000Z",
  completed: false,
  createdAt: index,
}) as unknown as Task);

const noop = () => {};
const actions = new Proxy({}, { get: () => noop }) as unknown as TaskActions;

type Controls = { toggle: (id: string) => void };
const controls = {} as Controls;

function Harness() {
  // Selection lives in the page component, as in App.
  const [selected, setSelected] = useState<string[]>([]);
  controls.toggle = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const tasksByDay = useMemo(() => {
    const map = new Map<Weekday, Task[]>();
    tasks.forEach((task, index) => {
      const day = (index % 7) as Weekday;
      map.set(day, [...(map.get(day) ?? []), task]);
    });
    return map;
  }, []);
  const view = useMemo<TaskView>(() => ({
    isSelectionMode: selected.length > 0,
    selectedItemIds: selected,
    pendingTaskIds: new Set(),
    pendingEventIds: new Set(),
    runningStreakFor: () => undefined,
    showStreaks: false,
    hideCompletedSubtasks: false,
    completedTab: true,
    boardsById: new Map(),
    weekStart: 0,
  }), [selected]);
  const inlineAdd: InlineAdd = {
    add: noop,
    setInputRef: noop,
  };
  const selection: GroupSelection = { active: selected.length > 0, toggle: noop, stateOf: () => "none", exit: noop };
  return (
    <TaskActionsProvider actions={actions} view={view}>
      <WeekBoardView
        scrollerRef={{ current: null }}
        tasksByDay={tasksByDay}
        eventsByDay={new Map()}
        inlineAdd={inlineAdd}
        selection={selection}
        setColumnRef={noop}
        onDayTitleClick={noop}
        dayGroupIds={() => []}
      />
    </TaskActionsProvider>
  );
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(async () => {
  renders.cards = 0;
  clearInlineDraft("0");
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  expect(renders.cards).toBe(TASK_COUNT);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

// Before this was fixed, each of these re-rendered all 300 cards.
test("a keystroke in a New Task field renders no cards", async () => {
  renders.cards = 0;
  await act(async () => setInlineDraft("0", "B")); // what the field's onChange does
  expect(host.querySelector<HTMLInputElement>('input[placeholder="New Task"]')?.value).toBe("B");
  expect(renders.cards).toBe(0);
});

test("once in selection mode, selecting a card renders only that card", async () => {
  // Entering selection mode changes every card (each shows a checkbox).
  await act(async () => controls.toggle("t5"));
  renders.cards = 0;
  await act(async () => controls.toggle("t6"));
  expect(renders.cards).toBe(1);
  renders.cards = 0;
  await act(async () => controls.toggle("t5"));
  expect(renders.cards).toBe(1);
});
