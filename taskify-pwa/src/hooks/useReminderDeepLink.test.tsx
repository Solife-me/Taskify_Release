// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { OPEN_REMINDER_MESSAGE, useReminderDeepLink } from "./useReminderDeepLink";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const task = { id: "t1", title: "Pay rent" } as any;
const event = { id: "e1", title: "Dentist" } as any;

function stubServiceWorker() {
  const target = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { value: target, configurable: true });
  return target;
}

async function render(tasks: any[], calendarEvents: any[], openEditor: (state: any) => void) {
  function Harness() {
    useReminderDeepLink({ tasks, calendarEvents, openEditor });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return () => act(async () => root.unmount());
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

test("?task= opens that task once and is removed from the address", async () => {
  stubServiceWorker();
  window.history.replaceState(null, "", "/?task=t1&view=week");
  const openEditor = vi.fn();
  const unmount = await render([task], [], openEditor);
  expect(openEditor).toHaveBeenCalledTimes(1);
  expect(openEditor).toHaveBeenCalledWith({ type: "task", originalType: "task", originalId: "t1", task });
  expect(window.location.search).toBe("?view=week");
  await unmount();
});

test("a message from the service worker opens an event reminder", async () => {
  const sw = stubServiceWorker();
  const openEditor = vi.fn();
  const unmount = await render([task], [event], openEditor);
  await act(async () => {
    sw.dispatchEvent(new MessageEvent("message", { data: { type: OPEN_REMINDER_MESSAGE, taskId: "event:e1" } }));
  });
  expect(openEditor).toHaveBeenCalledWith({ type: "event", originalType: "event", originalId: "e1", event });
  await unmount();
});

test("unknown items and other messages are ignored", async () => {
  const sw = stubServiceWorker();
  window.history.replaceState(null, "", "/?task=missing");
  const openEditor = vi.fn();
  const unmount = await render([task], [], openEditor);
  await act(async () => {
    sw.dispatchEvent(new MessageEvent("message", { data: { type: "OTHER", taskId: "t1" } }));
  });
  expect(openEditor).not.toHaveBeenCalled();
  await unmount();
});
