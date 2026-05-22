import React from "react";
import type { Board } from "taskify-core";
import { ActionSheet } from "../../components/ActionSheet";
import { TrashDropZone } from "../dnd/TrashDropZone";

type SelectionMoveTarget = {
  id: string;
  name: string;
  kind: Board["kind"];
  columns: { id: string; name: string }[];
  children: string[];
};

type SelectionOverlaysProps = {
  boards: Board[];
  clearSelection: () => void;
  completeSelectedItems: () => void;
  deleteCalendarEvent: (id: string) => void;
  deleteSelectedItems: () => void;
  deleteTask: (id: string) => void;
  draggingEventId: string | null;
  draggingTaskId: string | null;
  exitSelectionMode: () => void;
  handleDragEnd: () => void;
  handlePrintSelectedTasks: () => void;
  isSelectionMode: boolean;
  moveSelectedTasksToBoard: (boardId: string) => void;
  moveSelectedTasksToColumn: (boardId: string, columnId: string) => void;
  selectedCount: number;
  selectedEventsLength: number;
  selectedIncompleteTaskCount: number;
  selectionMoveBoardId: string | null;
  selectionMoveSheetOpen: boolean;
  selectionMoveStep: "board" | "column";
  selectionMoveTargets: SelectionMoveTarget[];
  setSelectionMoveBoardId: (boardId: string | null) => void;
  setSelectionMoveSheetOpen: (open: boolean) => void;
  setSelectionMoveStep: (step: "board" | "column") => void;
  setTrashHover: (hovered: boolean) => void;
  trashHover: boolean;
};

