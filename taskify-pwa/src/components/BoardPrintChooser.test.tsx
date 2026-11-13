// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { BoardPrintChooser } from "./BoardPrintChooser";
import { DEFAULT_BOARD_PRINT_OPTIONS, type BoardPrintOptions } from "./BoardPrintLayout";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!(match instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return match;
}

function option(container: HTMLElement, text: string, type: "checkbox" | "radio"): HTMLInputElement {
  const match = [...container.querySelectorAll(`input[type=${type}]`)].find((input) =>
    input.closest("label")?.textContent?.includes(text),
  );
  if (!(match instanceof HTMLInputElement)) throw new Error(`${type} not found: ${text}`);
  return match;
}

function defaults(overrides: Partial<BoardPrintOptions> = {}): BoardPrintOptions {
  return { ...DEFAULT_BOARD_PRINT_OPTIONS, ...overrides };
}

test("chooses the whole board by default and supports a filtered list scope", async () => {
  const onContinue = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const initial = defaults();
  await act(async () => root.render(
    <BoardPrintChooser
      open
      boardName="Work"
      lists={[{ id: "todo", label: "To do" }, { id: "done", label: "Done" }]}
      selectedCount={2}
      defaults={initial}
      onClose={vi.fn()}
      onContinue={onContinue}
    />,
  ));

  expect(container.textContent).toContain("Upcoming tasks");
  expect(container.textContent).toContain("Completed tasks");
  expect(container.textContent).toContain("Turn on Notes or Due date and time");
  await act(async () => button(container, "Continue").click());
  expect(onContinue).toHaveBeenLastCalledWith({ kind: "board" }, initial);

  await act(async () => option(container, "Choose lists", "radio").click());
  await act(async () => option(container, "Done", "checkbox").click());
  await act(async () => button(container, "Continue").click());
  expect(onContinue).toHaveBeenLastCalledWith({ kind: "lists", listIds: ["todo"] }, initial);

  await act(async () => root.unmount());
});

test("offers selected items and returns the include and detail choices", async () => {
  const onContinue = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <BoardPrintChooser
      open
      boardName="Work"
      lists={[]}
      selectedCount={3}
      defaults={defaults({ includeCompleted: true })}
      onClose={vi.fn()}
      onContinue={onContinue}
    />,
  ));
  expect(container.textContent).toContain("3 selected");

  await act(async () => option(container, "Upcoming tasks", "checkbox").click());
  await act(async () => option(container, "Notes", "checkbox").click());
  await act(async () => option(container, "Due date and time", "checkbox").click());
  await act(async () => option(container, "Subtasks", "checkbox").click());
  await act(async () => option(container, "Photos", "checkbox").click());
  await act(async () => option(container, "Selected items", "radio").click());
  await act(async () => button(container, "Continue").click());
  expect(onContinue).toHaveBeenLastCalledWith(
    { kind: "selection" },
    defaults({
      includeUpcoming: true,
      includeCompleted: true,
      includeNotes: true,
      includeDue: true,
      includeSubtasks: true,
      includePhotos: true,
    }),
  );
  await act(async () => root.unmount());
});
