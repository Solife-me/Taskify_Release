// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { AppHistoryRouter } from "./appRouter";
import { OPEN_REMINDER_MESSAGE, reminderOverlay, useReminderTaps } from "./useReminderTaps";
import { parseAppRoute } from "./appRoute";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function stubServiceWorker() {
  const target = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { value: target, configurable: true });
  return target;
}

async function render(router: AppHistoryRouter) {
  function Harness() {
    useReminderTaps(router);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return () => act(async () => root.unmount());
}

test("reminder ids map to task and event overlays", () => {
  expect(reminderOverlay("t1")).toEqual({ kind: "task", id: "t1" });
  expect(reminderOverlay("event:e1")).toEqual({ kind: "event", id: "e1" });
  expect(reminderOverlay("event:")).toBeNull();
  expect(reminderOverlay("  ")).toBeNull();
});

test("a reminder tapped while the app is open opens its overlay over the current page", async () => {
  const sw = stubServiceWorker();
  window.history.replaceState(null, "", "/upcoming");
  const router = new AppHistoryRouter(window);
  const unmount = await render(router);
  await act(async () => {
    sw.dispatchEvent(new MessageEvent("message", { data: { type: OPEN_REMINDER_MESSAGE, taskId: "event:e1" } }));
  });
  expect(router.getSnapshot()).toEqual({ page: "upcoming", overlay: { kind: "event", id: "e1" } });
  await act(async () => {
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "OTHER", taskId: "t1" } }));
  });
  expect(router.getSnapshot().overlay).toEqual({ kind: "event", id: "e1" });
  await unmount();
});

test("a reminder that launches the app names its task in the URL", () => {
  expect(parseAppRoute("https://taskify.solife.me/?task=t1")?.overlay).toEqual({ kind: "task", id: "t1" });
  expect(parseAppRoute("https://taskify.solife.me/?task=event:e1")?.overlay).toEqual({ kind: "event", id: "e1" });
});