export function SelectionOverlays({
  boards,
  clearSelection,
  completeSelectedItems,
  deleteCalendarEvent,
  deleteSelectedItems,
  deleteTask,
  draggingEventId,
  draggingTaskId,
  exitSelectionMode,
  handleDragEnd,
  handlePrintSelectedTasks,
  isSelectionMode,
  moveSelectedTasksToBoard,
  moveSelectedTasksToColumn,
  selectedCount,
  selectedEventsLength,
  selectedIncompleteTaskCount,
  selectionMoveBoardId,
  selectionMoveSheetOpen,
  selectionMoveStep,
  selectionMoveTargets,
  setSelectionMoveBoardId,
  setSelectionMoveSheetOpen,
  setSelectionMoveStep,
  setTrashHover,
  trashHover,
}: SelectionOverlaysProps) {
  const closeMoveSheet = () => {
    setSelectionMoveSheetOpen(false);
    setSelectionMoveStep("board");
    setSelectionMoveBoardId(null);
  };

  return (
    <>
      <ActionSheet
        open={selectionMoveSheetOpen}
        onClose={closeMoveSheet}
        title={selectionMoveStep === "column" ? "Choose a list" : "Move selected items"}
        stackLevel={10001}
      >
        {selectedCount === 0 ? (
          <div className="text-sm text-secondary">Select one or more items to move.</div>
        ) : selectionMoveStep === "board" ? (
          <div className="space-y-2">
            {selectionMoveTargets.map((board) => (
              <button
                key={board.id}
                type="button"
                className="contact-row pressable"
                onClick={() => {
                  if (board.kind === "lists" && board.columns.length > 1) {
                    setSelectionMoveBoardId(board.id);
                    setSelectionMoveStep("column");
                  } else if (board.kind === "compound" && board.children.length > 0) {
                    setSelectionMoveBoardId(board.id);
                    setSelectionMoveStep("column");
                  } else {
                    moveSelectedTasksToBoard(board.id);
                  }
                }}
              >
                <div className="contact-row__text">
                  <div className="contact-row__name">{board.name}</div>
                  <div className="contact-row__meta">
                    <span className="contact-row__meta-text capitalize">{board.kind}</span>
                    {board.kind === "lists" && board.columns.length > 0 && (
                      <span className="contact-row__meta-text"> · {board.columns.length} {board.columns.length === 1 ? "list" : "lists"}</span>
                    )}
                  </div>
                </div>
                {(board.kind === "lists" && board.columns.length > 1) || (board.kind === "compound" && board.children.length > 0) ? (
                  <span className="text-secondary text-xs ml-auto shrink-0">▸</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              className="ghost-button button-sm pressable mb-2"
              onClick={() => {
                setSelectionMoveStep("board");
                setSelectionMoveBoardId(null);
              }}
            >
              ← Back
            </button>
            {(() => {
              const board = selectionMoveTargets.find((candidate) => candidate.id === selectionMoveBoardId);
              if (!board) return null;
              if (board.kind === "compound") {
                return board.children.map((childId) => {
                  const childBoard = boards.find((candidate) => candidate.id === childId);
                  if (!childBoard || childBoard.kind !== "lists") return null;
                  return childBoard.columns.map((col) => (
                    <button
                      key={`${childBoard.id}-${col.id}`}
                      type="button"
                      className="contact-row pressable"
                      onClick={() => moveSelectedTasksToColumn(childBoard.id, col.id)}
                    >
                      <div className="contact-row__text">
                        <div className="contact-row__name">{col.name}</div>
                        <div className="contact-row__meta">
                          <span className="contact-row__meta-text">{childBoard.name}</span>
                        </div>
                      </div>
                    </button>
                  ));
                });
              }
              if (board.kind === "lists") {
                return board.columns.map((col) => (
                  <button
                    key={col.id}
                    type="button"
                    className="contact-row pressable"
                    onClick={() => moveSelectedTasksToColumn(board.id, col.id)}
                  >
                    <div className="contact-row__text">
                      <div className="contact-row__name">{col.name}</div>
                    </div>
                  </button>
                ));
              }
              return null;
            })()}
          </div>
        )}
      </ActionSheet>

      <TrashDropZone
        visible={!!(draggingTaskId || draggingEventId)}
        hovered={trashHover}
        setHovered={setTrashHover}
        onDragEnd={handleDragEnd}
        deleteTask={deleteTask}
        deleteCalendarEvent={deleteCalendarEvent}
        isSelectionMode={isSelectionMode}
        exitSelectionMode={exitSelectionMode}
      />

      {isSelectionMode && (
        <div
          className="selection-bar glass-panel fixed left-1/2 z-[10000] -translate-x-1/2 w-[calc(100%-1rem)] max-w-md rounded-2xl"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--app-tab-pill-height) + 0.25rem)" }}
        >
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
            <div className="text-sm font-semibold text-primary">
              {selectedCount ? `${selectedCount} selected` : "Select items"}
            </div>
            <button
              type="button"
              className="text-xs text-secondary hover:text-primary pressable px-2 py-0.5 rounded-lg"
              onClick={exitSelectionMode}
            >
              Cancel
            </button>
          </div>
          <div className="flex items-center justify-around px-2 pb-2.5 pt-0.5">
            <SelectionAction label="Clear" title="Clear selection" disabled={!selectedCount} onClick={clearSelection}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </SelectionAction>
            <SelectionAction label="Move" title="Move" disabled={!selectedCount} onClick={() => setSelectionMoveSheetOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l3 3 3-3"/><path d="M19 9l3 3-3 3"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
            </SelectionAction>
            <SelectionAction label="Done" title="Complete" disabled={selectedIncompleteTaskCount === 0} onClick={completeSelectedItems}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </SelectionAction>
            <SelectionAction
              label="Print"
              title="Print selected"
              disabled={!selectedEventsLength && selectedIncompleteTaskCount === 0}
              onClick={handlePrintSelectedTasks}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            </SelectionAction>
            <SelectionAction label="Delete" title="Delete" disabled={!selectedCount} onClick={deleteSelectedItems} danger>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 1h5v2H3V4h5l1-1z"/><path d="M5 7h14l-1.5 13h-11L5 7z"/></svg>
            </SelectionAction>
          </div>
        </div>
      )}
    </>
  );
}

function SelectionAction({
  children,
  danger,
  disabled,
  label,
  onClick,
  title,
}: React.PropsWithChildren<{
  danger?: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  title: string;
}>) {
  return (
    <button
      type="button"
      className={`selection-bar__action${danger ? " selection-bar__action--danger" : ""} pressable`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
