import { boardTagHash, deriveBoardKeyPair } from "taskify-runtime-nostr";
import { nextEventCreatedAt } from "taskify-core";
import type { BoardEntry } from "../config.js";
import { pickBestBoardMeta } from "../shared/boardMeta.js";
import { sanitizeRemote } from "../shared/displaySafe.js";
import { decryptContent, encryptContent, resolveBoardEntry, type RuntimeContext } from "./context.js";

export type CreateBoardInput = {
  name: string;
  kind: "lists" | "week" | "compound";
  columns?: { id: string; name: string }[];
  children?: string[];
};

export type BoardPatch = Partial<Pick<BoardEntry, "name" | "archived" | "hidden" | "indexCardEnabled" | "clearCompletedDisabled" | "hideChildBoardNames" | "shareSettings" | "columns" | "children" | "sortMode" | "sortDirection">>;

/** What `syncBoard` read from the board's newest definition. */
export type SyncedBoard = { name?: string; kind?: string; columns?: { id: string; name: string }[]; children?: string[] };

/**
 * Board definitions (kind 30300, signed with the board's key, encrypted to it) and the config
 * entries they keep in step with. The `NostrRuntime` facade exposes these methods as they are.
 */
export function createBoardRepository(context: RuntimeContext) {
  const { config, session, ensureConnected, boardRelays, persistConfig, clock, randomUUID } = context;

  async function publishBoardDefinition(board: BoardEntry): Promise<void> {
    const { signer } = deriveBoardKeyPair(board.id);
    const bTag = boardTagHash(board.id);
    const payload: Record<string, unknown> = {
      name: board.name,
      kind: board.kind ?? "lists",
      columns: board.columns ?? [],
      children: board.children ?? [],
      archived: !!board.archived,
      hidden: !!board.hidden,
      clearCompletedDisabled: !!board.clearCompletedDisabled,
      listIndex: !!board.indexCardEnabled,
      hideBoardNames: !!board.hideChildBoardNames,
      shareSettings: board.shareSettings ?? {},
      sortMode: board.sortMode ?? null,
      sortDirection: board.sortDirection ?? null,
      version: 1,
    };
    const encrypted = await encryptContent(board.id, JSON.stringify(payload));
    const event = session.createEvent();
    // After every definition known, so a change in the same second as the last (or after a member
    // whose clock is ahead) isn't the one relays drop. `definitionAt` is saved with the config.
    event.created_at = nextEventCreatedAt(clock() / 1000, board.definitionAt);
    event.kind = 30300;
    event.content = encrypted;
    // Tags are public: they carry only what the PWA and iOS put there. Lists and child boards are
    // in the encrypted payload. A child's id is that board's key, and list names are the user's.
    event.tags = [
      ["d", bTag],
      ["b", bTag],
      ["k", board.kind ?? "lists"],
      ["name", board.name],
      ...(board.sortMode ? [["sort", board.sortMode, board.sortDirection ?? "asc"]] : []),
    ];
    await session.publishSigned(event, signer, board.relays?.length ? board.relays : config.relays);
    board.definitionAt = event.created_at;
  }

  const repository = {
    async syncBoard(boardId: string): Promise<SyncedBoard> {
      await ensureConnected();
      const bTag = boardTagHash(boardId);
      const boardPubkey = deriveBoardKeyPair(boardId).pk;
      const rawEvents = await session.fetchEvents(
        [{ kinds: [30300], authors: [boardPubkey], "#b": [bTag], limit: 25 } as never],
        boardRelays(boardId),
        10_000,
      );
      // Only the board's own key signs its definition, as the PWA and iOS check. NDK drops other
      // authors for this filter today; the board's name, lists and children must not rest on that.
      const events = new Set(rawEvents.filter((event) => event.pubkey === boardPubkey).map((event) => session.createEvent(event)));

      // Use config from closure (avoids extra file read and ensures correct profile)
      const entry = config.boards.find((b) => b.id === boardId);
      if (!entry) return {};

      let name: string | undefined;
      let kind: string | undefined;
      let columns: { id: string; name: string }[] | undefined;
      let children: string[] | undefined;

      if (events.size > 0) {
        const eventLikes: Array<{ tags: string[][]; content: string; created_at?: number }> = [];

        for (const event of events) {
          let content = event.content ?? "";
          if (content) {
            try {
              content = await decryptContent(boardId, content);
            } catch {
              // Non-fatal: keep original content (may be plaintext/JSON, or unusable encrypted payload)
            }
          }
          eventLikes.push({
            tags: event.tags ?? [],
            content,
            created_at: event.created_at,
          });
        }

        // Any member can publish board metadata; its names reach the terminal and the config.
        const meta = sanitizeRemote(pickBestBoardMeta(eventLikes, boardId));
        name = meta.name;
        kind = meta.kind;
        columns = meta.columns;
        children = meta.children;

        if (name) entry.name = name;
        if (kind) entry.kind = kind as BoardEntry["kind"];
        if (columns && columns.length > 0) entry.columns = columns;
        if (children && children.length > 0) entry.children = children;
        if (meta.archived !== undefined) entry.archived = meta.archived;
        if (meta.hidden !== undefined) entry.hidden = meta.hidden;
        if (meta.indexCardEnabled !== undefined) entry.indexCardEnabled = meta.indexCardEnabled;
        if (meta.clearCompletedDisabled !== undefined) entry.clearCompletedDisabled = meta.clearCompletedDisabled;
        if (meta.hideChildBoardNames !== undefined) entry.hideChildBoardNames = meta.hideChildBoardNames;
        if (meta.shareSettings !== undefined) entry.shareSettings = meta.shareSettings;
        // Sort is the CLI's alone: a definition from the PWA or iOS leaves this device's as it is.
        if (meta.sortMode) {
          entry.sortMode = meta.sortMode;
          if (meta.sortDirection) entry.sortDirection = meta.sortDirection;
        }
        const newest = Math.max(...eventLikes.map((event) => event.created_at ?? 0));
        if (newest > (entry.definitionAt ?? 0)) entry.definitionAt = newest;
        await persistConfig(config);
      }

      return { name, kind, columns, children };
    },

    async createBoard(input: CreateBoardInput): Promise<{ boardId: string }> {
      await ensureConnected();
      const boardId = randomUUID();

      const newEntry: BoardEntry = {
        id: boardId,
        name: input.name,
        kind: input.kind,
        columns: input.columns ?? [],
        children: input.children ?? [],
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
        hideChildBoardNames: false,
      };
      try {
        await publishBoardDefinition(newEntry);
      } catch (err) {
        throw new Error(`Board publish failed: ${String(err)}`);
      }

      config.boards.push(newEntry);
      await persistConfig(config);
      return { boardId };
    },

    async updateBoard(boardId: string, patch: BoardPatch): Promise<BoardEntry | null> {
      await ensureConnected();
      const entry = resolveBoardEntry(config, boardId);
      if (!entry) return null;
      if (patch.name !== undefined) entry.name = patch.name;
      if (patch.archived !== undefined) entry.archived = patch.archived;
      if (patch.hidden !== undefined) entry.hidden = patch.hidden;
      if (patch.indexCardEnabled !== undefined) entry.indexCardEnabled = patch.indexCardEnabled;
      if (patch.clearCompletedDisabled !== undefined) entry.clearCompletedDisabled = patch.clearCompletedDisabled;
      if (patch.hideChildBoardNames !== undefined) entry.hideChildBoardNames = patch.hideChildBoardNames;
      if (patch.columns !== undefined) entry.columns = patch.columns;
      if (patch.children !== undefined) entry.children = patch.children;
      if (patch.shareSettings !== undefined) entry.shareSettings = patch.shareSettings;
      if (patch.sortMode !== undefined) entry.sortMode = patch.sortMode;
      if (patch.sortDirection !== undefined) entry.sortDirection = patch.sortDirection;
      await publishBoardDefinition(entry);
      await persistConfig(config);
      return entry;
    },
  };
  return repository;
}
