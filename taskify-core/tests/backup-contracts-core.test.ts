import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSettingsForNostrBackup, buildNostrBackupSnapshot, mergeBackupBoards } from "../dist/backupContracts.js";

test("sanitizeSettingsForNostrBackup strips local-only fields", () => {
  const out = sanitizeSettingsForNostrBackup({ backgroundImage: "x", accent: "y", pushNotifications: { deviceId: "d", enabled: true } }, { enabled: false });
  assert.equal((out as any).backgroundImage, undefined);
  assert.equal((out as any).accent, undefined);
  assert.equal((out as any).pushNotifications.enabled, true);
  assert.equal((out as any).pushNotifications.deviceId, undefined);
});

test("buildNostrBackupSnapshot includes only nostr boards", () => {
  const out = buildNostrBackupSnapshot({
    boards: [
      { id: "a", name: "A", kind: "week", nostr: { boardId: "na", relays: ["wss://r"] } },
      { id: "b", name: "B", kind: "lists", columns: [] },
    ] as any,
    settings: { theme: "dark" },
    includeMetadata: true,
    defaultRelays: ["wss://r"],
    fallbackRelays: [],
    normalizeRelayList: (r) => (r || []).filter(Boolean),
    sanitizeSettingsForBackup: (s) => s,
    walletSeed: {},
  });
  assert.equal(out.boards.length, 1);
});

test("buildNostrBackupSnapshot preserves board order metadata", () => {
  const out = buildNostrBackupSnapshot({
    boards: [
      { id: "b", name: "B", kind: "week", order: 1, nostr: { boardId: "nb", relays: ["wss://r"] } },
      { id: "a", name: "A", kind: "week", order: 0, nostr: { boardId: "na", relays: ["wss://r"] } },
    ] as any,
    settings: {},
    includeMetadata: true,
    defaultRelays: ["wss://r"],
    fallbackRelays: [],
    normalizeRelayList: (r) => (r || []).filter(Boolean),
    sanitizeSettingsForBackup: (s) => s,
    walletSeed: {},
  });
  assert.deepEqual(out.boards.map((board) => board.id), ["a", "b"]);
  assert.deepEqual(out.boards.map((board) => board.order), [0, 1]);
});

test("mergeBackupBoards adds new board", () => {
  const out = mergeBackupBoards({
    currentBoards: [] as any,
    incomingBoards: [{ id: "a", nostrId: "na", relays: ["wss://r"], kind: "week", name: "A" }] as any,
    baseRelays: ["wss://r"],
    normalizeRelayList: (r) => (r || []).filter(Boolean),
    createId: () => "generated",
  });
  assert.equal(out.length, 1);
});

test("mergeBackupBoards applies incoming board order", () => {
  const out = mergeBackupBoards({
    currentBoards: [
      { id: "b", name: "B", kind: "week", order: 0, nostr: { boardId: "nb", relays: ["wss://r"] } },
      { id: "a", name: "A", kind: "week", order: 1, nostr: { boardId: "na", relays: ["wss://r"] } },
    ] as any,
    incomingBoards: [
      { id: "a", nostrId: "na", relays: ["wss://r"], kind: "week", name: "A", order: 0 },
      { id: "b", nostrId: "nb", relays: ["wss://r"], kind: "week", name: "B", order: 1 },
    ] as any,
    baseRelays: ["wss://r"],
    normalizeRelayList: (r) => (r || []).filter(Boolean),
    createId: () => "generated",
  });
  assert.deepEqual(out.map((board: any) => board.id), ["a", "b"]);
  assert.deepEqual(out.map((board: any) => board.order), [0, 1]);
});

test("mergeBackupBoards removes existing and incoming tombstoned boards", () => {
  const duplicate = { id: "legacy-local", name: "Week", kind: "week", nostr: { boardId: "Legacy-Week", relays: ["wss://r"] } };
  const kept = { id: "kept-local", name: "Kept", kind: "week", nostr: { boardId: "kept", relays: ["wss://r"] } };
  const parent = { id: "parent-local", name: "Parent", kind: "compound", children: ["legacy-local", "kept-local"], nostr: { boardId: "parent", relays: ["wss://r"] } };
  const out = mergeBackupBoards({
    currentBoards: [duplicate, kept, parent] as any,
    incomingBoards: [
      { id: "legacy-remote", nostrId: "legacy-week", relays: ["wss://r"], kind: "week", name: "Week" },
      { id: "kept-remote", nostrId: "kept", relays: ["wss://r"], kind: "week", name: "Kept" },
    ] as any,
    baseRelays: ["wss://r"],
    normalizeRelayList: (relays) => (relays || []).filter(Boolean),
    createId: () => "generated",
    excludedNostrIds: ["LEGACY-WEEK"],
  });
  assert.deepEqual(out.map((board: any) => board.id), ["kept-local", "parent-local"]);
  assert.deepEqual((out[1] as any).children, ["kept-local"]);
});
