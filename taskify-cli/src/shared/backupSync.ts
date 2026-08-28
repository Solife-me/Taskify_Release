import {
  mergeBackupBoards,
  normalizeRelayList,
  type NostrAppBackupBoard,
} from "taskify-core";
import type { BoardEntry } from "../config.js";
import type { TaskifyConfig } from "../config.js";
import type { AccountCatalogBackup } from "./accountBackup.js";
import type { InboxShareItem } from "./shareTransport.js";

type ParsedBackupSnapshot = {
  boards: NostrAppBackupBoard[];
  settings: Record<string, unknown>;
  walletSeed: Record<string, unknown>;
  defaultRelays: string[];
};

type MergeBoardShape = {
  id: string;
  name: string;
  kind: "week" | "lists" | "compound" | "bible";
  nostr?: { boardId: string; relays: string[] };
  archived?: boolean;
  hidden?: boolean;
  clearCompletedDisabled?: boolean;
  indexCardEnabled?: boolean;
  hideChildBoardNames?: boolean;
  columns?: { id: string; name: string }[];
  children?: string[];
};

function fallbackRelayList(relays: string[] | undefined): string[] {
  return normalizeRelayList(relays) ?? [];
}

export function parseBackupSnapshot(raw: string): ParsedBackupSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid backup JSON");
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const boards = Array.isArray(obj.boards) ? (obj.boards as NostrAppBackupBoard[]) : [];
  const settings = obj.settings && typeof obj.settings === "object"
    ? (obj.settings as Record<string, unknown>)
    : {};
  const walletSeed = obj.walletSeed && typeof obj.walletSeed === "object"
    ? (obj.walletSeed as Record<string, unknown>)
    : {};
  const defaultRelays = normalizeRelayList(obj.defaultRelays) ?? [];

  return { boards, settings, walletSeed, defaultRelays };
}

export function mergeRelaysFromBackup(currentRelays: string[], backupDefaultRelays: string[]): string[] {
  const normalizedBackup = normalizeRelayList(backupDefaultRelays) ?? [];
  if (normalizedBackup.length > 0) return normalizedBackup;
  return normalizeRelayList(currentRelays) ?? [];
}

export function mergeBoardsFromBackup(
  currentBoards: BoardEntry[],
  incomingBoards: NostrAppBackupBoard[],
  defaultRelays: string[],
): BoardEntry[] {
  const nostrIdByBackupId = new Map(
    incomingBoards
      .filter((board): board is NostrAppBackupBoard & { nostrId: string } =>
        typeof board.id === "string" && typeof board.nostrId === "string" && !!board.nostrId.trim())
      .map((board) => [board.id, board.nostrId.trim()]),
  );
  const current: MergeBoardShape[] = currentBoards.map((board) => ({
    id: board.id,
    name: board.name,
    kind: board.kind ?? "lists",
    nostr: {
      boardId: nostrIdByBackupId.get(board.id) ?? board.id,
      relays: fallbackRelayList(board.relays),
    },
    archived: board.archived,
    hidden: board.hidden,
    clearCompletedDisabled: board.clearCompletedDisabled,
    indexCardEnabled: board.indexCardEnabled,
    hideChildBoardNames: board.hideChildBoardNames,
    columns: board.columns,
    children: board.children?.map((childId) => nostrIdByBackupId.get(childId) ?? childId),
  }));

  const merged = mergeBackupBoards<MergeBoardShape>({
    currentBoards: current,
    incomingBoards,
    baseRelays: fallbackRelayList(defaultRelays),
    normalizeRelayList: (relays) => fallbackRelayList(relays ?? undefined),
    createId: () => crypto.randomUUID(),
  });

  return merged.map((board) => ({
    id: board.nostr?.boardId ?? board.id,
    name: board.name,
    kind: board.kind,
    relays: board.nostr?.relays,
    archived: board.archived,
    hidden: board.hidden,
    clearCompletedDisabled: board.clearCompletedDisabled,
    indexCardEnabled: board.indexCardEnabled,
    hideChildBoardNames: board.hideChildBoardNames,
    columns: board.columns,
    children: board.children?.map((childId) => nostrIdByBackupId.get(childId) ?? childId),
  }));
}

export type AccountCatalogSyncSummary = {
  backupFound: true;
  backupEventId: string;
  boardsBefore: number;
  boardsAfter: number;
  boardsAdded: number;
  relaysBefore: number;
  relaysAfter: number;
};

export function applyAccountCatalogBackup(
  config: TaskifyConfig,
  backup: AccountCatalogBackup,
): AccountCatalogSyncSummary {
  const boardsBefore = config.boards.length;
  const relaysBefore = config.relays.length;
  const canonicalBoardIds = new Map<string, string>();
  for (const board of backup.boards) {
    const canonicalId = board.nostrId?.trim();
    if (!canonicalId) continue;
    canonicalBoardIds.set(board.id, canonicalId);
    canonicalBoardIds.set(canonicalId, canonicalId);
  }
  config.boards = mergeBoardsFromBackup(config.boards, backup.boards, config.relays);
  config.relays = mergeRelaysFromBackup(config.relays, backup.defaultRelays);
  if (config.defaultLocation) {
    config.defaultLocation = {
      ...config.defaultLocation,
      boardId: canonicalBoardIds.get(config.defaultLocation.boardId) ?? config.defaultLocation.boardId,
    };
  }
  if (config.defaultBoard) {
    config.defaultBoard = canonicalBoardIds.get(config.defaultBoard) ?? config.defaultBoard;
  }
  return {
    backupFound: true,
    backupEventId: backup.eventId,
    boardsBefore,
    boardsAfter: config.boards.length,
    boardsAdded: Math.max(0, config.boards.length - boardsBefore),
    relaysBefore,
    relaysAfter: config.relays.length,
  };
}

export function mergeBoardsFromShareInbox(
  config: Pick<TaskifyConfig, "boards" | "relays">,
  inbox: InboxShareItem[],
): { sharesScanned: number; boardSharesFound: number; boardsAdded: number } {
  let boardSharesFound = 0;
  let boardsAdded = 0;
  for (const message of inbox) {
    if (message.envelope.item.type !== "board") continue;
    boardSharesFound += 1;
    const item = message.envelope.item;
    const boardId = item.boardId.trim();
    if (!boardId) continue;
    const existing = config.boards.find((board) => board.id === boardId);
    if (existing) {
      existing.relays = Array.from(new Set([...(existing.relays ?? []), ...(item.relays ?? [])]));
      if (item.boardName?.trim() && existing.name === existing.id) existing.name = item.boardName.trim();
      continue;
    }
    config.boards.push({
      id: boardId,
      name: item.boardName?.trim() || boardId,
      kind: "lists",
      relays: item.relays?.length ? Array.from(new Set(item.relays)) : config.relays,
    });
    boardsAdded += 1;
  }
  return { sharesScanned: inbox.length, boardSharesFound, boardsAdded };
}
