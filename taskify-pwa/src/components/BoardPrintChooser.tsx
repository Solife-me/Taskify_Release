import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import type { BoardPrintListChoice, BoardPrintOptions, BoardPrintScope } from "./BoardPrintLayout";

export function BoardPrintChooser({
  open,
  boardName,
  lists,
  selectedCount,
  defaults,
  onClose,
  onContinue,
}: {
  open: boolean;
  boardName: string;
  lists: BoardPrintListChoice[];
  selectedCount: number;
  defaults: BoardPrintOptions;
  onClose: () => void;
  onContinue: (scope: BoardPrintScope, options: BoardPrintOptions) => void;
}) {
  const [kind, setKind] = useState<BoardPrintScope["kind"]>("board");
  const [selectedListIds, setSelectedListIds] = useState<Set<string>>(() => new Set(lists.map((list) => list.id)));
  const [options, setOptions] = useState<BoardPrintOptions>(defaults);

  useEffect(() => {
    if (!open) return;
    setKind("board");
    setSelectedListIds(new Set(lists.map((list) => list.id)));
    setOptions(defaults);
  }, [defaults, lists, open]);

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

  const setOption = (key: keyof BoardPrintOptions, value: boolean) => {
    setOptions((previous) => ({ ...previous, [key]: value }));
  };

  const continuePrint = () => {
    if (!canContinue) return;
    if (kind === "lists") onContinue({ kind, listIds: lists.map((list) => list.id).filter((id) => selectedListIds.has(id)) }, options);
    else onContinue({ kind }, options);
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

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-primary">Include</legend>
          <label className="board-print-chooser__option">
            <input
              type="checkbox"
              checked={options.includeUpcoming}
              onChange={(event) => setOption("includeUpcoming", event.target.checked)}
            />
            <span><strong>Upcoming tasks</strong><small>Tasks scheduled for a future date that the board is holding back.</small></span>
          </label>
          <label className="board-print-chooser__option">
            <input
              type="checkbox"
              checked={options.includeCompleted}
              onChange={(event) => setOption("includeCompleted", event.target.checked)}
            />
            <span><strong>Completed tasks</strong><small>Tasks you have already checked off.</small></span>
          </label>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-primary">Details</legend>
          <label className="board-print-chooser__option">
            <input
              type="checkbox"
              checked={options.includeNotes}
              onChange={(event) => setOption("includeNotes", event.target.checked)}
            />
            <span><strong>Notes</strong><small>Print the start of each note on its own line under the title.</small></span>
          </label>
          <label className="board-print-chooser__option">
            <input
              type="checkbox"
              checked={options.includeDue}
              onChange={(event) => setOption("includeDue", event.target.checked)}
            />
            <span><strong>Due date and time</strong><small>Print when each task or event is due.</small></span>
          </label>
          <label className="board-print-chooser__option">
            <input
              type="checkbox"
              checked={options.includeSubtasks}
              onChange={(event) => setOption("includeSubtasks", event.target.checked)}
            />
            <span><strong>Subtasks</strong><small>Print each subtask on its own line, ticked when complete.</small></span>
          </label>
          <label className="board-print-chooser__option">
            <input
              type="checkbox"
              checked={options.includePhotos}
              onChange={(event) => setOption("includePhotos", event.target.checked)}
            />
            <span><strong>Photos</strong><small>Print a small thumbnail of up to three photo attachments.</small></span>
          </label>
        </fieldset>

        <div className="board-print-chooser__note text-xs text-secondary">
          {options.includeSubtasks || options.includePhotos
            ? "Tasks with subtasks or photos print taller, so fewer fit on each page. Long notes are shortened to fit."
            : options.includeNotes || options.includeDue
              ? "Details print as a small line under each title. Long notes are shortened to fit."
              : "Turn on Notes or Due date and time to print details under each title."}
        </div>
      </div>
    </Modal>
  );
}
