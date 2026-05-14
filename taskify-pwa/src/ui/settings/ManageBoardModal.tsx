// @ts-nocheck
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { finalizeEvent } from "nostr-tools";
import { Modal } from "../Modal";
import { useToast } from "../../context/ToastContext";
import {
  compoundChildMatchesBoard,
  normalizeCompoundChildId,
  findBoardByCompoundChildId,
  parseCompoundChildInput,
} from "../../domains/tasks/boardUtils";
import { deriveBoardNostrKeys } from "../../domains/nostr/nostrKeyUtils";
import { createNostrPool, type NostrEvent } from "../../domains/nostr/nostrPool";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import { boardTag } from "../../boardCrypto";
import { isListLikeBoard } from "../../domains/tasks/taskTypes";
import type { Board, Task, ListColumn } from "../../domains/tasks/taskTypes";
import {
  BIBLE_BOARD_ID,
  pillButtonClass,
  parseCsv,
  addRelayToCsv,
  removeRelayFromCsv,
} from "./settingsConstants";

interface ManageBoardModalProps {
  board: Board;
  boards: Board[];
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  defaultRelays: string[];
  showAdvanced: boolean;
  setShowAdvanced: (fn: (prev: boolean) => boolean) => void;
  onShareBoard: (boardId: string, relaysCsv?: string) => void;
  onBoardChanged: (boardId: string, options?: { republishTasks?: boolean; board?: Board }) => void;
  onRegenerateBoardId: (boardId: string) => void;
  shouldReloadForNavigation: () => boolean;
  changeBoard: (id: string) => void;
  currentBoardId: string;
  onClose: () => void;
  onOpenSharePicker: (board: Board) => void;
}

