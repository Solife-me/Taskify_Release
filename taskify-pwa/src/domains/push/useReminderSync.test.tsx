// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useReminderSync, type ReminderSyncItem } from "./useReminderSync";
import type { PushPreferences } from "../tasks/settingsTypes";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pushPrefs = { enabled: true, deviceId: "device", subscriptionId: "subscription" } as PushPreferences;
const items: ReminderSyncItem[] = [{ taskId: "t1", title: "Pay rent", dueISO: "2026-10-05T09:00:00Z", reminders: ["5m"] as any }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function harness() {
  const sentPayloadRef = { current: null as string | null };
  const setPushError = vi.fn();
  const showToast = vi.fn();
  let currentPrefs = pushPrefs;
  function Harness() {
    useReminderSync({ reminderSyncItems: items, pushPrefs: currentPrefs, workerBaseUrl: "https://worker.test", sentPayloadRef, setPushError, showToast });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    sentPayloadRef,
    setPushError,
    showToast,
    render: (prefs = pushPrefs) => { currentPrefs = prefs; return act(async () => root.render(<Harness />)); },
    unmount: () => act(async () => root.unmount()),
  };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test("a failed save is retried until it succeeds, with one toast and the error cleared after", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
    .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  const h = harness();
  await h.render();

  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(h.sentPayloadRef.current).toBeNull();
  expect(h.setPushError).toHaveBeenLastCalledWith("Failed to sync reminders (503)");
  expect(h.showToast).toHaveBeenCalledTimes(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(h.showToast).toHaveBeenCalledTimes(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(h.sentPayloadRef.current).toContain("Pay rent");
  expect(h.setPushError).toHaveBeenLastCalledWith(null);
  await h.unmount();
});

test("a refused save waits for the server's Retry-After", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "Retry-After": "600" }) })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  const h = harness();
  await h.render();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(599_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await h.unmount();
});

test("after a failure, an unchanged schedule is sent again when the effect re-runs", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
    .mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  const h = harness();
  await h.render();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await flush();
  // Settings change identity (as on any settings write); the schedule itself is the same.
  await h.render({ ...pushPrefs });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  // Once accepted, an unchanged schedule is not sent again.
  await h.render({ ...pushPrefs });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await h.unmount();
});
