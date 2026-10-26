import { RelayAuthManager, RelayHealthTracker, RelayInfoCache, RuntimeNostrSession, boardTagHash, deriveBoardKeyPair } from "taskify-runtime-nostr";
import { decryptFromBoard, encryptToBoard } from "taskify-core";
import { finalizeEvent, type NostrEvent } from "nostr-tools";
import { createNostrRuntime } from "../../dist/runtime.js";
import type { TaskifyConfig } from "../../src/config.ts";
import type { TaskCache } from "../../src/taskCache.ts";
import { startMockRelay, type MockRelay } from "../../../taskify-runtime-nostr/tests/helpers/mockRelay.ts";
import { configWithBoards, harnessPubkey } from "./cliHarness.ts";

/** The runtime's boards for these tests: a list board, a week board and a compound of both. */
export const runtimeBoards: TaskifyConfig["boards"] = [
  { id: "board-lists-1", name: "Groceries", kind: "lists", columns: [{ id: "todo", name: "Todo" }, { id: "later", name: "Later" }] },
  { id: "board-week-1", name: "Week", kind: "week" },
  { id: "board-compound-1", name: "Everything", kind: "compound", children: ["board-lists-1", "board-week-1"] },
];

export const userPubkey = harnessPubkey;
export const START = Date.parse("2026-10-25T12:00:00.000Z");

/**
 * The CLI's Nostr runtime on a loopback relay, with the task cache and config in memory, a clock
 * that the test moves, and sequential UUIDs. Every event the runtime publishes is on `relay`.
 */
export async function runtimeHarness(options: { boards?: TaskifyConfig["boards"] } = {}) {
  const relay = await startMockRelay();
  const config = configWithBoards(structuredClone(options.boards ?? runtimeBoards));
  config.relays = [relay.url];
  config.profiles.test.relays = [relay.url];
  let cache: TaskCache = { boards: {} } as TaskCache;
  const saved: TaskifyConfig[] = [];
  let now = START;
  let uuid = 0;
  const runtime = createNostrRuntime(config, {
    createSession: (cfg) => new RuntimeNostrSession<undefined>(cfg.relays, {
      relayInfoCache: new RelayInfoCache(),
      relayHealth: new RelayHealthTracker(),
      createAuthManager: (ndk) => new RelayAuthManager(ndk, { loadSecretKeyHex: () => null, allowEphemeralKey: true }),
      createWalletClient: () => undefined,
      enableOutboxModel: false,
    }),
    taskCache: { read: () => structuredClone(cache), write: (value) => { cache = structuredClone(value); } },
    saveConfig: async (value) => { saved.push(structuredClone(value)); },
    now: () => now,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  return {
    runtime,
    relay,
    config,
    saved,
    cache: () => cache,
    /** Moves the clock on; relays keep the newest copy, by `created_at`, of each item. */
    advance(ms: number) { now += ms; },
    async close() {
      await runtime.disconnect();
      await relay.close();
    },
  };
}

/** The relay's current copies of `kind` for `boardId`, newest first. */
export function boardEvents(relay: MockRelay, boardId: string, kind: number): NostrEvent[] {
  const author = deriveBoardKeyPair(boardId).pk;
  const tag = boardTagHash(boardId);
  return relay.events
    .filter((event) => event.kind === kind && event.pubkey === author && event.tags.some((t) => t[0] === "b" && t[1] === tag))
    .sort((a, b) => b.created_at - a.created_at);
}

export function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * A task event as another device (or, with `secretKey`, someone without the board's key) would
 * sign it. Tests put it straight into `relay.events`, so a relay can hold several versions.
 */
export async function taskEvent(boardId: string, task: {
  id: string;
  status: "open" | "done" | "deleted";
  column?: string;
  payload: Record<string, unknown>;
  createdAt: number;
  secretKey?: Uint8Array;
}): Promise<NostrEvent> {
  return finalizeEvent({
    kind: 30301,
    created_at: task.createdAt,
    content: await encryptToBoard(boardId, JSON.stringify(task.payload)),
    tags: [["d", task.id], ["b", boardTagHash(boardId)], ["col", task.column ?? ""], ["status", task.status]],
  }, task.secretKey ?? Buffer.from(deriveBoardKeyPair(boardId).skHex, "hex"));
}

/** A task event's decrypted payload. */
export async function taskPayload(event: NostrEvent, boardId: string): Promise<Record<string, unknown>> {
  return JSON.parse((await decryptFromBoard(boardId, event.content)).plaintext);
}

export { boardTagHash, deriveBoardKeyPair };
