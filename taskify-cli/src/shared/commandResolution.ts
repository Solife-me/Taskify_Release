import { resolveBoardReference } from "taskify-core";
import type { BoardEntry } from "../config.js";
import type { TaskifyDefaultLocation } from "taskify-core";

export type BoardResolutionResult =
  | { ok: true; boardId: string }
  | { ok: false; exitCode: 1; message: string; listBoards?: boolean };

export function resolveBoardForCommand(
  boards: BoardEntry[],
  boardRef?: string,
  defaultLocation?: TaskifyDefaultLocation,
  options: { writable?: boolean } = {},
): BoardResolutionResult {
  if (boardRef) {
    const entry = resolveBoardReference(boards, boardRef);
    if (!entry) return { ok: false, exitCode: 1, message: `Board not found: "${boardRef}".`, listBoards: true };
    if (options.writable && entry.kind === "compound") {
      return { ok: false, exitCode: 1, message: `Compound board "${entry.name}" is read-only.`, listBoards: true };
    }
    return { ok: true, boardId: entry.id };
  }
  if (defaultLocation) {
    const entry = resolveBoardReference(boards, defaultLocation.boardId);
    if (entry && (!options.writable || entry.kind !== "compound")) {
      return { ok: true, boardId: entry.id };
    }
    if (entry?.kind === "compound") {
      return { ok: false, exitCode: 1, message: `Default board "${entry.name}" is read-only.`, listBoards: true };
    }
  }
  const candidates = options.writable ? boards.filter((board) => board.kind !== "compound") : boards;
  if (candidates.length === 1) return { ok: true, boardId: candidates[0].id };
  if (candidates.length === 0) return { ok: false, exitCode: 1, message: "No boards configured. Run: taskify sync" };
  return { ok: false, exitCode: 1, message: "Multiple boards configured. Specify one with --board <id|name>:", listBoards: true };
}

export async function requireResolvedTask(runtime: { getTask(taskId: string, boardId?: string): Promise<unknown | null> }, taskId: string, boardId?: string): Promise<{ ok: true; value: unknown } | { ok: false; exitCode: 1; message: string }> {
  const value = await runtime.getTask(taskId, boardId);
  if (!value) return { ok: false, exitCode: 1, message: `Task not found: ${taskId}` };
  return { ok: true, value };
}

export async function requireResolvedEvent(runtime: { getEvent(eventId: string, boardId?: string): Promise<unknown | null> }, eventId: string, boardId?: string): Promise<{ ok: true; value: unknown } | { ok: false; exitCode: 1; message: string }> {
  const value = await runtime.getEvent(eventId, boardId);
  if (!value) return { ok: false, exitCode: 1, message: `Event not found: ${eventId}` };
  return { ok: true, value };
}
