// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { BoardPrintChooser } from "./BoardPrintChooser";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!(match instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return match;
}

test("chooses the whole board by default and supports a filtered list scope", async () => {
  const onContinue = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <BoardPrintChooser
      open
      boardName="Work"
      lists={[{ id: "todo", label: "To do" }, { id: "done", label: "Done" }]}
      selectedCount={2}
      includeCompleted={false}
      onClose={vi.fn()}
      onContinue={onContinue}
    />,
  ));

  expect(container.textContent).toContain("Only incomplete tasks will print");
  await act(async () => button(container, "Continue").click());
  expect(onContinue).toHaveBeenLastCalledWith({ kind: "board" });

  const chooseLists = [...container.querySelectorAll("input[type=radio]")].find((input) =>
    input.closest("label")?.textContent?.includes("Choose lists"),
  ) as HTMLInputElement;
  await act(async () => chooseLists.click());
  const done = [...container.querySelectorAll("input[type=checkbox]")].find((input) =>
    input.closest("label")?.textContent?.includes("Done"),
  ) as HTMLInputElement;
  await act(async () => done.click());
  await act(async () => button(container, "Continue").click());
  expect(onContinue).toHaveBeenLastCalledWith({ kind: "lists", listIds: ["todo"] });

  await act(async () => root.unmount());
});

test("offers selected items and explains when completed tasks are included", async () => {
  const onContinue = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <BoardPrintChooser
      open
      boardName="Work"
      lists={[]}
      selectedCount={3}
      includeCompleted
      onClose={vi.fn()}
      onContinue={onContinue}
    />,
  ));
  expect(container.textContent).toContain("Completed tasks are included");
  expect(container.textContent).toContain("3 selected");
  const selected = [...container.querySelectorAll("input[type=radio]")].find((input) =>
    input.closest("label")?.textContent?.includes("Selected items"),
  ) as HTMLInputElement;
  await act(async () => selected.click());
  await act(async () => button(container, "Continue").click());
  expect(onContinue).toHaveBeenLastCalledWith({ kind: "selection" });
  await act(async () => root.unmount());
});
