/**
 * Applies a shared board's metadata event (name, kind, lists, compound children, options) to the
 * board list. Pure; the caller has already decrypted the event and checked it is the newest.
 */
import { findBoardByCompoundChildId } from "taskify-core";
import { withBoardOrder } from "../domains/tasks/boardUtils";
import type { Board, ListColumn } from "../domains/tasks/taskTypes";

export type BoardMetadata = {
  /** The `k` tag: "week", "lists" or "compound"; anything else keeps the board's kind. */
  kindTag: string | undefined;
  /** The `name` tag, if present. */
  name: string | undefined;
  /** The decrypted payload: columns, children, clearCompletedDisabled, listIndex, hideBoardNames. */
  payload: Record<string, any>;
};

export function applyBoardMetadata(
  prev: Board[],
  localBoardId: string,
  { kindTag, name, payload }: BoardMetadata,
  context: {
    defaultRelays: string[];
    newId: () => string;
    /** Relays to give linked child boards when the board has none of its own. */
    fallbackRelays?: string[];
  },
): Board[] {
  const fallbackRelays = context.fallbackRelays ?? [];
  const boardIndex = prev.findIndex((item) => item.id === localBoardId);
  if (boardIndex === -1) return prev;

  let working = prev.slice();
  const current = working[boardIndex];
  const nm = name || current.name;
  const clearCompletedDisabled =
    typeof payload?.clearCompletedDisabled === "boolean"
      ? payload.clearCompletedDisabled
      : !!current.clearCompletedDisabled;
  const listIndexEnabled =
    typeof payload?.listIndex === "boolean"
      ? payload.listIndex
      : (current.kind === "lists" || current.kind === "compound" ? !!current.indexCardEnabled : false);

  const parentRelays = (() => {
    const relays: string[] = current.nostr?.relays?.length
      ? current.nostr.relays
      : fallbackRelays.length
        ? fallbackRelays
        : context.defaultRelays;
    return Array.from(new Set(relays.filter(Boolean)));
  })();

  const ensureChildStub = (state: Board[], child: string): { id: string; boards: Board[] } => {
    const trimmed = child.trim();
    if (!trimmed) return { id: "", boards: state };
    const existing = findBoardByCompoundChildId(state, trimmed);
    if (existing) {
      return { id: existing.id, boards: state };
    }
    const stub: Board = {
      id: trimmed,
      name: "Linked board",
      kind: "lists",
      columns: [{ id: context.newId(), name: "Items" }],
      nostr: { boardId: trimmed, relays: parentRelays },
      archived: true,
      hidden: true,
      clearCompletedDisabled: false,
      indexCardEnabled: false,
      order: state.length,
    };
    return { id: stub.id, boards: withBoardOrder([...state, stub]) };
  };

  const buildNext = (): { board: Board; boards: Board[] } => {
    if (kindTag === "week") {
      const next: Board = {
        id: current.id,
        name: nm,
        nostr: current.nostr,
        kind: "week",
        archived: current.archived,
        hidden: current.hidden,
        clearCompletedDisabled,
        order: current.order,
      };
      return { board: next, boards: working };
    }
    if (kindTag === "lists") {
      const cols: ListColumn[] = Array.isArray(payload?.columns)
        ? payload.columns
        : current.kind === "lists"
          ? current.columns
          : [{ id: context.newId(), name: "Items" }];
      const next: Board = {
        id: current.id,
        name: nm,
        nostr: current.nostr,
        kind: "lists",
        columns: cols,
        archived: current.archived,
        hidden: current.hidden,
        clearCompletedDisabled,
        indexCardEnabled: listIndexEnabled,
        order: current.order,
      };
      return { board: next, boards: working };
    }
    if (kindTag === "compound") {
      const rawChildren: string[] = Array.isArray(payload?.children)
        ? payload.children.filter((child: unknown): child is string => typeof child === "string")
        : current.kind === "compound"
          ? current.children
          : [];
      const hideBoardNames =
        typeof payload?.hideBoardNames === "boolean"
          ? payload.hideBoardNames
          : current.kind === "compound"
            ? !!current.hideChildBoardNames
            : false;
      const seen = new Set<string>();
      let boardsState = working;
      const children = rawChildren.reduce<string[]>((acc, child) => {
        const result = ensureChildStub(boardsState, child);
        boardsState = result.boards;
        const canonical = result.id;
        if (!canonical || seen.has(canonical)) return acc;
        seen.add(canonical);
        acc.push(canonical);
        return acc;
      }, []);
      const next: Board = {
        id: current.id,
        name: nm,
        nostr: current.nostr,
        kind: "compound",
        children,
        archived: current.archived,
        hidden: current.hidden,
        clearCompletedDisabled,
        indexCardEnabled: listIndexEnabled,
        hideChildBoardNames: hideBoardNames,
        order: current.order,
      };
      return { board: next, boards: boardsState };
    }
    const next: Board = {
      ...current,
      name: nm,
      clearCompletedDisabled,
      ...(current.kind === "lists" || current.kind === "compound"
        ? {
            indexCardEnabled: listIndexEnabled,
            ...(current.kind === "compound"
              ? { hideChildBoardNames: current.hideChildBoardNames }
              : {}),
          }
        : {}),
    } as Board;
    return { board: next, boards: working };
  };

  const { board: updatedBoard, boards: updatedBoards } = buildNext();
  if (updatedBoards !== working) {
    working = updatedBoards;
  }
  const targetIndex = working.findIndex((item) => item.id === current.id);
  if (targetIndex === -1) {
    return working;
  }
  working[targetIndex] = updatedBoard;
  return withBoardOrder(working);
}
