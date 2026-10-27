import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { Board, CalendarEvent, ListColumn, Task } from "../../domains/tasks/taskTypes";
import { BoardEventCard, BoardTaskCard, useTaskActions } from "../task/taskActions";
import { InlineAddTaskForm, type CompoundIndexGroup, type GroupSelection, type InlineAdd } from "./BoardViewParts";
import { DroppableColumn } from "./DroppableColumn";

/** Renaming a list in place. */
export type ListRename = {
  renamingColumnId: string | null;
  drafts: Record<string, string>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  commit: (columnId: string) => void;
  cancel: (columnId: string) => void;
  setInputRef: (columnId: string, element: HTMLInputElement | null) => void;
};

function IndexButton({
  active,
  title,
  label,
  order,
  onClick,
}: {
  active: boolean;
  title: string;
  label: string;
  order: number;
  onClick: () => void;
}) {
  const stateClass = active
    ? "border-accent/60 bg-accent/15 text-primary"
    : "border-surface bg-surface-muted text-secondary hover:bg-surface hover:text-primary";
  return (
    <button
      type="button"
      className={`pressable flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition ${stateClass}`}
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      title={title}
    >
      <span className="truncate">{label}</span>
      <span className={active ? "text-xs text-primary/80" : "text-xs text-secondary"}>{order}</span>
    </button>
  );
}

/** The optional "Index" column: jump to any list (grouped by child board on a compound board). */
function ListIndex({
  board,
  listColumns,
  compoundIndexGroups,
  listColumnSources,
  focusedColumnId,
  onFocusColumn,
  setColumnRef,
}: {
  board: Board;
  listColumns: ListColumn[];
  compoundIndexGroups: CompoundIndexGroup[];
  listColumnSources: Map<string, { boardName: string }>;
  focusedColumnId: unknown;
  onFocusColumn: (columnId: string) => void;
  setColumnRef: (key: string, element: HTMLDivElement | null) => void;
}) {
  let content: ReactNode;
  if (listColumns.length === 0) {
    content = (
      <div className="rounded-lg border border-dashed border-surface bg-surface-muted px-3 py-6 text-center text-sm text-secondary">
        No lists yet.
      </div>
    );
  } else if (board.kind === "compound") {
    let position = 0;
    content = compoundIndexGroups.map((group, groupIndex) => (
      <div key={group.key} className="space-y-1.5" data-group-index={groupIndex}>
        {!board.hideChildBoardNames && (
          <div className={`px-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-secondary/70 ${groupIndex > 0 ? "mt-2" : ""}`}>
            {group.boardName}
          </div>
        )}
        {group.columns.map((column) => {
          position += 1;
          const source = listColumnSources.get(column.id);
          return (
            <IndexButton
              key={column.id}
              active={focusedColumnId === column.id}
              title={source ? `${source.boardName} • ${column.name}` : column.name}
              label={column.name}
              order={position}
              onClick={() => onFocusColumn(column.id)}
            />
          );
        })}
      </div>
    ));
  } else {
    content = listColumns.map((column, index) => (
      <IndexButton
        key={column.id}
        active={focusedColumnId === column.id}
        title={column.name}
        label={column.name}
        order={index + 1}
        onClick={() => onFocusColumn(column.id)}
      />
    ));
  }
  return (
    <div ref={(element) => setColumnRef("list-index", element)} className="board-column surface-panel w-[325px] shrink-0 p-3 flex h-full flex-col">
      <div className="mb-3 text-sm font-semibold tracking-wide text-secondary">Index</div>
      <div className="flex flex-1 min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">{content}</div>
    </div>
  );
}

function RenameListForm({ column, rename }: { column: ListColumn; rename: ListRename }) {
  return (
    <form
      className="mb-3 flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        rename.commit(column.id);
      }}
    >
      <input
        ref={(element) => rename.setInputRef(column.id, element)}
        value={rename.drafts[column.id] ?? column.name}
        onChange={(event) => rename.setDrafts((previous) => ({ ...previous, [column.id]: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            rename.cancel(column.id);
          }
        }}
        className="w-[190px] max-w-full bg-transparent text-sm font-semibold tracking-wide text-primary focus:outline-none border-b border-white/10 focus:border-white/30 pb-1"
        placeholder="List name"
      />
      <button
        type="submit"
        className="h-9 w-9 rounded-full border border-white/20 bg-white/15 text-lg font-semibold text-primary flex items-center justify-center hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent"
        aria-label="Save list name"
      >
        +
      </button>
      <button type="button" className="ml-auto text-[11px] font-medium text-secondary hover:text-primary" onClick={() => rename.cancel(column.id)}>
        Cancel
      </button>
    </form>
  );
}

