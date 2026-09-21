import { afterEach, expect, test, vi } from "vitest";
import { syncRemindersToWorker } from "./reminderClient";
import type { PushPreferences } from "../tasks/settingsTypes";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const push = { deviceId: "device", subscriptionId: "subscription" } as PushPreferences;

test("sends stable reminder order and minute offsets with cancellation signal", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  await syncRemindersToWorker("https://worker.test", push, [
    { taskId: "z", boardId: "board", title: "Later", dueISO: "2026-09-15T12:00:00Z", reminders: ["1h", "5m"] },
    { taskId: "a", title: "First", dueISO: "2026-09-15T10:00:00Z", reminders: ["0h"] },
  ], { signal: controller.signal });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://worker.test/api/reminders");
  expect(init.method).toBe("PUT");
  expect(init.signal).toBe(controller.signal);
  expect(JSON.parse(init.body)).toEqual({ deviceId: "device", subscriptionId: "subscription", reminders: [
    { taskId: "a", title: "First", dueISO: "2026-09-15T10:00:00Z", minutesBefore: [0] },
    { taskId: "z", boardId: "board", title: "Later", dueISO: "2026-09-15T12:00:00Z", minutesBefore: [5, 60] },
  ] });
});
test("skips devices without a subscription and rejects missing worker configuration", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await syncRemindersToWorker("https://worker.test", {} as PushPreferences, []);
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(syncRemindersToWorker("", push, [])).rejects.toThrow("Worker base URL is not configured");
});
test("propagates rejected responses and aborts", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  vi.stubGlobal("fetch", fetchMock);
  await expect(syncRemindersToWorker("https://worker.test", push, [])).rejects.toThrow("503");
  const error = new DOMException("Cancelled", "AbortError");
  fetchMock.mockRejectedValue(error);
  await expect(syncRemindersToWorker("https://worker.test", push, [])).rejects.toBe(error);
});