export function ManageBoardModal({
  board,
  boards,
  setBoards,
  setTasks,
  defaultRelays,
  showAdvanced,
  setShowAdvanced,
  onShareBoard,
  onBoardChanged,
  onRegenerateBoardId,
  shouldReloadForNavigation,
  changeBoard,
  currentBoardId,
  onClose,
  onOpenSharePicker,
}: ManageBoardModalProps) {
  const { showToast } = useToast();

  // ─── Local state ───────────────────────────────────────────────────────────
  const [newBoardRelay, setNewBoardRelay] = useState("");
  const [newOverrideRelay, setNewOverrideRelay] = useState("");
  const [newCompoundChildId, setNewCompoundChildId] = useState("");
  const [relaysCsv, setRelaysCsv] = useState("");
  const [boardKeyInfo, setBoardKeyInfo] = useState<{ npub: string; nsec: string; pk: string } | null>(null);
  const [staleCleanupBusy, setStaleCleanupBusy] = useState(false);
  const [staleCleanupMessage, setStaleCleanupMessage] = useState<string | null>(null);

  // ─── Derived data ──────────────────────────────────────────────────────────
  const availableCompoundBoards = useMemo(() => {
    if (!board || board.kind !== "compound") return [] as Board[];
    return boards.filter((b) => {
      if (b.id === board.id) return false;
      if (b.kind !== "lists") return false;
      if (b.archived) return false;
      return !board.children.some((childId) => compoundChildMatchesBoard(childId, b));
    });
  }, [boards, board]);

  // ─── Derive board Nostr keys ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!board?.nostr?.boardId) {
        setBoardKeyInfo(null);
        return;
      }
      try {
        const keys = await deriveBoardNostrKeys(board.nostr.boardId);
        if (!cancelled) setBoardKeyInfo({ npub: keys.npub, nsec: keys.nsec, pk: keys.pk });
      } catch {
        if (!cancelled) setBoardKeyInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [board?.nostr?.boardId]);

  // ─── Cleanup stale board events ────────────────────────────────────────────
  const cleanupStaleBoardEvents = useCallback(async () => {
    if (staleCleanupBusy) return;
    if (!board?.nostr?.boardId) {
      showToast("Enable sharing first to clean up stale events.", 3000);
      return;
    }
    setStaleCleanupBusy(true);
    setStaleCleanupMessage("Scanning relays for stale events…");
    try {
      const relayList = Array.from(new Set(
        (board.nostr.relays?.length ? board.nostr.relays : (defaultRelays.length ? defaultRelays : DEFAULT_NOSTR_RELAYS))
          .map((r) => r.trim())
          .filter(Boolean)
      ));
      if (!relayList.length) throw new Error("No relays configured for this board.");
      const boardId = board.nostr.boardId;
      const boardKeys = await deriveBoardNostrKeys(boardId);
      const bTag = boardTag(boardId);
      const pool = createNostrPool();
      const events: NostrEvent[] = await new Promise((resolve) => {
        const collected: NostrEvent[] = [];
        const seen = new Set<string>();
        let pending = relayList.length;
        const finalize = () => {
          try { unsub(); } catch {}
          resolve(collected);
        };
        const unsub = pool.subscribe(
          relayList,
          [{ kinds: [30301], "#b": [bTag], limit: 2000 }],
          (ev) => {
            if (!ev || typeof ev.id !== "string" || seen.has(ev.id)) return;
            seen.add(ev.id);
            collected.push(ev);
          },
          () => {
            pending -= 1;
            if (pending <= 0) finalize();
          },
        );
        setTimeout(finalize, 5000);
      });
      const uniqueEvents = new Map<string, NostrEvent>();
      for (const ev of events || []) {
        if (ev && typeof ev.id === "string" && !uniqueEvents.has(ev.id)) {
          uniqueEvents.set(ev.id, ev);
        }
      }
      const authored = Array.from(uniqueEvents.values()).filter((ev) => ev.pubkey === boardKeys.pk);
      if (!authored.length) {
        setStaleCleanupMessage("No board-authored events found on relays.");
        return;
      }
      const tagVal = (ev: NostrEvent, name: string): string | undefined => {
        const tag = ev.tags.find((t) => t[0] === name);
        return tag ? tag[1] : undefined;
      };
      const latestByTask = new Map<string, number>();
      authored.forEach((ev) => {
        const taskId = tagVal(ev, "d");
        if (!taskId) return;
        const key = `${ev.kind}:${ev.pubkey}:${taskId}`;
        const ts = typeof ev.created_at === "number" ? ev.created_at : 0;
        const current = latestByTask.get(key) || 0;
        if (ts > current) latestByTask.set(key, ts);
      });
      const staleIds: string[] = [];
      authored.forEach((ev) => {
        const taskId = tagVal(ev, "d");
        if (!taskId) return;
        const key = `${ev.kind}:${ev.pubkey}:${taskId}`;
        const latest = latestByTask.get(key) || 0;
        const ts = typeof ev.created_at === "number" ? ev.created_at : 0;
        if (ts < latest) staleIds.push(ev.id);
      });
      if (!staleIds.length) {
        setStaleCleanupMessage("No stale events found.");
        return;
      }
      const chunkSize = 50;
      for (let i = 0; i < staleIds.length; i += chunkSize) {
        const chunk = staleIds.slice(i, i + chunkSize);
        const tags = chunk.map((id) => ["e", id] as string[]);
        const ev = finalizeEvent({
          kind: 5,
          tags,
          content: "Clean up stale Taskify board events",
          created_at: Math.floor(Date.now() / 1000),
          pubkey: boardKeys.pk,
        }, boardKeys.sk);
        pool.publishEvent(relayList, ev as unknown as NostrEvent);
      }
      const skipped = uniqueEvents.size - authored.length;
      const base = `Requested deletion for ${staleIds.length} stale event${staleIds.length === 1 ? "" : "s"}.`;
      const suffix = skipped ? ` Skipped ${skipped} event${skipped === 1 ? "" : "s"} signed by other keys.` : "";
      setStaleCleanupMessage(base + suffix);
      showToast("Deletion requests sent", 2500);
    } catch (error: any) {
      console.error("Failed to clean stale board events", error);
      setStaleCleanupMessage(error?.message || "Unable to clean stale events.");
      showToast("Unable to clean stale events", 3000);
    } finally {
      setStaleCleanupBusy(false);
    }
  }, [defaultRelays, board, showToast, staleCleanupBusy]);

  // ─── Board management functions ────────────────────────────────────────────

  function renameBoard(id: string, name: string) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(x => {
      if (x.id !== id) return x;
      const nb = { ...x, name };
      if (nb.nostr) setTimeout(() => onBoardChanged(id, { board: nb }), 0);
      return nb;
    }));
  }

  function archiveBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const b = boards.find(x => x.id === id);
    if (!b || b.archived) return;
    const remainingUnarchived = boards.filter(x => x.id !== id && !x.archived);
    if (remainingUnarchived.length === 0) {
      alert("At least one board must remain unarchived.");
      return;
    }
    setBoards(prev => prev.map(x => x.id === id ? { ...x, archived: true } : x));
    if (currentBoardId === id) {
      const nextVisible = boards.find(x => x.id !== id && !x.archived && !x.hidden);
      const fallback = remainingUnarchived[0];
      changeBoard((nextVisible ?? fallback)?.id || "");
    }
    onClose();
  }

  function unarchiveBoard(id: string) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: false } : b));
  }

  function setBoardHidden(id: string, hidden: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => (b.id === id ? { ...b, hidden } : b)));
  }

  function setBoardClearCompletedDisabled(id: string, disabled: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => {
      if (b.id !== id) return b;
      const nb = { ...b, clearCompletedDisabled: disabled };
      if (nb.nostr) setTimeout(() => onBoardChanged(id, { board: nb }), 0);
      return nb;
    }));
  }

  function setBoardIndexCardEnabled(id: string, enabled: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== id) return b;
      if (!isListLikeBoard(b)) return b;
      const nb = { ...b, indexCardEnabled: enabled } as Board;
      updated = nb;
      return nb;
    }));
    if (updated?.nostr) setTimeout(() => onBoardChanged(id, { board: updated! }), 0);
  }

  function setCompoundBoardHideChildNames(id: string, hidden: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    let updated: Board | null = null;
    setBoards((prev) =>
      prev.map((b) => {
        if (b.id !== id || b.kind !== "compound") return b;
        const nb: Board = { ...b, hideChildBoardNames: hidden };
        updated = nb;
        return nb;
      }),
    );
    if (updated?.nostr) setTimeout(() => onBoardChanged(id, { board: updated! }), 0);
  }

  function addColumn(boardId: string, name?: string): string | null {
    const requestedName = typeof name === "string" ? name.trim() : "";
    let createdId: string | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const colName = requestedName || `List ${b.columns.length + 1}`;
      const col: ListColumn = { id: crypto.randomUUID(), name: colName };
      createdId = col.id;
      const nb = { ...b, columns: [...b.columns, col] } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
    return createdId;
  }

  function renameColumn(boardId: string, colId: string) {
    const name = prompt("Rename list");
    if (name == null) return;
    const nn = name.trim();
    if (!nn) return;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const nb = { ...b, columns: b.columns.map(c => c.id === colId ? { ...c, name: nn } : c) } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
  }

  function deleteColumn(boardId: string, colId: string) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const nb = { ...b, columns: b.columns.filter(c => c.id !== colId) } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
  }

  function reorderColumn(boardId: string, dragId: string, targetId: string, before: boolean) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const cols = [...b.columns];
      const fromIndex = cols.findIndex(c => c.id === dragId);
      if (fromIndex === -1) return b;
      const [col] = cols.splice(fromIndex, 1);
      let targetIndex = cols.findIndex(c => c.id === targetId);
      if (targetIndex === -1) return b;
      if (!before) targetIndex++;
      cols.splice(targetIndex, 0, col);
      const nb = { ...b, columns: cols } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
  }

  function addCompoundChild(boardId: string, childIdRaw: string) {
    const { boardId: rawChildId, relays } = parseCompoundChildInput(childIdRaw);
    const childId = rawChildId.trim();
    if (!childId) return;
    let updated: Board | null = null;
    let blocked: "self" | "duplicate" | "unsupported" | null = null;
    let addedStub = false;
    setBoards(prev => {
      const parentBoard = prev.find((b) => b.id === boardId && b.kind === "compound");
      if (!parentBoard) return prev;

      const parentCanonical = normalizeCompoundChildId(prev, boardId);
      const resolvedChildId = normalizeCompoundChildId(prev, childId);
      if (resolvedChildId === parentCanonical) {
        blocked = "self";
        return prev;
      }

      let working = prev;
      let targetBoard = findBoardByCompoundChildId(prev, resolvedChildId);

      if (targetBoard && targetBoard.kind !== "lists") {
        blocked = "unsupported";
        return prev;
      }

      if (!targetBoard) {
        const relayList = relays.length
          ? Array.from(new Set(relays))
          : Array.from(new Set(defaultRelays));
        const stub: Board = {
          id: resolvedChildId,
          name: "Linked board",
          kind: "lists",
          columns: [{ id: crypto.randomUUID(), name: "Items" }],
          nostr: { boardId: resolvedChildId, relays: relayList },
          archived: true,
          hidden: true,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
        };
        working = [...prev, stub];
        targetBoard = stub;
        addedStub = true;
      } else if (relays.length && targetBoard.nostr) {
        const relayList = Array.from(new Set(relays));
        const existingRelays = targetBoard.nostr.relays || [];
        const sameRelays = relayList.length === existingRelays.length
          && relayList.every((relay, idx) => relay === existingRelays[idx]);
        if (!sameRelays) {
          const updatedBoard: Board = {
            ...targetBoard,
            nostr: { ...targetBoard.nostr, relays: relayList },
          } as Board;
          working = prev.map((b) => (b.id === targetBoard!.id ? updatedBoard : b));
          targetBoard = updatedBoard;
        }
      }

      const latestParent = working.find((b) => b.id === boardId && b.kind === "compound");
      if (!latestParent) return working;

      const alreadyAdded = latestParent.children.some((existingId) => {
        const normalizedExisting = normalizeCompoundChildId(working, existingId);
        return normalizedExisting === resolvedChildId;
      });
      if (alreadyAdded) {
        blocked = "duplicate";
        return working;
      }

      const nb: Board = { ...latestParent, children: [...latestParent.children, resolvedChildId] };
      updated = nb;
      return working.map((b) => {
        if (b.id === boardId && b.kind === "compound") return nb;
        return b;
      });
    });
    if (blocked === "self") {
      showToast("Cannot include a board within itself.");
    } else if (blocked === "duplicate") {
      showToast("Board already added.");
    } else if (blocked === "unsupported") {
      showToast("Only list boards can be added to a compound board.");
    } else if (addedStub) {
      showToast("Linked shared board. Columns will load automatically.");
    }
    if (updated?.nostr) setTimeout(() => onBoardChanged(boardId, { board: updated! }), 0);
  }

  function removeCompoundChild(boardId: string, childId: string) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "compound") return b;
      const targetId = normalizeCompoundChildId(prev, childId);
      const remaining = b.children.filter((id) => normalizeCompoundChildId(prev, id) !== targetId);
      if (remaining.length === b.children.length) return b;
      const nb: Board = { ...b, children: remaining };
      updated = nb;
      return nb;
    }));
    if (updated?.nostr) setTimeout(() => onBoardChanged(boardId, { board: updated! }), 0);
  }

  function reorderCompoundChild(boardId: string, dragId: string, targetId: string, before: boolean) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "compound") return b;
      if (dragId === targetId) return b;
      const children = [...b.children];
      const fromIndex = children.indexOf(dragId);
      const tgtIndex = children.indexOf(targetId);
      if (fromIndex === -1 || tgtIndex === -1) return b;
      const [item] = children.splice(fromIndex, 1);
      const insertIndex = before ? tgtIndex : tgtIndex + 1;
      children.splice(insertIndex, 0, item);
      const nb: Board = { ...b, children };
      updated = nb;
      return nb;
    }));
    if (updated?.nostr) setTimeout(() => onBoardChanged(boardId, { board: updated! }), 0);
  }

  function deleteBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const b = boards.find(x => x.id === id);
    if (!b) return;
    if (!confirm(`Delete board "${b.name}"? This will also remove its tasks.`)) return;
    const updatedCompounds: Board[] = [];
    setBoards(prev => {
      const filtered = prev.filter(x => x.id !== id);
      const cleaned = filtered.map((brd) => {
        if (brd.kind !== "compound" || !b) return brd;
        const remainingChildren = brd.children.filter((child) => !compoundChildMatchesBoard(child, b));
        if (remainingChildren.length === brd.children.length) return brd;
        const nb: Board = { ...brd, children: remainingChildren };
        if (nb.nostr) updatedCompounds.push(nb);
        return nb;
      });
      if (currentBoardId === id) {
        const newId = cleaned[0]?.id || "";
        changeBoard(newId);
      }
      return cleaned;
    });
    updatedCompounds.forEach((brd) => {
      setTimeout(() => onBoardChanged(brd.id, { board: brd }), 0);
    });
    setTasks(prev => prev.filter(t => t.boardId !== id));
    onClose();
  }

  // ─── Inner components ──────────────────────────────────────────────────────

  function ColumnItem({ boardId, column }: { boardId: string; column: ListColumn }) {
    const [overBefore, setOverBefore] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/column-id", column.id);
      e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/column-id");
      if (dragId) reorderColumn(boardId, dragId, column.id, overBefore);
      setOverBefore(false);
    }
    function handleDragLeave() { setOverBefore(false); }
    return (
      <li
        className="relative p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <div className="flex-1">{column.name}</div>
        <div className="flex gap-1">
          <button className="ghost-button button-sm pressable" onClick={()=>renameColumn(boardId, column.id)}>Rename</button>
          <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>deleteColumn(boardId, column.id)}>Delete</button>
        </div>
      </li>
    );
  }

  function CompoundChildItem({ parentId, childId }: { parentId: string; childId: string }) {
    const [overBefore, setOverBefore] = useState(false);
    const childBoard = findBoardByCompoundChildId(boards, childId) || null;
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/compound-child", JSON.stringify({ boardId: parentId, childId }));
      e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const raw = e.dataTransfer.getData("text/compound-child");
      try {
        const payload = JSON.parse(raw);
        if (payload?.boardId === parentId && typeof payload?.childId === "string") {
          reorderCompoundChild(parentId, payload.childId, childId, overBefore);
        }
      } catch {}
      setOverBefore(false);
    }
    function handleDragLeave() { setOverBefore(false); }
    const name = childBoard ? childBoard.name : "Unknown board";
    const idLabel = childBoard?.nostr?.boardId || childBoard?.id || childId;
    return (
      <li
        className="relative p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-primary truncate">{name}</div>
          <div className="text-xs text-secondary break-all">{idLabel}</div>
        </div>
        <div className="flex gap-1">
          <button
            className="ghost-button button-sm pressable"
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(idLabel);
                showToast("Copied board ID");
              } catch {
                showToast("Unable to copy board ID");
              }
            }}
            title="Copy board ID"
            aria-label="Copy board ID"
          >
            Copy ID
          </button>
          <button className="ghost-button button-sm pressable text-rose-400" onClick={() => removeCompoundChild(parentId, childId)}>Remove</button>
        </div>
      </li>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <Modal
      onClose={onClose}
      title="Manage board"
      actions={(
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="icon-button pressable"
            style={{ '--icon-size': '2.2rem' } as React.CSSProperties}
            data-active={board.hidden}
            aria-pressed={board.hidden}
            aria-label={board.hidden ? 'Unhide board' : 'Hide board'}
            title={board.hidden ? 'Unhide board' : 'Hide board'}
            onClick={() => setBoardHidden(board.id, !board.hidden)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-[16px] w-[16px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 12.5c2.4-3 5.4-4.5 8-4.5s5.6 1.5 8 4.5" />
              <path d="M6.5 15l1.6-1.6" />
              <path d="M12 15.5v-2.1" />
              <path d="M17.5 15l-1.6-1.6" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button pressable"
            style={{ '--icon-size': '2.2rem' } as React.CSSProperties}
            data-active={board.archived}
            aria-pressed={board.archived}
            aria-label={board.archived ? 'Unarchive board' : 'Archive board'}
            title={board.archived ? 'Unarchive board' : 'Archive board'}
            onClick={() => {
              if (board.archived) unarchiveBoard(board.id);
              else archiveBoard(board.id);
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-[16px] w-[16px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 7h15" />
              <rect x="5" y="7" width="14" height="12" rx="2" />
              <path d="M12 11v4" />
              <path d="M10.5 13.5L12 15l1.5-1.5" />
            </svg>
          </button>
        </div>
      )}
    >
      <input
        value={board.name}
        onChange={e => renameBoard(board.id, e.target.value)}
        className="pill-input w-full mb-4"
      />
      {board.kind === "lists" ? (
        <>
          <ul className="space-y-2">
            {board.columns.map(col => (
              <ColumnItem key={col.id} boardId={board.id} column={col} />
            ))}
          </ul>
          <div className="mt-2">
            <button className="accent-button button-sm pressable" onClick={()=>addColumn(board.id)}>Add list</button>
          </div>
          <div className="text-xs text-secondary mt-2">Tasks can be dragged between lists directly on the board.</div>
          <div className="mt-4">
            <div className="text-sm font-medium mb-2">List index card</div>
            <div className="flex gap-2">
              <button
                className={pillButtonClass(!!board.indexCardEnabled)}
                onClick={() => setBoardIndexCardEnabled(board.id, true)}
              >Show</button>
              <button
                className={pillButtonClass(!board.indexCardEnabled)}
                onClick={() => setBoardIndexCardEnabled(board.id, false)}
              >Hide</button>
            </div>
            <div className="text-xs text-secondary mt-2">
              Add a quick navigation card to jump to any list and keep it centered when opening the board.
            </div>
          </div>
        </>
      ) : board.kind === "compound" ? (
        <>
          <div className="space-y-2">
            {board.children.length ? (
              <ul className="space-y-2">
                {board.children.map((childId) => (
                  <CompoundChildItem key={childId} parentId={board.id} childId={childId} />
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-surface bg-surface-muted px-3 py-6 text-center text-sm text-secondary">
                Add boards to combine their lists into one view.
              </div>
            )}
          </div>
          <div className="mt-3 space-y-2">
            <div className="text-xs text-secondary">Add board ID</div>
            <div className="flex gap-2">
              <input
                value={newCompoundChildId}
                onChange={(e) => setNewCompoundChildId(e.target.value)}
                className="pill-input flex-1 min-w-0"
                placeholder="Shared board ID"
              />
              <button
                className="accent-button button-sm pressable"
                onClick={() => {
                  addCompoundChild(board.id, newCompoundChildId);
                  setNewCompoundChildId("");
                }}
              >Add</button>
            </div>
            {availableCompoundBoards.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {availableCompoundBoards.map((b) => (
                  <button
                    key={b.id}
                    className="ghost-button button-sm pressable"
                    onClick={() => addCompoundChild(board.id, b.id)}
                  >{b.name}</button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-4">
            <div className="text-sm font-medium mb-2">List index card</div>
            <div className="flex gap-2">
              <button
                className={pillButtonClass(!!board.indexCardEnabled)}
                onClick={() => setBoardIndexCardEnabled(board.id, true)}
              >Show</button>
              <button
                className={pillButtonClass(!board.indexCardEnabled)}
                onClick={() => setBoardIndexCardEnabled(board.id, false)}
              >Hide</button>
            </div>
            <div className="text-xs text-secondary mt-2">
              Quickly jump between lists across all linked boards.
            </div>
          </div>
          <div className="mt-4">
            <div className="text-sm font-medium mb-2">Board name labels</div>
            <div className="flex gap-2">
              <button
                className={pillButtonClass(!board.hideChildBoardNames)}
                onClick={() => setCompoundBoardHideChildNames(board.id, false)}
              >Show</button>
              <button
                className={pillButtonClass(!!board.hideChildBoardNames)}
                onClick={() => setCompoundBoardHideChildNames(board.id, true)}
              >Hide</button>
            </div>
            <div className="text-xs text-secondary mt-2">
              Hide the originating board names from list titles while viewing this compound board.
            </div>
          </div>
        </>
      ) : (
        <div className="text-xs text-secondary">The Week board has fixed columns (Sun–Sat).</div>
      )}

      <div className="mt-6">
        <div className="text-sm font-medium mb-2">Clear completed button</div>
        <div className="flex gap-2">
          <button
            className={pillButtonClass(!board.clearCompletedDisabled)}
            onClick={() => setBoardClearCompletedDisabled(board.id, false)}
          >Show</button>
          <button
            className={pillButtonClass(!!board.clearCompletedDisabled)}
            onClick={() => setBoardClearCompletedDisabled(board.id, true)}
          >Hide</button>
        </div>
        <div className="text-xs text-secondary mt-2">
          Hide the clear completed actions for this board. Completed tasks remain available in the Completed view.
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-sm font-medium">Sharing</div>
          <div className="ml-auto" />
          <button
            className="ghost-button button-sm pressable"
            onClick={()=>setShowAdvanced(a=>!a)}
          >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
        </div>
        <div className="space-y-2">
          {board.nostr ? (
            <>
              <div className="text-xs text-secondary">Board ID</div>
              <div className="flex gap-2 items-center">
                <input readOnly value={board.nostr.boardId}
                       className="pill-input flex-1 min-w-0"/>
                <button className="ghost-button button-sm pressable" onClick={async ()=>{ try { await navigator.clipboard?.writeText(board.nostr!.boardId); } catch {} }}>Copy</button>
                <button
                  className="ghost-button button-sm pressable"
                  onClick={() => onOpenSharePicker(board)}
                >
                  Share to contact
                </button>
              </div>
                {showAdvanced && (
                  <>
                    <div className="text-xs text-secondary">Board Nostr key (npub)</div>
                    <div className="flex gap-2 items-center">
                      <input
                        readOnly
                        value={boardKeyInfo?.npub || ""}
                        placeholder="Deriving board key…"
                        className="pill-input flex-1 min-w-0"
                      />
                      <button
                        className="ghost-button button-sm pressable"
                        disabled={!boardKeyInfo}
                        onClick={async ()=>{ if (!boardKeyInfo) return; try { await navigator.clipboard?.writeText(boardKeyInfo.npub); } catch {} }}
                      >Copy</button>
                    </div>
                    <div className="text-xs text-secondary">Board secret key (nsec)</div>
                    <div className="flex gap-2 items-center">
                      <input
                        readOnly
                        value={boardKeyInfo?.nsec || ""}
                        placeholder="Deriving board key…"
                        className="pill-input flex-1 min-w-0"
                      />
                      <button
                        className="ghost-button button-sm pressable"
                        disabled={!boardKeyInfo}
                        onClick={async ()=>{ if (!boardKeyInfo) return; try { await navigator.clipboard?.writeText(boardKeyInfo.nsec); } catch {} }}
                      >Copy</button>
                    </div>
                    <div className="text-xs text-secondary">Relays</div>
                    <div className="flex gap-2 mb-2">
                      <input
                        value={newBoardRelay}
                        onChange={(e)=>setNewBoardRelay(e.target.value)}
                        onKeyDown={(e)=>{ if (e.key === 'Enter' && board?.nostr) { const v = newBoardRelay.trim(); if (v && !(board.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === board.id ? ({...b, nostr: { boardId: board.nostr!.boardId, relays: [...(board.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } } }}
                        className="pill-input flex-1"
                        placeholder="wss://relay.example"
                      />
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={()=>{ if (!board?.nostr) return; const v = newBoardRelay.trim(); if (v && !(board.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === board.id ? ({...b, nostr: { boardId: board.nostr!.boardId, relays: [...(board.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } }}
                      >Add</button>
                    </div>
                    <ul className="space-y-2 mb-2">
                      {(board.nostr.relays || []).map((r) => (
                        <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                          <div className="flex-1 truncate">{r}</div>
                          <button
                            className="ghost-button button-sm pressable text-rose-400"
                            onClick={()=>{
                              if (!board?.nostr) return;
                              const relays = (board.nostr.relays || []).filter(x => x !== r);
                              setBoards(prev => prev.map(b => b.id === board.id ? ({...b, nostr: { boardId: board.nostr!.boardId, relays } }) : b));
                            }}
                          >Delete</button>
                        </li>
                      ))}
                    </ul>
                    <button
                      className="ghost-button button-sm pressable w-full justify-center"
                      onClick={cleanupStaleBoardEvents}
                      disabled={staleCleanupBusy}
                    >
                      {staleCleanupBusy ? "Cleaning stale events…" : "Clean up stale events"}
                    </button>
                    {staleCleanupMessage && (
                      <div className="text-xs text-secondary mt-1">{staleCleanupMessage}</div>
                    )}
                    <button className="ghost-button button-sm pressable" onClick={()=>onRegenerateBoardId(board.id)}>Generate new board ID</button>
                  </>
                )}
                <div className="flex gap-2">
                <button
                  className="ghost-button button-sm pressable"
                  onClick={()=>onBoardChanged(board.id, { republishTasks: true, board })}
                >Republish metadata</button>
                <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>{
                if (!board?.nostr) return;
                const impactedCompoundIds = boards
                  .filter(
                    (b) =>
                      b.kind === "compound" &&
                      !!b.nostr &&
                      b.children.some((childId) => compoundChildMatchesBoard(childId, board))
                  )
                  .map((b) => b.id);
                setBoards(prev => prev.map(b => {
                  if (b.id !== board.id) return b;
                  const clone = { ...b } as Board;
                  delete (clone as any).nostr;
                  return clone;
                }));
                if (impactedCompoundIds.length) {
                  setTimeout(() => {
                    impactedCompoundIds.forEach((boardId) => onBoardChanged(boardId));
                  }, 0);
                }
                }}>Stop sharing</button>
              </div>
            </>
          ) : (
            <>
              {showAdvanced && (
                <>
                  <div className="text-xs text-secondary">Relays override (optional)</div>
                  <div className="flex gap-2 mb-2">
                    <input
                      value={newOverrideRelay}
                      onChange={(e)=>setNewOverrideRelay(e.target.value)}
                      onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } } }}
                      className="pill-input flex-1"
                      placeholder="wss://relay.example"
                    />
                    <button className="ghost-button button-sm pressable" onClick={()=>{ const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } }}>Add</button>
                  </div>
                  <ul className="space-y-2 mb-2">
                    {parseCsv(relaysCsv).map((r) => (
                      <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                        <div className="flex-1 truncate">{r}</div>
                        <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>setRelaysCsv(removeRelayFromCsv(relaysCsv, r))}>Delete</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <button className="accent-button button-sm pressable w-full justify-center" onClick={()=>{onShareBoard(board.id, showAdvanced ? relaysCsv : ""); setRelaysCsv('');}}>Share this board</button>
            </>
          )}
          <button className="ghost-button button-sm pressable text-rose-400 mt-2 w-full justify-center" onClick={()=>deleteBoard(board.id)}>Delete board</button>
        </div>
      </div>
    </Modal>
  );
}
