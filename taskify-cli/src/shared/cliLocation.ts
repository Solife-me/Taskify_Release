import {
  resolveTaskLocation,
  type ResolvedTaskLocation,
  type TaskifyLocationBoard,
} from "taskify-core";
import type { TaskifyConfig } from "../config.js";

export class CliLocationError extends Error {
  readonly code: string;
  readonly candidates: Array<{ id: string; name: string; path: string }>;

  constructor(code: string, message: string, candidates: Array<{ id: string; name: string; path: string }>) {
    super(message);
    this.name = "CliLocationError";
    this.code = code;
    this.candidates = candidates;
  }
}

export function catalogBoards(config: TaskifyConfig): TaskifyLocationBoard[] {
  return config.boards.map((board) => ({
    id: board.id,
    name: board.name,
    kind: board.kind,
    lists: board.columns ?? [],
    archived: board.archived,
    hidden: board.hidden,
  }));
}

export function resolveCliLocation(
  config: TaskifyConfig,
  options: {
    in?: string;
    board?: string;
    list?: string;
    intent?: "read" | "write";
    ignoreDefaultList?: boolean;
  },
): ResolvedTaskLocation {
  if (options.in && (options.board || options.list)) {
    throw new CliLocationError(
      "CONFLICTING_LOCATION",
      "Use --in Board/List or --board/--column, not both.",
      [],
    );
  }

  let boardRef = options.board;
  if (!boardRef && options.list) {
    boardRef = config.defaultLocation?.boardId;
  }

  const defaultLocation = options.ignoreDefaultList && config.defaultLocation
    ? { boardId: config.defaultLocation.boardId }
    : config.defaultLocation;
  const result = resolveTaskLocation({
    boards: catalogBoards(config),
    location: options.in,
    boardRef,
    listRef: options.list,
    defaultLocation,
    intent: options.intent,
  });
  if (result.ok) return result.location;
  throw new CliLocationError(result.code, result.message, result.candidates);
}
