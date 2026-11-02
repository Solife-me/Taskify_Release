// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey } from "nostr-tools";

// The relays: unreachable until a test says otherwise.
let relayBackup: any = null;
let relaysReachable = false;
vi.mock("./NostrSession", () => ({
  NostrSession: {
    init: async () => ({
      fetchEvents: async (filters: any[]) => {
        if (!relaysReachable) throw new Error("Failed to fetch");
        const wantsBackup = filters.some((f) => (f["#d"] ?? []).includes("taskify-app-backup"));
        return wantsBackup && relayBackup ? [relayBackup] : [];
      },
    }),
  },
}));

// This device has no wallet seed; restoring one is covered by walletSeedBackup.test.ts.
vi.mock("../wallet/walletSeedBackup", () => ({
  walletSeedForBackup: () => null,
  restoreWalletSeedFromBackup: async () => {},
}));

import { decryptNostrBackupPayload, encryptNostrBackupPayload, NOSTR_APP_BACKUP_D_TAG, NOSTR_APP_BACKUP_KIND } from "../nostrBackup";
import { useNostrAppBackupSync } from "./useNostrAppBackupSync";
import type { NostrPublishFn } from "./useNostrIdentity";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const secret = new Uint8Array(32).fill(9);
const pubkey = getPublicKey(secret);
const seed = { type: "nut13-wallet-backup", version: 1, mnemonic: "abandon ability able", counters: {} } as const;
const board = (nostrId: string) =>
  ({ id: `b-${nostrId}`, name: nostrId, kind: "lists", columns: [], nostr: { boardId: nostrId, relays: ["wss://relay.test"] } }) as any;

// Implements only the returnEvent overload, which is the one the backup sync calls.
const recordingPublishRef = (published: any[]) => ({
  current: vi.fn(async (_relays: string[], template: any, options: any) => {
    const event = finalizeEvent({ ...template }, options.sk);
    if (template.kind === NOSTR_APP_BACKUP_KIND && template.tags.some((t: string[]) => t[0] === "d" && t[1] === NOSTR_APP_BACKUP_D_TAG)) published.push(event);
    return { event, createdAt: event.created_at };
  }) as unknown as NostrPublishFn,
});

