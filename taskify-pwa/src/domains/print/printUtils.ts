import type { BoardPrintJob, BoardPrintTask } from "../../components/BoardPrintLayout";
import { isPrintPaperSize, type PrintPaperSize } from "../../components/printPaper";
import { kvStorage } from "../../storage/kvStorage";
import { LS_BOARD_PRINT_JOBS, LS_BIBLE_PRINT_PAPER } from "../storageKeys";

export function normalizeBoardPrintJob(value: any): BoardPrintJob | null {
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
        const detail = typeof task.detail === "string" ? task.detail.trim() : "";
        const subtasks = Array.isArray(task.subtasks)
          ? task.subtasks
            .map((subtask: any) => ({
              title: typeof subtask?.title === "string" ? subtask.title.trim() : "",
              ...(subtask?.completed === true ? { completed: true } : {}),
            }))
            .filter((subtask: { title: string }) => !!subtask.title)
          : [];
        const photoCount = typeof task.photoCount === "number" && task.photoCount > 0
          ? Math.min(3, Math.floor(task.photoCount))
          : 0;
        return {
          id: taskId,
          title,
          ...(label ? { label } : {}),
          ...(detail ? { detail } : {}),
          ...(subtasks.length ? { subtasks } : {}),
          ...(photoCount ? { photoCount } : {}),
        };
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

export function loadBiblePrintPaperSize(): PrintPaperSize {
  try {
    const raw = kvStorage.getItem(LS_BIBLE_PRINT_PAPER);
    return isPrintPaperSize(raw) ? raw : "letter";
  } catch {
    return "letter";
  }
}

export function persistBiblePrintPaperSize(paperSize: PrintPaperSize): void {
  try {
    kvStorage.setItem(LS_BIBLE_PRINT_PAPER, paperSize);
  } catch {}
}
