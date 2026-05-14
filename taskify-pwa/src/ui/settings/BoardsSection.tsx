// @ts-nocheck
import React, { useState, useEffect, useMemo, useRef } from "react";
import type { Board, Task } from "../../domains/tasks/taskTypes";
import { compoundChildMatchesBoard, withBoardOrder } from "../../domains/tasks/boardUtils";
import { useToast } from "../../context/ToastContext";
import { Modal } from "../Modal";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";
import { BIBLE_BOARD_ID, BOARD_ID_REGEX } from "./settingsConstants";

export function BoardsSection({
  boards,
  currentBoardId,
  setBoards,
  setTasks,
  changeBoard,
  shouldReloadForNavigation,
  onJoinBoard,
  onBoardChanged,
  onManageBoard,
  onClose,
  defaultRelays,
}: {
  boards: Board[];
  currentBoardId: string;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  changeBoard: (id: string) => void;
  shouldReloadForNavigation: () => boolean;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
  onBoardChanged: (boardId: string, options?: { republishTasks?: boolean; board?: Board }) => void;
  onManageBoard: (id: string) => void;
  onClose: () => void;
  defaultRelays: string[];
}) {
  const { show: showToast } = useToast();
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardType, setNewBoardType] = useState<"lists" | "compound">("lists");
  const [showArchivedBoards, setShowArchivedBoards] = useState(false);
  const [archiveDropActive, setArchiveDropActive] = useState(false);
  const boardListRef = useRef<HTMLUListElement>(null);
  const [boardListMaxHeight, setBoardListMaxHeight] = useState<number | null>(null);

  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);
  const unarchivedBoards = useMemo(() => boards.filter(b => !b.archived), [boards]);
  const archivedBoards = useMemo(() => boards.filter(b => b.archived), [boards]);

  // ─── ResizeObserver for board list height ─────────────────────────────────
  useEffect(() => {
    const listEl = boardListRef.current;
    if (!listEl) return;

    function computeHeight() {
      const currentList = boardListRef.current;
      if (!currentList) return;
      const items = Array.from(currentList.children) as HTMLElement[];
      if (items.length === 0) {
        setBoardListMaxHeight(null);
        return;
      }
      const firstRect = items[0].getBoundingClientRect();
      if (firstRect.height === 0) {
        setBoardListMaxHeight(null);
        return;
      }
      let step = firstRect.height;
      if (items.length > 1) {
        const secondRect = items[1].getBoundingClientRect();
        const diff = secondRect.top - firstRect.top;
        if (diff > 0) step = diff;
      }
      const lastRect = items[items.length - 1].getBoundingClientRect();
      const totalHeight = lastRect.bottom - firstRect.top;
      const limit = step * 5.5;
      if (totalHeight <= limit) {
        setBoardListMaxHeight(null);
        return;
      }
      setBoardListMaxHeight(limit);
    }

    computeHeight();

    const handleResize = () => computeHeight();
    window.addEventListener("resize", handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => computeHeight());
      resizeObserver.observe(listEl);
      Array.from(listEl.children).forEach((child) => resizeObserver!.observe(child));
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
    };
  }, [unarchivedBoards]);

  // ─── Board CRUD ───────────────────────────────────────────────────────────

  function addBoard() {
    if (shouldReloadForNavigation()) return;
    const name = newBoardName.trim();
    if (!name) return;
    if (BOARD_ID_REGEX.test(name)) {
      onJoinBoard(name);
      setNewBoardName("");
      return;
    }
    const id = crypto.randomUUID();
    const nostrBoardId = crypto.randomUUID();
    const relayList = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
    let board: Board;
    if (newBoardType === "compound") {
      board = {
        id,
        name,
        kind: "compound",
        children: [],
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
        hideChildBoardNames: false,
        nostr: { boardId: nostrBoardId, relays: relayList },
      };
    } else {
      board = {
        id,
        name,
        kind: "lists",
        columns: [{ id: crypto.randomUUID(), name: "List 1" }],
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
        nostr: { boardId: nostrBoardId, relays: relayList },
      };
    }
    setBoards(prev => withBoardOrder([...prev, board]));
    setNewBoardName("");
    changeBoard(id);
    setNewBoardType("lists");
    setTimeout(() => onBoardChanged(board.id, { board }), 0);
    showToast("Board created & synced");
  }

  function archiveBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const board = boards.find(x => x.id === id);
    if (!board || board.archived) return;
    const remainingUnarchived = boards.filter(b => b.id !== id && !b.archived);
    if (remainingUnarchived.length === 0) {
      alert("At least one board must remain unarchived.");
      return;
    }
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: true } : b));
    if (currentBoardId === id) {
      const nextVisible = boards.find(b => b.id !== id && !b.archived && !b.hidden);
      const fallback = remainingUnarchived[0];
      changeBoard((nextVisible ?? fallback)?.id || "");
    }
  }

  function unarchiveBoard(id: string) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: false } : b));
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
      const cleaned = filtered.map((board) => {
        if (board.kind !== "compound" || !b) return board;
        const remainingChildren = board.children.filter((child) => !compoundChildMatchesBoard(child, b));
        if (remainingChildren.length === board.children.length) return board;
        const nb: Board = { ...board, children: remainingChildren };
        if (nb.nostr) updatedCompounds.push(nb);
        return nb;
      });
      if (currentBoardId === id) {
        const newId = cleaned[0]?.id || "";
        changeBoard(newId);
      }
      return withBoardOrder(cleaned);
    });
    updatedCompounds.forEach((board) => {
      setTimeout(() => onBoardChanged(board.id, { board }), 0);
    });
    setTasks(prev => prev.filter(t => t.boardId !== id));
  }

  function reorderBoards(dragId: string, targetId: string, before: boolean) {
    setBoards(prev => {
      const list = [...prev];
      const fromIndex = list.findIndex(b => b.id === dragId);
      if (fromIndex === -1) return prev;
      const [item] = list.splice(fromIndex, 1);
      let targetIndex = list.findIndex(b => b.id === targetId);
      if (targetIndex === -1) return prev;
      if (!before) targetIndex++;
      list.splice(targetIndex, 0, item);
      return withBoardOrder(list);
    });
  }

  function openHiddenBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const board = boards.find(x => x.id === id && !x.archived && x.hidden);
    if (!board) return;
    changeBoard(id);
    onClose();
  }

  function openArchivedBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const board = boards.find(x => x.id === id && x.archived);
    if (!board) return;
    changeBoard(id);
    setShowArchivedBoards(false);
    onClose();
  }

  function setBoardHidden(id: string, hidden: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => (b.id === id ? { ...b, hidden } : b)));
  }

  // ─── Inner components ─────────────────────────────────────────────────────

  function HiddenBoardIcon() {
    return (
      <svg
        className="w-4 h-4 text-secondary"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z" />
        <path d="M3 3l18 18" />
      </svg>
    );
  }

  function BoardListItem({
    board,
    hidden,
    onPrimaryAction,
    onDrop,
    onEdit,
  }: {
    board: Board;
    hidden: boolean;
    onPrimaryAction: () => void;
    onDrop: (dragId: string, before: boolean) => void;
    onEdit?: () => void;
  }) {
    const [overBefore, setOverBefore] = useState(false);
    const [dragging, setDragging] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/board-id", board.id);
      e.dataTransfer.effectAllowed = "move";
      setDragging(true);
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/board-id");
      if (dragId) onDrop(dragId, overBefore);
      setOverBefore(false);
      setDragging(false);
    }
    function handleDragLeave() {
      setOverBefore(false);
    }
    function handleDragEnd() {
      setDragging(false);
      setOverBefore(false);
    }
    function handleClick() {
      if (dragging) return;
      onPrimaryAction();
    }
    const buttonClasses = hidden
      ? "flex-1 text-left min-w-0 text-secondary hover:text-primary transition-colors"
      : "flex-1 text-left min-w-0";
    return (
      <li
        className="board-list-item"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
        onDragEnd={handleDragEnd}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <button type="button" className={buttonClasses} onClick={handleClick}>
          <span className="flex items-center gap-2">
            {hidden && (
              <span className="shrink-0" aria-hidden="true">
                <HiddenBoardIcon />
              </span>
            )}
            <span className="truncate">{board.name}</span>
            {hidden && <span className="sr-only">Hidden board</span>}
          </span>
        </button>
        {hidden && onEdit && (
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragging) return;
              onEdit();
            }}
          >
            Edit
          </button>
        )}
      </li>
    );
  }

  // ─── Archive drag handlers ────────────────────────────────────────────────

  function isBoardDrag(event: React.DragEvent) {
    return Array.from(event.dataTransfer.types).includes("text/board-id");
  }

  function handleArchiveButtonDragEnter(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    setArchiveDropActive(true);
  }

  function handleArchiveButtonDragOver(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setArchiveDropActive(true);
  }

  function handleArchiveButtonDragLeave() {
    setArchiveDropActive(false);
  }

  function handleArchiveButtonDrop(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setArchiveDropActive(false);
    const id = e.dataTransfer.getData("text/board-id");
    if (id) archiveBoard(id);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <section className="wallet-section space-y-3">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-sm font-medium">Boards & Lists</div>
        </div>
        <ul
          ref={boardListRef}
          className="space-y-2 mb-3 overflow-y-auto pr-1"
          style={boardListMaxHeight != null ? { maxHeight: `${boardListMaxHeight}px` } : undefined}
        >
          {unarchivedBoards.map((b) => (
            <BoardListItem
              key={b.id}
              board={b}
              hidden={!!b.hidden}
              onPrimaryAction={
                b.kind === "bible"
                  ? () => {}
                  : b.hidden
                    ? () => openHiddenBoard(b.id)
                    : () => onManageBoard(b.id)
              }
              onEdit={b.hidden && b.kind !== "bible" ? () => onManageBoard(b.id) : undefined}
              onDrop={(dragId, before) => reorderBoards(dragId, b.id, before)}
            />
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <input
            value={newBoardName}
            onChange={e=>setNewBoardName(e.target.value)}
            placeholder="Board name or ID"
            className="pill-input flex-1 min-w-0"
          />
          <button
            className="accent-button pressable shrink-0 sm:self-stretch"
            onClick={addBoard}
          >
            Create/Join
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <button
            className={`pressable px-3 py-2 rounded-xl bg-surface-muted transition ${archiveDropActive ? "ring-2 ring-emerald-500" : ""}`}
            onClick={() => setShowArchivedBoards(true)}
            onDragEnter={handleArchiveButtonDragEnter}
            onDragOver={handleArchiveButtonDragOver}
            onDragLeave={handleArchiveButtonDragLeave}
            onDrop={handleArchiveButtonDrop}
          >
            Archived
          </button>
          <label className="flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={newBoardType === "compound"}
              onChange={(e) => setNewBoardType(e.target.checked ? "compound" : "lists")}
              className="h-4 w-4"
            />
            Create as compound board
          </label>
        </div>
      </section>

      {showArchivedBoards && (
        <Modal onClose={() => setShowArchivedBoards(false)} title="Archived boards">
          {archivedBoards.length === 0 ? (
            <div className="text-sm text-secondary">No archived boards.</div>
          ) : (
            <ul className="space-y-2">
              {archivedBoards.map((b) => (
                <li
                  key={b.id}
                  className="bg-surface-muted border border-surface rounded-2xl p-3 flex items-center gap-2 cursor-pointer transition hover:bg-surface-highlight"
                  role="button"
                  tabIndex={0}
                  onClick={() => openArchivedBoard(b.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openArchivedBoard(b.id);
                    }
                  }}
                >
                  <div className="flex-1 truncate">{b.name}</div>
                  <div className="flex gap-2">
                    <button
                      className="accent-button button-sm pressable"
                      onClick={(e) => {
                        e.stopPropagation();
                        unarchiveBoard(b.id);
                      }}
                    >
                      Unarchive
                    </button>
                    <button
                      className="ghost-button button-sm pressable text-rose-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBoard(b.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </>
  );
}
