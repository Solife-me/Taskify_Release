import { getPublicKey, nip19 } from "nostr-tools";
import { decryptFromBoard, encryptToBoard, resolveBoardReference } from "taskify-core";
import type { BoardEntry, TaskifyConfig } from "../config.js";
import type { CliNostrSession } from "../shared/nodeRuntimeSession.js";
import type { TaskCache } from "../taskCache.js";

/** What every runtime domain (tasks, calendar, boards) shares: the config, the session and the stores. */
export type RuntimeContext = {
  config: TaskifyConfig;
  session: CliNostrSession;
  ensureConnected(): Promise<void>;
  /** The board's own relays, or the profile's when it has none. */
  boardRelays(boardId: string): string[];
  taskCache: { read(): TaskCache; write(cache: TaskCache): void };
  persistConfig(config: TaskifyConfig): Promise<void>;
  /** Milliseconds since the epoch. */
  clock(): number;
  randomUUID(): string;
  isoNow(): string;
};

export type DecryptedPayload = Record<string, any>;

export async function encryptContent(boardId: string, plaintext: string): Promise<string> {
  return encryptToBoard(boardId, plaintext);
}

export async function decryptContent(boardId: string, data: string): Promise<string> {
  const result = await decryptFromBoard(boardId, data);
  return result.plaintext;
}

export function getUserPubkeyHex(config: TaskifyConfig): string | undefined {
  if (!config.nsec) return undefined;
  try {
    const decoded = nip19.decode(config.nsec);
    if (decoded.type === "nsec") {
      return getPublicKey(decoded.data as Uint8Array);
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function resolveBoardEntry(config: TaskifyConfig, boardIdOrName: string): BoardEntry | null {
  return resolveBoardReference(config.boards, boardIdOrName);
}
