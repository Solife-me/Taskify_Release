/** Small pieces shared by the board views. */
import type { ListColumn } from "../../domains/tasks/taskTypes";

/** The "New Task" field at the foot of a day or list. */
export type InlineAdd = {
  titles: Record<string, string>;
  setTitle: (key: string, value: string) => void;
  add: (key: string) => void;
  setInputRef: (key: string, element: HTMLInputElement | null) => void;
};

/** Selecting every item in a day or list while selection mode is on. */
export type GroupSelection = {
  active: boolean;
  toggle: (ids: string[]) => void;
  stateOf: (ids: string[]) => "none" | "some" | "all";
  exit: () => void;
};

/** A compound board's lists, grouped by the child board they come from. */
export type CompoundIndexGroup = { key: string; boardName: string; columns: ListColumn[] };

export function InlineAddTaskForm({ columnKey, inlineAdd }: { columnKey: string; inlineAdd: InlineAdd }) {
  return (
    <form
      className="mt-2 flex gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        inlineAdd.add(columnKey);
      }}
    >
      <input
        ref={(element) => inlineAdd.setInputRef(columnKey, element)}
        value={inlineAdd.titles[columnKey] || ""}
        onChange={(event) => inlineAdd.setTitle(columnKey, event.target.value)}
        className="pill-input pill-input--compact flex-1 min-w-0"
        placeholder="New Task"
      />
      <button type="submit" className="accent-button accent-button--circle pressable shrink-0" aria-label="Add task">
        <span aria-hidden="true">+</span>
        <span className="sr-only">Add task</span>
      </button>
    </form>
  );
}
