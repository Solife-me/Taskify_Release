// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { getPublicKey } from "nostr-tools";
import { beforeEach, expect, it, vi } from "vitest";

const firstSecret = new Uint8Array(32).fill(1);
const secondSecret = new Uint8Array(32).fill(2);
const first = getPublicKey(firstSecret);
const second = getPublicKey(secondSecret);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.resetModules();
});

async function openAccount(pubkey: string | null) {
  vi.resetModules(); // Account changes use a fresh document and fresh singleton caches.
  const accounts = await import("./accountStorage");
  const { getTaskifyDb, TASKIFY_STORE_MUTATIONS, TASKIFY_STORE_TASKS } = await import("./taskifyDb");
  const { taskEntityStore, boardEntityStore } = await import("./entityStore");
  const { idbKeyValue } = await import("./idbKeyValue");
  const { idbStorage } = await import("./idbStorage");
  const { kvStorage } = await import("./kvStorage");
  await accounts.bindAccountStorage(pubkey);
  await Promise.all([
    taskEntityStore.load(), boardEntityStore.load(),
    idbKeyValue.initStore(TASKIFY_STORE_TASKS, ["taskify_task_tombstones_v1"]),
  ]);
  const db = await getTaskifyDb();
  return { ...accounts, taskEntityStore, boardEntityStore, idbKeyValue, idbStorage, kvStorage, db, TASKIFY_STORE_MUTATIONS, TASKIFY_STORE_TASKS };
}

it("assigns the legacy tasks, boards, tombstones and outbox to the existing account once", async () => {
  const legacy = await openAccount(null);
  legacy.taskEntityStore.syncWith([{ id: "task" }]);
  legacy.boardEntityStore.syncWith([{ id: "board" }]);
  legacy.idbKeyValue.setItem(legacy.TASKIFY_STORE_TASKS, "taskify_task_tombstones_v1", "a tombstone");
  await legacy.idbStorage.put(legacy.db, legacy.TASKIFY_STORE_MUTATIONS, { id: "queued" });
  legacy.kvStorage.setItem("taskify_settings", "first settings");
  legacy.kvStorage.setItem("taskify_nostr_sk_v2", "device-scoped key");
  await legacy.flushAccountStorage();

  const owner = await openAccount(first);
  expect(owner.db.name).toBe(legacy.db.name);
  expect(owner.taskEntityStore.getAll()).toEqual([{ id: "task" }]);
  expect(owner.boardEntityStore.getAll()).toEqual([{ id: "board" }]);
  expect(owner.idbKeyValue.getItem(owner.TASKIFY_STORE_TASKS, "taskify_task_tombstones_v1")).toBe("a tombstone");
  expect(owner.kvStorage.getItem("taskify_settings")).toBe("first settings");

  const other = await openAccount(second);
  expect(other.db.name).not.toBe(owner.db.name);
  expect(other.taskEntityStore.getAll()).toEqual([]);
  expect(other.boardEntityStore.getAll()).toEqual([]);
  expect(await other.idbStorage.getAll(other.db, other.TASKIFY_STORE_MUTATIONS)).toEqual([]);
  expect(other.idbKeyValue.getItem(other.TASKIFY_STORE_TASKS, "taskify_task_tombstones_v1")).toBeNull();
  expect(other.kvStorage.getItem("taskify_settings")).toBeNull();
  expect(other.kvStorage.getItem("taskify_nostr_sk_v2")).toBe("device-scoped key");
  other.taskEntityStore.syncWith([{ id: "task" }, { id: "second-only" }]);
  other.kvStorage.setItem("taskify_settings", "second settings");
  await other.flushAccountStorage();

  const guest = await openAccount(null);
  expect(guest.taskEntityStore.getAll()).toEqual([]);
  const returned = await openAccount(first);
  expect(returned.taskEntityStore.getAll()).toEqual([{ id: "task" }]);
  expect(await returned.idbStorage.getAll(returned.db, returned.TASKIFY_STORE_MUTATIONS)).toEqual([{ id: "queued" }]);
  expect(returned.kvStorage.getItem("taskify_settings")).toBe("first settings");
  expect((await openAccount(second)).taskEntityStore.getAll()).toEqual([{ id: "second-only" }, { id: "task" }]);
});

it("stages an encrypted backup only for its account and merges it without removing existing tasks", async () => {
  const target = await openAccount(second);
  target.taskEntityStore.syncWith([{ id: "already-here" }]);
  await target.flushAccountStorage();
  const source = await openAccount(first);
  source.taskEntityStore.syncWith([{ id: "source-only" }]);
  await source.flushAccountStorage();

  await source.switchAccountStorage(second, async () => {
    // A page in the middle of a switch still reads the original account's data.
    expect(source.taskEntityStore.getAll()).toEqual([{ id: "source-only" }]);
    expect(await source.readPendingAccountBackup()).toBeNull();
  }, { backup: { tasks: [{ id: "from-backup" }] } });

  const signedIn = await openAccount(second);
  const staged = await signedIn.readPendingAccountBackup();
  expect(staged).not.toBeNull();
  const { applyBackupDataToStorage } = await import("../domains/backup/backupUtils");
  await applyBackupDataToStorage(JSON.parse(staged!.value), { mergeEntities: true });
  await staged!.finish();
  expect(signedIn.taskEntityStore.getAll().map(task => task.id).sort()).toEqual(["already-here", "from-backup"]);
  expect(await signedIn.readPendingAccountBackup()).toBeNull();
  expect((await openAccount(first)).taskEntityStore.getAll()).toEqual([{ id: "source-only" }]);
});
