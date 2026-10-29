import { kvStorage } from "./kvStorage";
import { tasksForBoardPrintScope, type BoardPrintJob, type BoardPrintScope, type BoardPrintTask } from "../components/BoardPrintLayout";
import { isPrintPaperSize } from "../components/printPaper";
import { BOARD_PRINT_CONTRACT_VERSION, isSupportedBoardPrintVersion, mergeNostrPrintJobs, type NostrPrintJobManifest } from "taskify-core";

const LS_BOARD_PRINT_JOBS = "taskify_board_print_jobs_v1";



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
    ...(typeof value.ownerId === "string" && value.ownerId ? { ownerId: value.ownerId } : {}),
    boardName: typeof value.boardName === "string" ? value.boardName : "Board",
    printedAtISO: typeof value.printedAtISO === "string" ? value.printedAtISO : new Date().toISOString(),
    layoutVersion: isSupportedBoardPrintVersion(value.layoutVersion) ? value.layoutVersion : "v1",
    paperSize,
    ...(scope ? { scope } : {}),
    tasks,
  };
}

export function loadBoardPrintJobs(): Record<string, BoardPrintJob> {
  try {
    const parsed = JSON.parse(kvStorage.getItem(LS_BOARD_PRINT_JOBS) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const jobs: Record<string, BoardPrintJob> = {};
    for (const [boardId, value] of Object.entries(parsed)) {
      const job = normalizeBoardPrintJob(value);
      if (job) jobs[boardId] = job;
    }
    return jobs;
  } catch {
    return {};
  }
}

export function saveBoardPrintJobs(jobs: Record<string, BoardPrintJob>): void {
  try { kvStorage.setItem(LS_BOARD_PRINT_JOBS, JSON.stringify(jobs)); } catch {}
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
  saveBoardPrintJobs({ ...loadBoardPrintJobs(), [job.boardId]: job });
}

export function boardPrintJobManifest(job: BoardPrintJob): NostrPrintJobManifest {
  return {
    version: 1,
    layoutVersion: job.layoutVersion,
    id: job.id,
    ownerId: job.ownerId || job.boardId,
    title: job.boardName,
    createdAt: Math.floor(new Date(job.printedAtISO).getTime() / 1000) || 0,
    paper: job.paperSize,
    format: "taskList",
    items: tasksForBoardPrintScope(job.tasks, job.scope).map((task) => ({
      id: task.id,
      title: task.title,
      ...(task.label ? { section: task.label } : {}),
      ...(task.completed ? { filled: true } : {}),
    })),
  };
}

export function mergeSyncedBoardPrintJobs(
  local: Record<string, BoardPrintJob>,
  incoming: NostrPrintJobManifest[] | null | undefined,
  boards: Array<{ id: string; name: string; nostr?: { boardId: string } }>,
): Record<string, BoardPrintJob> {
  const localManifests = Object.values(local).map(boardPrintJobManifest);
  const merged = mergeNostrPrintJobs(localManifests, incoming);
  const byOwner = new Map(boards.map((board) => [`board:${board.nostr?.boardId || board.id}`, board]));
  const next = { ...local };
  for (const manifest of merged) {
    if (manifest.version !== 1 || !isSupportedBoardPrintVersion(manifest.layoutVersion)) continue;
    const board = byOwner.get(manifest.ownerId);
    if (!board || manifest.format !== "taskList") continue;
    const existing = next[board.id];
    const existingTime = existing ? Date.parse(existing.printedAtISO) / 1000 : -Infinity;
    if (existingTime > manifest.createdAt) continue;
    next[board.id] = {
      id: manifest.id,
      boardId: board.id,
      ownerId: manifest.ownerId,
      boardName: manifest.title || board.name,
      printedAtISO: new Date(manifest.createdAt * 1000).toISOString(),
      layoutVersion: manifest.layoutVersion || BOARD_PRINT_CONTRACT_VERSION,
      paperSize: manifest.paper,
      scope: { kind: "board" },
      tasks: manifest.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.section ? { label: item.section } : {}),
        ...(item.filled ? { completed: true } : {}),
      })),
    };
  }
  return next;
}
