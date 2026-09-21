// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DroppableColumn } from "./DroppableColumn";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; });

function drag(target: Element, type: string, data: Record<string, string>, clientY = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { types: Object.keys(data), getData: (key: string) => data[key] ?? "" } },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

test("drops selected tasks before the card under the pointer and clears drag state", async () => {
  const host = document.createElement("div");
  const ref = createRef<HTMLDivElement>();
  const dropped = vi.fn();
  const ended = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(
    <DroppableColumn ref={ref} title="Today" onDropCard={dropped} onDropEnd={ended}>
      <div data-task-id="first" /><div data-task-id="second" />
    </DroppableColumn>,
  ));
  const column = ref.current!;
  const cards = column.querySelectorAll<HTMLElement>("[data-task-id]");
  cards.forEach((card, i) => vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ top: i * 100, height: 100 } as DOMRect));
  const data = { "text/task-id": "dragged", "text/task-ids": '["dragged","selected"]' };
  await act(async () => drag(column, "dragenter", data));
  expect(column.dataset.dropOver).toBe("true");
  await act(async () => drag(column, "drop", data, 120));
  expect(dropped).toHaveBeenCalledExactlyOnceWith({ id: "dragged", beforeId: "second", allIds: ["dragged", "selected"] });
  expect(ended).toHaveBeenCalledOnce();
  expect(column.hasAttribute("data-drop-over")).toBe(false);
});

test("appends plain-text task drops and ignores drops with no task ID", async () => {
  const host = document.createElement("div");
  const dropped = vi.fn();
  const ended = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(<DroppableColumn title="Empty" onDropCard={dropped} onDropEnd={ended}>{null}</DroppableColumn>));
  const column = host.firstElementChild!;
  await act(async () => drag(column, "drop", { "text/plain": "task" }, 1000));
  expect(dropped).toHaveBeenCalledExactlyOnceWith({ id: "task", beforeId: undefined, allIds: undefined });
  await act(async () => drag(column, "drop", {}));
  expect(dropped).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledTimes(2);
});

test("keeps selection controls and keyboard title activation wired to callbacks", async () => {
  const host = document.createElement("div");
  const select = vi.fn();
  const activate = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(
    <DroppableColumn title="Today" onDropCard={vi.fn()} selectionState="all" onSelectAll={select} onTitleClick={activate}>{null}</DroppableColumn>,
  ));
  const checkbox = host.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  await act(async () => checkbox.click());
  expect(select).toHaveBeenCalledOnce();
  const title = host.querySelector('[role="button"]')!;
  await act(async () => title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(activate).toHaveBeenCalledOnce();
});
