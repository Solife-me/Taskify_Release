// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { idbStorage } from "./idbStorage";
import { finishLocalReset, LOCAL_RESET_KEY } from "./localReset";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(() => vi.unstubAllGlobals());

test("only a pending reset erases Taskify databases and keys", async () => {
  for (const name of ["taskify", "taskify-account-test", "taskify-reminder-titles", "unrelated-data"]) {
    const database = await idbStorage.openDatabase({ name });
    database.close();
  }
  localStorage.setItem("taskify_nostr_sk_v2", "test key");
  localStorage.setItem("taskify-account:test:taskify_settings", "test settings");
  localStorage.setItem("cashuHistory", "test wallet");
  localStorage.setItem("unrelated-key", "keep");

  await finishLocalReset();
  expect(await idbStorage.databaseNames()).toHaveLength(4);
  expect(localStorage.getItem("taskify_nostr_sk_v2")).toBe("test key");

  localStorage.setItem(LOCAL_RESET_KEY, "1");
  await finishLocalReset();
  expect(await idbStorage.databaseNames()).toEqual(["unrelated-data"]);
  expect(Object.keys(localStorage)).toEqual(["unrelated-key"]);
});

test("keeps the reset pending until a blocked database can be deleted", async () => {
  const openInAnotherTab = await idbStorage.openDatabase({ name: "taskify" });
  localStorage.setItem(LOCAL_RESET_KEY, "1");
  localStorage.setItem("taskify_nostr_sk_v2", "test key");

  await expect(finishLocalReset()).rejects.toThrow("Close other Taskify tabs");
  expect(localStorage.getItem(LOCAL_RESET_KEY)).toBe("1");
  expect(localStorage.getItem("taskify_nostr_sk_v2")).toBe("test key");

  openInAnotherTab.close();
  await finishLocalReset();
  expect(localStorage.getItem(LOCAL_RESET_KEY)).toBeNull();
  expect(localStorage.getItem("taskify_nostr_sk_v2")).toBeNull();
});
