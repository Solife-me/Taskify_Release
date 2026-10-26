import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { clearReminderTitles, saveReminderTitles } from "./reminderTitles";

// The service worker's reader, loaded as the worker loads it (a classic script on `self`).
type Reader = { lookup: (taskIds: string[], factory?: IDBFactory) => Promise<Map<string, string>> };
async function serviceWorkerReader(): Promise<Reader> {
  // @ts-expect-error -- a classic service-worker script: no exports, no types; it sets `taskifyReminderTitles`.
  await import("../../../public/reminder-titles.js");
  return (globalThis as unknown as { taskifyReminderTitles: Reader }).taskifyReminderTitles;
}

describe("reminder titles kept on the device (C13-8)", () => {
  let factory: IDBFactory;
  beforeEach(() => {
    factory = new IDBFactory();
  });

  it("the service worker reads back the titles the app saved", async () => {
    await saveReminderTitles([{ taskId: "a", title: "Pick up prescription" }, { taskId: "b", title: "Call Sam" }], factory);
    const reader = await serviceWorkerReader();
    const titles = await reader.lookup(["a", "b", "unknown"], factory);
    expect(Object.fromEntries(titles)).toEqual({ a: "Pick up prescription", b: "Call Sam" });
  });

  it("a later save replaces the whole map, so a removed task's title goes", async () => {
    await saveReminderTitles([{ taskId: "a", title: "Old" }, { taskId: "b", title: "Gone" }], factory);
    await saveReminderTitles([{ taskId: "a", title: "New" }], factory);
    const reader = await serviceWorkerReader();
    expect(Object.fromEntries(await reader.lookup(["a", "b"], factory))).toEqual({ a: "New" });
  });

  it("turning push off clears every title", async () => {
    await saveReminderTitles([{ taskId: "a", title: "Private" }], factory);
    await clearReminderTitles(factory);
    const reader = await serviceWorkerReader();
    expect((await reader.lookup(["a"], factory)).size).toBe(0);
  });

  it("the reader answers empty, not an error, before the app has saved anything", async () => {
    const reader = await serviceWorkerReader();
    expect((await reader.lookup(["a"], factory)).size).toBe(0);
  });
});
