// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Board } from "taskify-core";
import { expect, test, vi } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { BoardsSection } from "./BoardsSection";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const boards: Board[] = [
  { id: "work", name: "Work", kind: "lists", columns: [] },
  { id: "bible", name: "Bible Tracker", kind: "bible" },
  { id: "home", name: "Home", kind: "lists", columns: [] },
];

function SettingsBoards() {
  const [items, setItems] = useState(boards);
  return (
    <ToastProvider>
      <BoardsSection
        boards={items}
        currentBoardId="work"
        setBoards={setItems}
        setTasks={vi.fn()}
        changeBoard={vi.fn()}
        shouldReloadForNavigation={() => false}
        onJoinBoard={vi.fn()}
        onBoardChanged={vi.fn()}
        onManageBoard={vi.fn()}
        onClose={vi.fn()}
        defaultRelays={[]}
      />
    </ToastProvider>
  );
}

test("moves a board without dragging and keeps the Bible Tracker in place", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<SettingsBoards />));

  const names = () => Array.from(container.querySelectorAll(".board-list-item .truncate"), (name) => name.textContent);
  expect(names()).toEqual(["Work", "Bible Tracker", "Home"]);
  const moveUp = container.querySelector<HTMLButtonElement>('button[aria-label="Move Home up"]');
  expect(moveUp?.disabled).toBe(false);
  await act(async () => moveUp?.click());
  expect(names()).toEqual(["Home", "Bible Tracker", "Work"]);
  expect(moveUp?.disabled).toBe(true);
  expect(container.querySelector('button[aria-label="Move Bible Tracker up"]')).toBeNull();

  await act(async () => root.unmount());
});
