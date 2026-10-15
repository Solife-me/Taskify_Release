// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { AppOverlayRoute } from "./appRoute";
import { AppHistoryRouter, useAppRouter } from "./appRouter";
import { useOverlayHistory, useRouteOverlayOpener } from "./useOverlayHistory";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

type Controls = {
  router: AppHistoryRouter;
  openEditor: (id: string | null) => void;
  openSheet: (open: boolean) => void;
  state: () => { editor: string | null; sheet: boolean };
};

async function mount(): Promise<Controls & { unmount: () => Promise<void> }> {
  const controls = {} as Controls;
  function Harness() {
    const { route, router } = useAppRouter();
    const [editor, setEditor] = useState<string | null>(null);
    const [sheet, setSheet] = useState(false);
    const editorOverlay: AppOverlayRoute | null = editor ? { kind: "task", id: editor } : null;
    useOverlayHistory(router, route, editorOverlay, () => setEditor(null));
    useOverlayHistory(router, route, sheet ? { kind: "sheet", sheet: "recurring-task-delete" } : null, () => setSheet(false));
    controls.router = router;
    controls.openEditor = setEditor;
    controls.openSheet = setSheet;
    controls.state = () => ({ editor, sheet });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { ...controls, state: () => controls.state(), unmount: () => act(async () => root.unmount()) };
}

test("Back closes the top overlay, then the one beneath it", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const app = await mount();
  await act(async () => app.openEditor("t1"));
  await act(async () => app.openSheet(true));
  expect(window.location.search).toContain("sheet=recurring-task-delete");

  await act(async () => window.history.back());
  await vi.waitFor(() => expect(app.state()).toEqual({ editor: "t1", sheet: false }));

  await act(async () => window.history.back());
  await vi.waitFor(() => expect(app.state()).toEqual({ editor: null, sheet: false }));
  expect(window.location.pathname).toBe("/boards/b1");
  await app.unmount();
});

test("closing in the UI removes the history entries, so Back stays on the page", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const app = await mount();
  const pageEntry = app.router.getEntryId();
  await act(async () => app.openEditor("t1"));
  await act(async () => app.openSheet(true));
  await act(async () => {
    app.openSheet(false);
    app.openEditor(null);
  });
  await vi.waitFor(() => expect(app.router.getEntryId()).toBe(pageEntry));
  expect(app.router.getSnapshot().overlay).toBeUndefined();
  expect(app.state()).toEqual({ editor: null, sheet: false });
  await app.unmount();
});

test("switching the editor to another task replaces its entry instead of stacking", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const app = await mount();
  await act(async () => app.openEditor("t1"));
  const entry = app.router.getEntryId();
  await act(async () => app.openEditor("t2"));
  expect(app.router.getEntryId()).toBe(entry);
  expect(app.router.getSnapshot().overlay).toEqual({ kind: "task", id: "t2" });
  await app.unmount();
});

test("an editor opened for the overlay a link names adopts that entry", async () => {
  window.history.replaceState(null, "", "/task/t9?board=b1");
  const app = await mount();
  const entry = app.router.getEntryId();
  await act(async () => app.openEditor("t9"));
  expect(app.router.getEntryId()).toBe(entry);
  await act(async () => app.openEditor(null));
  await vi.waitFor(() => expect(window.location.pathname).toBe("/boards/b1"));
  await app.unmount();
});

async function mountWithOpener(initialTasks: string[]) {
  const controls = {} as {
    router: AppHistoryRouter;
    setTasks: (ids: string[]) => void;
    closeEditor: () => void;
    editor: () => string | null;
  };
  function Harness() {
    const { route, router } = useAppRouter();
    const [tasks, setTasks] = useState(initialTasks);
    const [editor, setEditor] = useState<string | null>(null);
    useOverlayHistory(router, route, editor ? { kind: "task", id: editor } : null, () => setEditor(null));
    useRouteOverlayOpener(router, route, (overlay) => {
      if (overlay.kind !== "task" || !tasks.includes(overlay.id)) return false;
      setEditor(overlay.id);
      return true;
    }, tasks);
    controls.router = router;
    controls.setTasks = setTasks;
    controls.closeEditor = () => setEditor(null);
    controls.editor = () => editor;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { ...controls, editor: () => controls.editor(), unmount: () => act(async () => root.unmount()) };
}

test("a link opens its task once the task has synced, and closing it does not reopen it", async () => {
  window.history.replaceState(null, "", "/task/t9?board=b1");
  const app = await mountWithOpener([]);
  expect(app.editor()).toBeNull();
  await act(async () => app.setTasks(["t9"]));
  expect(app.editor()).toBe("t9");

  await act(async () => app.closeEditor());
  await vi.waitFor(() => expect(window.location.pathname).toBe("/boards/b1"));
  expect(app.editor()).toBeNull();
  await app.unmount();
});

test("a sheet left in the URL by a reload is dismissed", async () => {
  window.history.replaceState(null, "", "/boards/b1?sheet=board-sort");
  const app = await mountWithOpener([]);
  await vi.waitFor(() => expect(app.router.getSnapshot().overlay).toBeUndefined());
  expect(window.location.search).toBe("");
  await app.unmount();
});
