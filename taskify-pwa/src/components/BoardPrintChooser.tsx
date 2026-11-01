import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import type { BoardPrintListChoice, BoardPrintScope } from "./BoardPrintLayout";

export function BoardPrintChooser({
  open,
  boardName,
  lists,
  selectedCount,
  includeCompleted,
  onClose,
  onContinue,
}: {
  open: boolean;
  boardName: string;
  lists: BoardPrintListChoice[];
  selectedCount: number;
  includeCompleted: boolean;
  onClose: () => void;
  onContinue: (scope: BoardPrintScope) => void;
}) {
  const [kind, setKind] = useState<BoardPrintScope["kind"]>("board");
  const [selectedListIds, setSelectedListIds] = useState<Set<string>>(() => new Set(lists.map((list) => list.id)));

  useEffect(() => {
    if (!open) return;
    setKind("board");
    setSelectedListIds(new Set(lists.map((list) => list.id)));
  }, [lists, open]);

  const canContinue = useMemo(() => {
    if (kind === "board" || kind === "selection") return true;
    return selectedListIds.size > 0;
  }, [kind, selectedListIds]);

  if (!open) return null;

  const toggleList = (listId: string) => {
    setSelectedListIds((previous) => {
      const next = new Set(previous);
      if (next.has(listId)) next.delete(listId);
      else next.add(listId);
      return next;
    });
  };

  const continuePrint = () => {
    if (!canContinue) return;
    if (kind === "lists") onContinue({ kind, listIds: lists.map((list) => list.id).filter((id) => selectedListIds.has(id)) });
    else onContinue({ kind });
  };

  return (
    <Modal
      onClose={onClose}
      title={`Print ${boardName || "board"}`}
      actions={(
        <>
          <button type="button" className="ghost-button button-sm pressable" onClick={onClose}>Cancel</button>
          <button type="button" className="accent-button button-sm pressable" onClick={continuePrint} disabled={!canContinue}>
            Continue
          </button>
        </>
      )}
    >
      <div className="board-print-chooser space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-primary">What should be printed?</legend>
          <label className="board-print-chooser__option">
            <input type="radio" name="board-print-scope" checked={kind === "board"} onChange={() => setKind("board")} />
            <span><strong>Entire board</strong><small>Every visible list and task in board order.</small></span>
          </label>
          <label className={`board-print-chooser__option${lists.length ? "" : " is-disabled"}`}>
            <input
              type="radio"
              name="board-print-scope"
              checked={kind === "lists"}
              disabled={!lists.length}
              onChange={() => setKind("lists")}
            />
            <span><strong>Choose lists</strong><small>Print one or more lists or weekdays.</small></span>
          </label>
          {selectedCount > 0 && (
            <label className="board-print-chooser__option">
              <input type="radio" name="board-print-scope" checked={kind === "selection"} onChange={() => setKind("selection")} />
              <span><strong>Selected items</strong><small>{selectedCount} selected task{selectedCount === 1 ? "" : "s"} or event{selectedCount === 1 ? "" : "s"}.</small></span>
            </label>
          )}
        </fieldset>

        {kind === "lists" && (
          <fieldset className="board-print-chooser__lists">
            <legend className="text-xs font-semibold uppercase tracking-wide text-secondary">Lists</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {lists.map((list) => (
                <label key={list.id} className="board-print-chooser__list">
                  <input
                    type="checkbox"
                    checked={selectedListIds.has(list.id)}
                    onChange={() => toggleList(list.id)}
                  />
                  <span>{list.label}</span>
                </label>
              ))}
            </div>
            {!selectedListIds.size && <div className="text-xs text-rose-400">Select at least one list.</div>}
          </fieldset>
        )}

        <div className="board-print-chooser__note text-xs text-secondary">
          {includeCompleted
            ? "Completed tasks are included because the Completed tab is enabled."
            : "Only incomplete tasks will print. Enable the Completed tab in View settings to include completed tasks."}
        </div>
      </div>
    </Modal>
  );
}
