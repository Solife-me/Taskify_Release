import { useState } from "react";
import type { Board } from "taskify-core";
import { ActionSheet } from "./ActionSheet";

export type SharedTaskDestination = { boardId: string; columnId?: string };

export function SharedTaskDestinationSheet({ boards, initialBoardId, title, onClose, onConfirm }: {
  boards: Board[];
  initialBoardId?: string;
  title: string;
  onClose: () => void;
  onConfirm: (destination: SharedTaskDestination) => void;
}) {
  const available = boards.filter((board) => !board.archived && !board.hidden && board.kind !== "bible");
  const [boardId, setBoardId] = useState(() => available.find((board) => board.id === initialBoardId)?.id ?? available[0]?.id ?? "");
  const [listKey, setListKey] = useState("");
  const board = available.find((entry) => entry.id === boardId);
  const sources = board?.kind === "lists" ? [board] : board?.kind === "compound"
    ? [...new Set(board.children.map((id) => boards.find((child) => id === child.id || id === child.nostr?.boardId)))]
      .filter((child): child is Board => !!child && child.kind === "lists" && !child.archived && !child.hidden) : [];
  const lists = sources.flatMap((source) => source.kind === "lists" ? source.columns.map((column) => ({
    key: JSON.stringify([source.id, column.id]),
    label: board?.kind === "compound" ? `${source.name} • ${column.name}` : column.name,
    destination: { boardId: source.id, columnId: column.id },
  })) : []);
  const selectedList = lists.find((list) => list.key === listKey) ?? lists[0];
  const destination = board?.kind === "week" ? { boardId: board.id } : selectedList?.destination;

  return (
    <ActionSheet open onClose={onClose} title="Add task to board" stackLevel={20000}>
      <form className="space-y-4" role="dialog" aria-label="Choose task destination" aria-modal="true"
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        onSubmit={(event) => { event.preventDefault(); if (destination) onConfirm(destination); }}>
        <p className="font-semibold">{title}</p>
        <label className="block space-y-2">
          <span>Board</span>
          <select autoFocus className="w-full pill-select" value={boardId} onChange={(event) => { setBoardId(event.target.value); setListKey(""); }}>
            {!available.length && <option value="">No task boards available</option>}
            {available.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        {board && board.kind !== "week" && (
          <label className="block space-y-2">
            <span>List</span>
            <select className="w-full pill-select" value={selectedList?.key ?? ""} onChange={(event) => setListKey(event.target.value)}>
              {!lists.length && <option value="">No lists available</option>}
              {lists.map((list) => <option key={list.key} value={list.key}>{list.label}</option>)}
            </select>
          </label>
        )}
        {board?.kind === "week" && <p className="text-secondary text-sm">Added on the task’s due date, or today if no date is set.</p>}
        {!destination && <p className="text-secondary text-sm">Choose a task board with an available list, or a week board.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="accent-button" disabled={!destination}>Add Task</button>
        </div>
      </form>
    </ActionSheet>
  );
}
