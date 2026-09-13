import { kvStorage } from "./kvStorage";
import type { BoardPrintJob, BoardPrintTask } from "../components/BoardPrintLayout";
import { isPrintPaperSize } from "../components/printPaper";

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
        return { id: taskId, title, ...(label ? { label } : {}) };
      })
      .filter(Boolean) as BoardPrintTask[]
    : [];
  const paperSize = isPrintPaperSize(value.paperSize) ? value.paperSize : "letter";
  return {
    id,
    boardId,
    boardName: typeof value.boardName === "string" ? value.boardName : "Board",
    printedAtISO: typeof value.printedAtISO === "string" ? value.printedAtISO : new Date().toISOString(),
    layoutVersion: typeof value.layoutVersion === "string" ? value.layoutVersion : "v1",
    paperSize,
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
