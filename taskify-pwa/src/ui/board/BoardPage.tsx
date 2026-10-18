/**
 * The Boards page body: the current board as a week, lists or Bible view, or its Completed or
 * Upcoming view. `App` keeps the header, the rail and routing; cards act through the task
 * actions it provides (`ui/task/taskActions`).
 */
import { lazy, Suspense, type ComponentProps, type RefObject } from "react";
import type { Board } from "../../domains/tasks/taskTypes";
import type { BibleBoardViewProps } from "./BibleBoardView";
import { BoardScrollEdges } from "./BoardScrollEdges";
import { BoardUpcomingView, CompletedBoardView } from "./BoardSecondaryViews";
import type { GroupSelection, InlineAdd } from "./BoardViewParts";
import { ListsBoardView } from "./ListsBoardView";
import { WeekBoardView } from "./WeekBoardView";

// The Bible tracker and scripture memory load only when a Bible board is shown.
const BibleBoardView = lazy(() => import("./BibleBoardView").then((m) => ({ default: m.BibleBoardView })));

export type BoardPageView = "board" | "completed" | "board-upcoming" | "bible";

type WeekProps = Omit<ComponentProps<typeof WeekBoardView>, "scrollerRef" | "inlineAdd" | "selection" | "setColumnRef">;
type ListsProps = Omit<ComponentProps<typeof ListsBoardView>, "board" | "scrollerRef" | "inlineAdd" | "selection" | "setColumnRef">;

function EmptyPanel({ children }: { children: string }) {
  return <div className="surface-panel p-6 text-center text-sm text-secondary">{children}</div>;
}

export function BoardPage({
  view,
  board,
  scrollerRef,
  bibleScrollerRef,
  inlineAdd,
  selection,
  setColumnRef,
  week,
  lists,
  bible,
  bibleTrackerEnabled,
  upcoming,
  completed,
}: {
  view: BoardPageView;
  board: Board | null | undefined;
  scrollerRef: RefObject<HTMLDivElement | null>;
  bibleScrollerRef: RefObject<HTMLDivElement | null>;
  inlineAdd: InlineAdd;
  selection: GroupSelection;
  setColumnRef: (key: string, element: HTMLDivElement | null) => void;
  week: WeekProps;
  lists: ListsProps;
  bible: Omit<BibleBoardViewProps, "scrollerRef">;
  /** The Bible view (from the header) needs the tracker turned on in Settings. */
  bibleTrackerEnabled: boolean;
  upcoming: ComponentProps<typeof BoardUpcomingView>;
  completed: ComponentProps<typeof CompletedBoardView>;
}) {
  const shared = { scrollerRef, inlineAdd, selection, setColumnRef };
  const bibleView = (
    <Suspense fallback={null}>
      <BibleBoardView scrollerRef={bibleScrollerRef} {...bible} />
    </Suspense>
  );

  let content;
  if (view === "bible") {
    content = bibleTrackerEnabled
      ? bibleView
      : <EmptyPanel>Enable the Bible tracker from Settings to start tracking your reading.</EmptyPanel>;
  } else if (view === "board-upcoming") content = <BoardUpcomingView {...upcoming} />;
  else if (view === "completed") content = <CompletedBoardView {...completed} />;
  else if (!board) content = <EmptyPanel>No boards. Open Settings to create one.</EmptyPanel>;
  else if (board.kind === "week") content = <WeekBoardView {...shared} {...week} />;
  else if (board.kind === "bible") content = bibleView;
  else content = <ListsBoardView board={board} {...shared} {...lists} />;

  return (
    <div className="board-layout relative flex min-h-0 flex-1 flex-col">
      {view === "board" && board && board.kind !== "bible" && (
        <BoardScrollEdges
          boardRef={scrollerRef}
          layoutKey={`${board.id}:${board.kind === "lists" ? board.columns.length : 7}`}
        />
      )}
      {content}
    </div>
  );
}

