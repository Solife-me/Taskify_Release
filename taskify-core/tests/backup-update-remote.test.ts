import test from "node:test";
import assert from "node:assert/strict";
import { updateRemoteNostrBackup } from "../dist/index.js";

const seed = { type: "nut13-wallet-backup", version: 1, mnemonic: "abandon ability", counters: {} } as const;
const board = (nostrId: string, name = nostrId) => ({ id: `local-${nostrId}`, nostrId, name, kind: "lists" as const });

test("another device's boards, settings and wallet seed survive this device's publish", () => {
  const remote = {
    boards: [board("theirs"), board("shared", "Old name")],
    settings: { onlyIosWrites: true, theme: "dark" },
    walletSeed: seed,
    defaultRelays: ["wss://a"],
  };
  const next = updateRemoteNostrBackup(
    remote,
    { boards: [board("shared", "New name"), board("mine")], settings: { theme: "light" }, walletSeed: null, defaultRelays: ["wss://b"] },
    { managedNostrIds: [], includeMetadata: true },
  );
  assert.deepEqual(next.boards.map((b) => [b.nostrId, b.name]), [["theirs", "theirs"], ["shared", "New name"], ["mine", "mine"]]);
  assert.deepEqual(next.settings, { onlyIosWrites: true, theme: "light" });
  assert.deepEqual(next.walletSeed, seed);
  assert.deepEqual(next.defaultRelays, ["wss://b"]);
  assert.deepEqual(next.managedNostrIds, ["mine", "shared"]);
});

test("a board this device removed leaves the backup; one it never had stays", () => {
  const next = updateRemoteNostrBackup(
    { boards: [board("removed-here"), board("theirs")], settings: {} },
    { boards: [], settings: {}, defaultRelays: [] },
    { managedNostrIds: ["removed-here"], includeMetadata: true },
  );
  assert.deepEqual(next.boards.map((b) => b.nostrId), ["theirs"]);
});

test("this device's own seed wins; without metadata only the seed changes", () => {
  const mine = { ...seed, mnemonic: "mine" };
  const next = updateRemoteNostrBackup(
    { boards: [board("theirs")], settings: { theme: "dark" }, walletSeed: seed, defaultRelays: ["wss://a"] },
    { boards: [board("local")], settings: { theme: "light" }, walletSeed: mine, defaultRelays: [] },
    { managedNostrIds: [], includeMetadata: false },
  );
  assert.deepEqual(next.boards.map((b) => b.nostrId), ["theirs"]);
  assert.deepEqual(next.settings, { theme: "dark" });
  assert.equal(next.walletSeed?.mnemonic, "mine");
});

test("the first backup (none on the relays) is this device's snapshot", () => {
  const next = updateRemoteNostrBackup(null, { boards: [board("mine")], settings: { a: 1 }, defaultRelays: [] }, { managedNostrIds: [], includeMetadata: true });
  assert.deepEqual(next.boards.map((b) => b.nostrId), ["mine"]);
  assert.equal(next.walletSeed, undefined);
});
