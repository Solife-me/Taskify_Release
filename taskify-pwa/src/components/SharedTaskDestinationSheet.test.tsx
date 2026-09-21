// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Board } from "taskify-core";
import { SharedTaskDestinationSheet } from "./SharedTaskDestinationSheet";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const boards = [
  { id: "week", name: "Week", kind: "week" },
  { id: "work", name: "Work", kind: "lists", columns: [{ id: "todo", name: "To do" }, { id: "later", name: "Later" }], nostr: { boardId: "shared-work" } },
  { id: "home", name: "Home", kind: "lists", columns: [{ id: "todo", name: "To do" }] },
  { id: "all", name: "Combined", kind: "compound", children: ["shared-work", "home"] },
  { id: "empty", name: "Empty", kind: "lists", columns: [] },
  { id: "archived", name: "Archived", kind: "week", archived: true },
  { id: "hidden", name: "Hidden", kind: "week", hidden: true },
  { id: "bible", name: "Bible", kind: "bible" },
] as Board[];
async function render(initialBoardId = "week", suppliedBoards = boards) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<SharedTaskDestinationSheet boards={suppliedBoards} initialBoardId={initialBoardId} title="Shared task" onClose={onClose} onConfirm={onConfirm} />));
  return { onConfirm, onClose };
}
async function select(index: number, value: string) {
  const element = document.querySelectorAll("select")[index];
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function submit() {
  await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; });

test("does not accept on opening or canceling", async () => {
  const { onConfirm, onClose } = await render();
  expect(onConfirm).not.toHaveBeenCalled();
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});
test("adds to the chosen board and nondefault list, resetting list selection when switching boards", async () => {
  const { onConfirm } = await render();
  await select(0, "work");
  await select(1, JSON.stringify(["work", "later"]));
  await submit();
  expect(onConfirm).toHaveBeenLastCalledWith({ boardId: "work", columnId: "later" });
  await select(0, "home");
  await submit();
  expect(onConfirm).toHaveBeenLastCalledWith({ boardId: "home", columnId: "todo" });
});
test("resolves combined lists to their source boards, including shared board aliases", async () => {
  const { onConfirm } = await render("all");
  await select(1, JSON.stringify(["work", "later"]));
  await submit();
  expect(onConfirm).toHaveBeenCalledWith({ boardId: "work", columnId: "later" });
});
test("week destinations need no list and unavailable boards are excluded", async () => {
  const { onConfirm } = await render();
  expect(document.querySelectorAll("select")).toHaveLength(1);
  expect([...document.querySelectorAll("option")].map((option) => option.value)).not.toEqual(expect.arrayContaining(["archived", "hidden", "bible"]));
  await submit();
  expect(onConfirm).toHaveBeenCalledWith({ boardId: "week" });
});
test("empty lists cannot be confirmed", async () => {
  const { onConfirm } = await render("empty");
  expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await submit();
  expect(onConfirm).not.toHaveBeenCalled();
});

test("no available boards cannot be confirmed", async () => {
  const { onConfirm } = await render("missing", []);
  expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await submit();
  expect(onConfirm).not.toHaveBeenCalled();
});