beforeEach(() => {
  localStorage.clear();
  relayBackup = null;
  relaysReachable = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

test("a device that has not read the remote backup publishes nothing; once it has, other devices' boards and the seed survive", async () => {
  expect(NOSTR_APP_BACKUP_D_TAG).toBe("taskify-app-backup");
  const published: any[] = [];
  const nostrPublishRef = recordingPublishRef(published);
  let props: any = {
    bibleTracker: {} as any,
    boards: [board("mine")],
    defaultRelays: ["wss://relay.test"],
    nostrPK: pubkey,
    nostrPublishRef,
    nostrSK: secret,
    pool: { subscribe: () => () => {}, setRelays: () => {} },
    scriptureMemory: { entries: [] } as any,
    setBibleTracker: () => {},
    setBoards: () => {},
    setDefaultRelays: () => {},
    setScriptureMemory: () => {},
    setSettings: () => {},
    settings: { nostrBackupEnabled: true, nostrBackupMetadataEnabled: true, pushNotifications: {} } as any,
    showSettings: false,
    showToast: () => {},
    tagValue: (event: any, name: string) => event.tags.find((tag: string[]) => tag[0] === name)?.[1],
  };
  function Harness(next: any) {
    useNostrAppBackupSync(next);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = async (overrides: any = {}) => {
    props = { ...props, ...overrides };
    await act(async () => root.render(<Harness {...props} />));
  };
  try {
    // Offline at start: the remote backup could not be read.
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await render({ boards: [board("mine"), board("mine-2")] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(published).toHaveLength(0);

    // Back online: the relays hold another device's backup with its board and the wallet seed.
    const content = await encryptNostrBackupPayload(
      { version: 1, timestamp: 1_790_000_000, boards: [{ id: "x", nostrId: "theirs", name: "Theirs", kind: "lists" }], settings: {}, walletSeed: seed, defaultRelays: [] } as any,
      bytesToHex(secret),
      pubkey,
    );
    relayBackup = finalizeEvent({ kind: NOSTR_APP_BACKUP_KIND, created_at: 1_790_000_000, tags: [["d", NOSTR_APP_BACKUP_D_TAG]], content }, secret);
    relaysReachable = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });

    expect(published.length).toBeGreaterThan(0);
    const latest: any = await decryptNostrBackupPayload(published[published.length - 1].content, bytesToHex(secret), pubkey);
    expect(latest.boards.map((b: any) => b.nostrId).sort()).toEqual(["mine", "mine-2", "theirs"]);
    expect(latest.walletSeed?.mnemonic).toBe(seed.mnemonic);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a remote tombstone removes a stale local duplicate board and records the removal", async () => {
  const published: any[] = [];
  const nostrPublishRef = recordingPublishRef(published);
  const removed: string[][] = [];
  let renderedBoards: any[] = [];
  const duplicate = board("legacy-week-standard");
  const kept = board("current-week-unique");
  const content = await encryptNostrBackupPayload(
    {
      version: 1,
      timestamp: 1_790_000_100,
      boards: [{ id: "kept", nostrId: "current-week-unique", name: "Current week", kind: "week" }],
      boardTombstones: [{ nostrId: "legacy-week-standard", deletedAt: 1_790_000_050 }],
      settings: {},
      defaultRelays: ["wss://relay.test"],
    },
    bytesToHex(secret),
    pubkey,
  );
  relayBackup = finalizeEvent({
    kind: NOSTR_APP_BACKUP_KIND,
    created_at: 1_790_000_100,
    tags: [["d", NOSTR_APP_BACKUP_D_TAG]],
    content,
  }, secret);
  relaysReachable = true;

  function Harness() {
    const [boards, setBoards] = useState<any[]>([duplicate, kept]);
    renderedBoards = boards;
    useNostrAppBackupSync({
      bibleTracker: {} as any,
      boards,
      defaultRelays: ["wss://relay.test"],
      nostrPK: pubkey,
      nostrPublishRef,
      nostrSK: secret,
      pool: { subscribe: () => () => {}, setRelays: () => {} },
      scriptureMemory: { entries: [] } as any,
      setBibleTracker: () => {},
      setBoards,
      setDefaultRelays: () => {},
      setScriptureMemory: () => {},
      setSettings: () => {},
      settings: { nostrBackupEnabled: true, nostrBackupMetadataEnabled: true, pushNotifications: {} } as any,
      showSettings: false,
      showToast: () => {},
      tagValue: (event: any, name: string) => event.tags.find((tag: string[]) => tag[0] === name)?.[1],
      onRemoteBoardsRemoved: (ids) => removed.push(ids),
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(renderedBoards.map((entry) => entry.nostr.boardId)).toEqual(["current-week-unique"]);
    expect(removed).toEqual([[duplicate.id]]);
    expect(JSON.parse(localStorage.getItem("taskify_nostr_backup_board_tombstones_v1") || "null")).toMatchObject({
      accounts: {
        [pubkey]: [{ nostrId: "legacy-week-standard", deletedAt: 1_790_000_050 }],
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
});

test("deleting a board imported from another device publishes its tombstone", async () => {
  const published: any[] = [];
  const nostrPublishRef = recordingPublishRef(published);
  const content = await encryptNostrBackupPayload(
    {
      version: 1,
      timestamp: 1_790_000_200,
      boards: [
        { id: "legacy-week", nostrId: "legacy-week-standard", name: "Week", kind: "week" },
        { id: "kept-week", nostrId: "current-week-unique", name: "Current week", kind: "week" },
      ],
      settings: {},
      defaultRelays: ["wss://relay.test"],
    },
    bytesToHex(secret),
    pubkey,
  );
  relayBackup = finalizeEvent({
    kind: NOSTR_APP_BACKUP_KIND,
    created_at: 1_790_000_200,
    tags: [["d", NOSTR_APP_BACKUP_D_TAG]],
    content,
  }, secret);
  relaysReachable = true;
  let deleteKept = () => {};
  let renderedBoards: any[] = [];

  function Harness() {
    const [boards, setBoards] = useState<any[]>([board("legacy-week-standard")]);
    renderedBoards = boards;
    deleteKept = () => setBoards((previous) => previous.filter((entry) => entry.nostr.boardId !== "current-week-unique"));
    useNostrAppBackupSync({
      bibleTracker: {} as any,
      boards,
      defaultRelays: ["wss://relay.test"],
      nostrPK: pubkey,
      nostrPublishRef,
      nostrSK: secret,
      pool: { subscribe: () => () => {}, setRelays: () => {} },
      scriptureMemory: { entries: [] } as any,
      setBibleTracker: () => {},
      setBoards,
      setDefaultRelays: () => {},
      setScriptureMemory: () => {},
      setSettings: () => {},
      settings: { nostrBackupEnabled: true, nostrBackupMetadataEnabled: true, pushNotifications: {} } as any,
      showSettings: false,
      showToast: () => {},
      tagValue: (event: any, name: string) => event.tags.find((tag: string[]) => tag[0] === name)?.[1],
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(<Harness />);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(JSON.parse(localStorage.getItem("taskify_nostr_backup_managed_boards_v1") || "null")).toMatchObject({
      accounts: { [pubkey]: ["current-week-unique", "legacy-week-standard"] },
    });
    await act(async () => {
      deleteKept();
    });
    expect(renderedBoards.map((entry) => entry.nostr.boardId)).toEqual(["legacy-week-standard"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(published.length).toBeGreaterThan(0);
    const latest: any = await decryptNostrBackupPayload(published[published.length - 1].content, bytesToHex(secret), pubkey);
    expect(latest.boards.map((entry: any) => entry.nostrId)).toEqual(["legacy-week-standard"]);
    expect(latest.boardTombstones).toEqual([
      { nostrId: "current-week-unique", deletedAt: expect.any(Number) },
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