/** A lists or compound board: optional index, one column per list, and "Add list" on a lists board. */
export function ListsBoardView({
  board,
  scrollerRef,
  listColumns,
  tasksByColumn,
  eventsByColumn,
  compoundIndexGroups,
  listColumnSources,
  focusedColumnId,
  onFocusColumn,
  rename,
  inlineAdd,
  selection,
  columnGroupIds,
  setColumnRef,
  onAddList,
}: {
  board: Board;
  scrollerRef: RefObject<HTMLDivElement | null>;
  listColumns: ListColumn[];
  tasksByColumn: Map<string, Task[]>;
  eventsByColumn: Map<string, CalendarEvent[]>;
  compoundIndexGroups: CompoundIndexGroup[];
  listColumnSources: Map<string, { boardName: string }>;
  focusedColumnId: unknown;
  onFocusColumn: (columnId: string) => void;
  rename: ListRename;
  inlineAdd: InlineAdd;
  selection: GroupSelection;
  columnGroupIds: (columnId: string) => string[];
  setColumnRef: (key: string, element: HTMLDivElement | null) => void;
  onAddList: () => void;
}) {
  const actions = useTaskActions();
  return (
    <div
      ref={scrollerRef}
      className={`board-scroller flex-1 min-h-0 overflow-x-auto pb-0 w-full${selection.active ? " board-selection-pad" : ""}`}
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      <div className="flex gap-4 min-w-max h-full items-stretch">
        {board.kind !== "week" && board.kind !== "bible" && board.indexCardEnabled && (
          <ListIndex
            board={board}
            listColumns={listColumns}
            compoundIndexGroups={compoundIndexGroups}
            listColumnSources={listColumnSources}
            focusedColumnId={focusedColumnId}
            onFocusColumn={onFocusColumn}
            setColumnRef={setColumnRef}
          />
        )}
        {listColumns.map((column) => (
          <DroppableColumn
            ref={(element) => setColumnRef(`list-${column.id}`, element)}
            key={column.id}
            title={rename.drafts[column.id] ?? column.name}
            header={rename.renamingColumnId === column.id ? <RenameListForm column={column} rename={rename} /> : undefined}
            onTitleClick={() => onFocusColumn(column.id)}
            onDropCard={(payload) => {
              const ids = payload.allIds ?? [payload.id];
              ids.forEach((taskId) => actions.moveTask(taskId, { type: "list", columnId: column.id }, taskId === payload.id ? payload.beforeId : undefined));
              if (selection.active && payload.allIds) selection.exit();
            }}
            onDropEnd={actions.endDrag}
            onSelectAll={selection.active ? () => selection.toggle(columnGroupIds(column.id)) : undefined}
            selectionState={selection.active ? selection.stateOf(columnGroupIds(column.id)) : undefined}
            scrollable
            footer={<InlineAddTaskForm columnKey={column.id} inlineAdd={inlineAdd} />}
          >
            {(eventsByColumn.get(column.id) || []).map((event) => (
              <BoardEventCard key={event.id} event={event} showDate />
            ))}
            {(tasksByColumn.get(column.id) || []).map((task) => (
              <BoardTaskCard
                key={task.id}
                task={task}
                dropTarget={{ type: "list", columnId: column.id }}
              />
            ))}
          </DroppableColumn>
        ))}
        {board.kind === "lists" && (
          <div className="board-column surface-panel w-[325px] shrink-0 p-4 flex h-full flex-col gap-4">
            <div className="flex-1 rounded-3xl border border-white/5 bg-white/5 backdrop-blur-sm shadow-inner flex flex-col items-center justify-center gap-3 text-center p-6">
              <div className="text-base font-semibold">Add list</div>
              <button
                type="button"
                className="w-16 h-16 rounded-full border border-white/20 bg-white/15 backdrop-blur-lg shadow-lg flex items-center justify-center text-2xl text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent"
                onClick={onAddList}
                aria-label="Add list"
              >
                +
              </button>
              <div className="text-sm text-secondary max-w-[240px]">Build an empty board and drop your first tasks here.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
