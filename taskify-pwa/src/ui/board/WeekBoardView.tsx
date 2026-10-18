import type { RefObject } from "react";
import { WD_SHORT } from "../../domains/appTypes";
import type { CalendarEvent, Task, Weekday } from "../../domains/tasks/taskTypes";
import { BoardEventCard, BoardTaskCard, useTaskActions } from "../task/taskActions";
import { InlineAddTaskForm, type GroupSelection, type InlineAdd } from "./BoardViewParts";
import { DroppableColumn } from "./DroppableColumn";

const WEEK: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** A week board: one column per day, scrolling sideways. */
export function WeekBoardView({
  scrollerRef,
  tasksByDay,
  eventsByDay,
  inlineAdd,
  selection,
  setColumnRef,
  onDayTitleClick,
  dayGroupIds,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  tasksByDay: Map<Weekday, Task[]>;
  eventsByDay: Map<Weekday, CalendarEvent[]>;
  inlineAdd: InlineAdd;
  selection: GroupSelection;
  setColumnRef: (key: string, element: HTMLDivElement | null) => void;
  onDayTitleClick: (day: Weekday) => void;
  dayGroupIds: (day: Weekday) => string[];
}) {
  const actions = useTaskActions();
  return (
    <div
      ref={scrollerRef}
      className={`board-scroller flex-1 min-h-0 overflow-x-auto pb-0 w-full${selection.active ? " board-selection-pad" : ""}`}
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      <div className="flex gap-4 min-w-max h-full items-stretch">
        {WEEK.map((day) => (
          <DroppableColumn
            ref={(element) => setColumnRef(`week-day-${day}`, element)}
            key={day}
            title={WD_SHORT[day]}
            onTitleClick={() => onDayTitleClick(day)}
            onDropCard={(payload) => {
              const ids = payload.allIds ?? [payload.id];
              ids.forEach((taskId) => actions.moveTask(taskId, { type: "day", day }, taskId === payload.id ? payload.beforeId : undefined));
              if (selection.active && payload.allIds) selection.exit();
            }}
            onDropEnd={actions.endDrag}
            onSelectAll={selection.active ? () => selection.toggle(dayGroupIds(day)) : undefined}
            selectionState={selection.active ? selection.stateOf(dayGroupIds(day)) : undefined}
            data-day={day}
            scrollable
            footer={<InlineAddTaskForm columnKey={String(day)} inlineAdd={inlineAdd} />}
          >
            {(eventsByDay.get(day) || []).map((event) => (
              <BoardEventCard key={`${event.id}-${day}`} event={event} showDate={false} />
            ))}
            {(tasksByDay.get(day) || []).map((task) => (
              <BoardTaskCard
                key={task.id}
                task={task}
                dropTarget={{ type: "day", day }}
              />
            ))}
          </DroppableColumn>
        ))}
      </div>
    </div>
  );
}
