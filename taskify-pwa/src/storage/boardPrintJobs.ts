import { kvStorage } from "./kvStorage";
import type { BoardPrintJob, BoardPrintScope, BoardPrintTask } from "../components/BoardPrintLayout";
import { isPrintPaperSize } from "../components/printPaper";
import { isSupportedBoardPrintVersion } from "taskify-core";

const LS_BOARD_PRINT_JOBS = "taskify_board_print_jobs_v1";



function normalizeBoardPrintJob(value: any): BoardPrintJob | null {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" ? value.id : "";
  const boardId = typeof value.boardId === "string" ? value.boardId : "";
  if (!id || !boardId) return null;
  const tasks = Array.isArray(value.tasks)
    ? value.tasks
      .map((task: any) => {
        if (!task || typeof task !== "object") return null;
        const taskId = typeof task.id === "string" ? task.id : "";
        const title = typeof task.title === "string" ? task.title : "";
        if (!taskId || !title) return null;
        const label = typeof task.label === "string" ? task.label : undefined;
        const listId = typeof task.listId === "string" ? task.listId : undefined;
        return {
          id: taskId,
          title,
          ...(label ? { label } : {}),
          ...(listId ? { listId } : {}),
          ...(task.completed === true ? { completed: true } : {}),
        };
      })
      .filter(Boolean) as BoardPrintTask[]
    : [];
  const paperSize = isPrintPaperSize(value.paperSize) ? value.paperSize : "letter";
  let scope: BoardPrintScope | undefined;
  if (value.scope?.kind === "board" || value.scope?.kind === "selection") {
    scope = { kind: value.scope.kind };
  } else if (value.scope?.kind === "lists" && Array.isArray(value.scope.listIds)) {
    scope = {
      kind: "lists",
      listIds: value.scope.listIds.filter((id: unknown): id is string => typeof id === "string" && !!id),
    };
  }
  return {
    id,
    boardId,
    boardName: typeof value.boardName === "string" ? value.boardName : "Board",
    printedAtISO: typeof value.printedAtISO === "string" ? value.printedAtISO : new Date().toISOString(),
    layoutVersion: isSupportedBoardPrintVersion(value.layoutVersion) ? value.layoutVersion : "v1",
    paperSize,
    ...(scope ? { scope } : {}),
    tasks,
  };
}

export function loadBoardPrintJob(boardId: string): BoardPrintJob | null {
  if (!boardId) return null;
  try {
    const raw = kvStorage.getItem(LS_BOARD_PRINT_JOBS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeBoardPrintJob((parsed as Record<string, BoardPrintJob>)[boardId]);
  } catch {
    return null;
  }
}

export function persistBoardPrintJob(job: BoardPrintJob): void {
  try {
    const raw = kvStorage.getItem(LS_BOARD_PRINT_JOBS);
    const parsed = raw ? JSON.parse(raw) : {};
    const next = parsed && typeof parsed === "object" ? parsed : {};
    (next as Record<string, BoardPrintJob>)[job.boardId] = job;
    kvStorage.setItem(LS_BOARD_PRINT_JOBS, JSON.stringify(next));
  } catch {}
}
