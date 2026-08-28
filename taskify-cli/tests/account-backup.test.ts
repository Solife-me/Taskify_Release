import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type NostrEvent,
} from "nostr-tools";
import {
  decodeAccountCatalogBackup,
  findAccountCatalogBackup,
  NOSTR_ACCOUNT_BACKUP_D_TAG,
  NOSTR_ACCOUNT_BACKUP_KIND,
} from "../src/shared/accountBackup.ts";
import { applyAccountCatalogBackup } from "../src/shared/backupSync.ts";

async function backupEvent(createdAt: number): Promise<{ event: NostrEvent; secretHex: string }> {
  const secret = generateSecretKey();
  const secretHex = bytesToHex(secret);
  const pubkey = getPublicKey(secret);
  const conversationKey = nip44.v2.utils.getConversationKey(hexToBytes(secretHex), pubkey);
  const content = await nip44.v2.encrypt(JSON.stringify({
    version: 1,
    timestamp: createdAt,
    boards: [{
      id: "pwa-local-board",
      nostrId: "nostr-board",
      name: "Client Work",
      kind: "lists",
      relays: ["wss://board.example"],
      columns: [{ id: "agent-queue", name: "Agent Queue" }],
    }],
    defaultRelays: ["wss://account.example"],
    walletSeed: { mnemonic: "must never leave the decoder" },
    settings: {},
  }), conversationKey);
  return {
    secretHex,
    event: finalizeEvent({
      kind: NOSTR_ACCOUNT_BACKUP_KIND,
      created_at: createdAt,
      tags: [["d", NOSTR_ACCOUNT_BACKUP_D_TAG], ["client", "taskify.app"]],
      content,
    }, secret),
  };
}

test("decodeAccountCatalogBackup verifies and returns catalog-only fields", async () => {
  const { event, secretHex } = await backupEvent(100);
  const decoded = await decodeAccountCatalogBackup(event, secretHex);
  assert.equal(decoded.eventId, event.id);
  assert.equal(decoded.boards[0].nostrId, "nostr-board");
  assert.deepEqual(decoded.defaultRelays, ["wss://account.example"]);
  assert.equal("walletSeed" in decoded, false);
  assert.equal("settings" in decoded, false);
});

test("findAccountCatalogBackup tries newest verified candidates until one decrypts", async () => {
  const valid = await backupEvent(100);
  const other = await backupEvent(200);
  const fetcher = {
    fetchEvents: async () => [valid.event, other.event],
  };
  const decoded = await findAccountCatalogBackup({
    session: fetcher,
    pubkey: valid.event.pubkey,
    secretKeyHex: valid.secretHex,
    relays: ["wss://relay.example"],
  });
  assert.equal(decoded?.eventId, valid.event.id);
});

test("decodeAccountCatalogBackup rejects events from a different author", async () => {
  const valid = await backupEvent(100);
  const other = await backupEvent(200);
  await assert.rejects(
    decodeAccountCatalogBackup(other.event, valid.secretHex),
    /does not belong to the active identity/,
  );
});

test("applyAccountCatalogBackup merges canonical board ids and relay catalogs", () => {
  const config = {
    relays: ["wss://old.example"],
    boards: [],
    defaultBoard: "local-1",
    defaultLocation: { boardId: "local-1", listId: "queue" },
  } as any;
  const summary = applyAccountCatalogBackup(config, {
    version: 1,
    timestamp: 100,
    eventId: "event-1",
    boards: [{
      id: "local-1",
      nostrId: "board-1",
      name: "Work",
      relays: ["wss://board.example"],
      columns: [{ id: "queue", name: "Queue" }],
    }],
    defaultRelays: ["wss://account.example"],
  });
  assert.equal(config.boards[0].id, "board-1");
  assert.equal(config.defaultBoard, "board-1");
  assert.deepEqual(config.defaultLocation, { boardId: "board-1", listId: "queue" });
  assert.deepEqual(config.relays, ["wss://account.example"]);
  assert.deepEqual(summary, {
    backupFound: true,
    backupEventId: "event-1",
    boardsBefore: 0,
    boardsAfter: 1,
    boardsAdded: 1,
    relaysBefore: 1,
    relaysAfter: 1,
  });
});
