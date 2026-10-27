import { useState, type DragEvent } from "react";
import type { Board } from "../../domains/tasks/taskTypes";

function BoardGlyph({ kind }: { kind: Board["kind"] }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "rail-boards__glyph" };
  if (kind === "week") {
    return (
      <svg {...common}>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M4 10h16M9 3v4M15 3v4" />
      </svg>
    );
  }
  if (kind === "bible") {
    return (
      <svg {...common}>
        <path d="M6 4h11a1 1 0 0 1 1 1v15H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Z" />
        <path d="M12 8v6M9.5 10.5h5" />
      </svg>
    );
  }
  if (kind === "compound") {
    return (
      <svg {...common}>
        <rect x="4" y="4" width="11" height="11" rx="2" />
        <path d="M9 20h9a2 2 0 0 0 2-2V9" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4" y="4" width="5" height="16" rx="1.5" />
      <rect x="11" y="4" width="5" height="11" rx="1.5" />
      <path d="M18 4h1a1 1 0 0 1 1 1v7" />
    </svg>
  );
}

/**
 * The boards in the desktop rail: one click opens a board, and a task dragged onto a board moves
 * there. Hidden on phones, where the board picker in the header does this job (CSS).
 */
export function RailBoardList({
  boards,
  currentBoardId,
  boardsPageActive,
  dragging,
  onSelect,
  onAdd,
  onDropTasks,
}: {
  boards: Board[];
  currentBoardId: string;
  boardsPageActive: boolean;
  /** A task is being dragged, so boards accept drops. */
  dragging: boolean;
  onSelect: (boardId: string) => void;
  onAdd: () => void;
  onDropTasks: (boardId: string, dataTransfer: DataTransfer) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const dropHandlers = (board: Board) => (board.kind === "bible" ? {} : {
    onDragOver: (event: DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      if (dropTarget !== board.id) setDropTarget(board.id);
    },
    onDragLeave: () => setDropTarget((current) => (current === board.id ? null : current)),
    onDrop: (event: DragEvent) => {
      setDropTarget(null);
      if (!dragging) return;
      event.preventDefault();
      onDropTasks(board.id, event.dataTransfer);
    },
  });

  return (
    <section className="rail-boards" aria-label="Boards">
      <div className="rail-boards__heading">
        <span>Boards</span>
        <button type="button" className="rail-boards__add pressable" onClick={onAdd} aria-label="New board" title="New board">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="rail-boards__list">
        {boards.length === 0 ? (
          <div className="rail-boards__empty">No boards yet</div>
        ) : (
          boards.map((board) => {
            const current = boardsPageActive && board.id === currentBoardId;
            return (
              <button
                key={board.id}
                type="button"
                className={`rail-boards__item pressable${current ? " is-current" : ""}${dropTarget === board.id ? " is-drop-target" : ""}`}
                onClick={() => onSelect(board.id)}
                aria-current={current ? "page" : undefined}
                title={board.name}
                {...dropHandlers(board)}
              >
                <BoardGlyph kind={board.kind} />
                <span className="rail-boards__name">{board.name}</span>
                {board.nostr?.boardId && <span className="rail-boards__shared" title="Shared board" aria-label="Shared" />}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
