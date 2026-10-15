// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { AppHistoryRouter } from "./appRouter";
import { formatAppRoute, parseAppRoute } from "./appRoute";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

test.each([
  [{ page: "boards" }, "/boards"],
  [{ page: "boards", boardId: "board 1" }, "/boards/board%201"],
  [{ page: "upcoming" }, "/upcoming"],
  [{ page: "chat", conversationId: "peer:1" }, "/chat/peer%3A1"],
  [{ page: "settings", section: "notifications" }, "/settings/notifications"],
  [{ page: "wallet-bounties" }, "/wallet/bounties"],
] as const)("page route %j formats as %s and round-trips", (route, expected) => {
  expect(formatAppRoute(route)).toBe(expected);
  expect(parseAppRoute(expected)).toEqual(route);
});

test("shared task, event and quick-add paths resolve to board overlays", () => {
  expect(parseAppRoute("/task/t1?board=b1")).toEqual({
    page: "boards",
    boardId: "b1",
    overlay: { kind: "task", id: "t1", boardId: "b1" },
  });
  expect(parseAppRoute("/event/e1")).toEqual({
    page: "boards",
    overlay: { kind: "event", id: "e1" },
  });
  expect(parseAppRoute("/quick-add?board=b1&column=c1")).toEqual({
    page: "boards",
    boardId: "b1",
    overlay: { kind: "quick-add", boardId: "b1", columnId: "c1" },
  });
});

test("legacy reminder query becomes the same typed overlay", () => {
  expect(parseAppRoute("/?task=t1")).toEqual({
    page: "boards",
    overlay: { kind: "task", id: "t1" },
  });
  expect(parseAppRoute("/?task=event%3Ae1")).toEqual({
    page: "boards",
    overlay: { kind: "event", id: "e1" },
  });
});

test("sheet entries retain their underlying page", () => {
  const route = {
    page: "boards" as const,
    boardId: "b1",
    overlay: { kind: "sheet" as const, sheet: "board-sort" as const },
  };
  const path = formatAppRoute(route);
  expect(path).toBe("/boards/b1?sheet=board-sort");
  expect(parseAppRoute(path)).toEqual(route);
});

test("page navigation pushes history and browser Back restores the prior page", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const router = new AppHistoryRouter(window);
  const listener = vi.fn();
  const unsubscribe = router.subscribe(listener);

  router.navigate({ page: "upcoming" });
  expect(window.location.pathname).toBe("/upcoming");
  expect(router.getSnapshot()).toEqual({ page: "upcoming" });

  window.history.back();
  await vi.waitFor(() => expect(router.getSnapshot()).toEqual({ page: "boards", boardId: "b1" }));
  expect(listener).toHaveBeenCalled();
  unsubscribe();
});

test("Back closes a pushed overlay and direct overlay close stays in the app", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const router = new AppHistoryRouter(window);
  const unsubscribe = router.subscribe(() => {});
  router.openOverlay({ kind: "task", id: "t1", boardId: "b1" });
  expect(window.location.pathname).toBe("/task/t1");

  router.closeOverlay();
  await vi.waitFor(() => expect(router.getSnapshot().overlay).toBeUndefined());
  expect(router.getSnapshot()).toEqual({ page: "boards", boardId: "b1" });
  unsubscribe();

  window.history.replaceState(null, "", "/event/e1?board=b1");
  const directRouter = new AppHistoryRouter(window);
  expect(directRouter.getSnapshot().overlay?.kind).toBe("event");
  directRouter.closeOverlay();
  expect(window.location.pathname).toBe("/boards/b1");
  expect(directRouter.getSnapshot().overlay).toBeUndefined();
});

test("closing an editor and the sheet over it in one action is one history step", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const router = new AppHistoryRouter(window);
  const unsubscribe = router.subscribe(() => {});
  const editor = router.openOverlay({ kind: "task", id: "t1", boardId: "b1" });
  const sheet = router.openOverlay({ kind: "sheet", sheet: "recurring-task-delete" });
  expect(sheet).toBe(editor + 1);

  router.closeOverlayEntry(sheet);
  router.closeOverlayEntry(editor);
  await vi.waitFor(() => expect(router.getSnapshot()).toEqual({ page: "boards", boardId: "b1" }));
  expect(router.getEntryId()).toBe(editor - 1);
  unsubscribe();
});

test("closing only the sheet returns to the editor beneath it", async () => {
  window.history.replaceState(null, "", "/boards/b1");
  const router = new AppHistoryRouter(window);
  const unsubscribe = router.subscribe(() => {});
  const editor = router.openOverlay({ kind: "task", id: "t1", boardId: "b1" });
  const sheet = router.openOverlay({ kind: "sheet", sheet: "recurring-task-delete" });
  router.closeOverlayEntry(sheet);
  await vi.waitFor(() => expect(router.getEntryId()).toBe(editor));
  expect(router.getSnapshot().overlay).toEqual({ kind: "task", id: "t1", boardId: "b1" });
  unsubscribe();
});

test("an overlay opened from a link closes to its page without leaving the app", async () => {
  window.history.replaceState(null, "", "/task/t9?board=b1");
  const router = new AppHistoryRouter(window);
  const unsubscribe = router.subscribe(() => {});
  router.closeOverlayEntry(router.getEntryId());
  await vi.waitFor(() => expect(router.getSnapshot().overlay).toBeUndefined());
  expect(window.location.pathname).toBe("/boards/b1");

  // With a sheet opened over the linked task, closing both goes back once, then replaces.
  window.history.replaceState(null, "", "/task/t9?board=b1");
  const linked = new AppHistoryRouter(window);
  const unsubscribeLinked = linked.subscribe(() => {});
  const root = linked.getEntryId();
  linked.openOverlay({ kind: "sheet", sheet: "recurring-task-delete" });
  linked.closeOverlayEntry(root + 1);
  linked.closeOverlayEntry(root);
  await vi.waitFor(() => expect(linked.getSnapshot()).toEqual({ page: "boards", boardId: "b1" }));
  expect(window.location.pathname).toBe("/boards/b1");
  unsubscribe();
  unsubscribeLinked();
});
