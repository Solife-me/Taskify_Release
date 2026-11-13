import {
  BOARD_PRINT_CONTRACT_VERSION,
  BOARD_PRINT_DETAIL_LAYOUT_VERSION,
  BOARD_PRINT_LAYOUT_MM,
  BOARD_PRINT_MAX_PAGES,
  boardPrintJobCodePattern,
  boardPrintPagePattern,
  isSupportedBoardPrintVersion,
} from "taskify-core";
import { getPaperDefinition, type PrintPaperSize } from "./printPaper";

export const BOARD_PRINT_LAYOUT_VERSION = BOARD_PRINT_CONTRACT_VERSION;
export { BOARD_PRINT_DETAIL_LAYOUT_VERSION };

export type BoardPrintSubtask = { title: string; completed?: boolean };

export type BoardPrintTask = {
  id: string;
  title: string;
  label?: string;
  /** Stable list/day identifier used when the user prints only selected lists. */
  listId?: string;
  completed?: boolean;
  /** A compact second line under the title: due date/time and/or the start of the note. */
  detail?: string;
  subtasks?: BoardPrintSubtask[];
  /** Printable photo thumbnails (data URLs), capped when the job is prepared. */
  photos?: string[];
  /** How many photo thumbnails to reserve space for when only the synced geometry is known. */
  photoCount?: number;
  /** Only needed while preparing photos, so an encrypted attachment can be decrypted. */
  boardId?: string;
};

export type BoardPrintScope =
  | { kind: "board" }
  | { kind: "lists"; listIds: string[] }
  | { kind: "selection" };

export type BoardPrintOptions = {
  /** Tasks the board is holding back until a future date. */
  includeUpcoming: boolean;
  includeCompleted: boolean;
  includeNotes: boolean;
  includeDue: boolean;
  includeSubtasks: boolean;
  includePhotos: boolean;
};

export const DEFAULT_BOARD_PRINT_OPTIONS: BoardPrintOptions = {
  includeUpcoming: false,
  includeCompleted: false,
  includeNotes: false,
  includeDue: false,
  includeSubtasks: false,
  includePhotos: false,
};

/** The detailed layout is used whenever a row needs more than the title band. */
export function boardPrintLayoutVersionFor(options: BoardPrintOptions): string {
  return options.includeSubtasks || options.includePhotos
    ? BOARD_PRINT_DETAIL_LAYOUT_VERSION
    : BOARD_PRINT_LAYOUT_VERSION;
}

type BoardPrintDueOptions = { includeTime?: boolean; timeZone?: string };

function formatPrintIntl(date: Date, options: Intl.DateTimeFormatOptions): string | undefined {
  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    return undefined;
  }
}

/** A due date, and the time when the task carries one, in the task's own time zone. */
export function formatBoardPrintDue(
  iso: string | null | undefined,
  options?: BoardPrintDueOptions,
): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const timeZone = options?.timeZone;
  const dateText =
    formatPrintIntl(date, { dateStyle: "medium", ...(timeZone ? { timeZone } : {}) }) ??
    formatPrintIntl(date, { dateStyle: "medium" });
  if (!dateText) return undefined;
  if (!options?.includeTime) return dateText;
  const timeText =
    formatPrintIntl(date, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }) ??
    formatPrintIntl(date, { hour: "numeric", minute: "2-digit" });
  return timeText ? `${dateText}, ${timeText}` : dateText;
}

/** A calendar event's all-day date key, formatted without shifting across time zones. */
export function formatBoardPrintDateKey(dateKey: string | null | undefined): string | undefined {
  if (!dateKey) return undefined;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!parts) return undefined;
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12);
  if (Number.isNaN(date.getTime())) return undefined;
  return formatPrintIntl(date, { dateStyle: "medium" });
}

/** The detail line's text: due first, then the note, on one line. */
export function composeBoardPrintDetail(
  due?: string | null,
  note?: string | null,
): string | undefined {
  const parts = [due, note]
    .map((part) => (part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export type BoardPrintListChoice = {
  id: string;
  label: string;
};

export type BoardPrintJob = {
  id: string;
  boardId: string;
  /** Stable Nostr board/tracker identifier used to find this manifest on another client. */
  ownerId?: string;
  boardName: string;
  printedAtISO: string;
  layoutVersion: string;
  paperSize: PrintPaperSize;
  scope?: BoardPrintScope;
  tasks: BoardPrintTask[];
};

export function isTaskPrintable(
  task: { completed?: boolean },
  includeCompleted: boolean,
): boolean {
  return includeCompleted || task.completed !== true;
}

export function tasksForBoardPrintScope(
  tasks: BoardPrintTask[],
  scope: BoardPrintScope | null | undefined,
): BoardPrintTask[] {
  if (scope?.kind !== "lists") return tasks;
  const selected = new Set(scope.listIds);
  return selected.size ? tasks.filter((task) => task.listId && selected.has(task.listId)) : [];
}

type BoardPrintMarkerStyle = "solid" | "finder";

const BASE_MARGIN_MM = BOARD_PRINT_LAYOUT_MM.baseMarginMm;
const A6_BINDING_MARGIN_MM = BOARD_PRINT_LAYOUT_MM.a6BindingMarginMm;
const MARKER_SIZE_MM = BOARD_PRINT_LAYOUT_MM.markerSizeMm;
const MARKER_GAP_MM = BOARD_PRINT_LAYOUT_MM.markerGapMm;
const HEADER_HEIGHT_MM = BOARD_PRINT_LAYOUT_MM.headerHeightMm;
const HEADER_GAP_MM = BOARD_PRINT_LAYOUT_MM.headerGapMm;
const COLUMN_GAP_MM = 8;
const COLUMN_COUNT = 1;
const ROW_HEIGHT_MM = BOARD_PRINT_LAYOUT_MM.rowHeightMm;
const CIRCLE_SIZE_MM = BOARD_PRINT_LAYOUT_MM.circleSizeMm;
const CIRCLE_TEXT_GAP_MM = BOARD_PRINT_LAYOUT_MM.circleTextGapMm;
const PAGE_ID_MARKER_SIZE_MM = BOARD_PRINT_LAYOUT_MM.pageIdMarkerSizeMm;
const PAGE_ID_MARKER_GAP_MM = BOARD_PRINT_LAYOUT_MM.pageIdMarkerGapMm;
const PAGE_ID_BITS = BOARD_PRINT_LAYOUT_MM.pageIdBits;
const JOB_CODE_MARKER_SIZE_MM = BOARD_PRINT_LAYOUT_MM.jobCodeMarkerSizeMm;
const JOB_CODE_MARKER_GAP_MM = BOARD_PRINT_LAYOUT_MM.jobCodeMarkerGapMm;
const JOB_CODE_BITS = BOARD_PRINT_LAYOUT_MM.jobCodeBits;
export const BOARD_PRINT_DETAIL_LINE_MM = 3.4;
export const BOARD_PRINT_SUBTASK_LINE_MM = 3.6;
const SUBTASK_MAX = 6;
export const BOARD_PRINT_PHOTO_SIZE_MM = 13;
export const BOARD_PRINT_PHOTO_MAX = 3;
const PHOTO_BLOCK_MM = BOARD_PRINT_PHOTO_SIZE_MM + 2;

type BoardPrintMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

function getBoardPrintMargins(paperSize: PrintPaperSize): BoardPrintMargins {
  if (paperSize === "a6") {
    return {
      top: BASE_MARGIN_MM,
      right: BASE_MARGIN_MM,
      bottom: BASE_MARGIN_MM,
      left: BASE_MARGIN_MM + A6_BINDING_MARGIN_MM,
    };
  }
  return {
    top: BASE_MARGIN_MM,
    right: BASE_MARGIN_MM,
    bottom: BASE_MARGIN_MM,
    left: BASE_MARGIN_MM,
  };
}

export type BoardPrintTaskRow = {
  kind: "task";
  taskId: string;
  title: string;
  label?: string;
  detail?: string;
  /** Detailed sheets put the detail block below the title band instead of inside it. */
  detailBelow?: boolean;
  subtasks?: BoardPrintSubtask[];
  hiddenSubtaskCount?: number;
  photos?: string[];
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  titleBandMm: number;
  textX: number;
  textWidthMm: number;
  circleX: number;
  circleY: number;
};

export type BoardPrintHeaderRow = {
  kind: "header";
  label: string;
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  textWidthMm: number;
};

export type BoardPrintRow = BoardPrintTaskRow | BoardPrintHeaderRow;

export type BoardPrintPage = {
  index: number;
  rows: BoardPrintRow[];
};

export type BoardPrintPageId = {
  sizeMm: number;
  gapMm: number;
  count: number;
  positionsMm: { x: number; y: number }[];
  patterns: number[][];
};

export type BoardPrintLayout = {
  version: string;
  page: {
    widthMm: number;
    heightMm: number;
    count: number;
  };
  header: {
    topMm: number;
    heightMm: number;
    widthMm: number;
    leftMm: number;
  };
  content: {
    topMm: number;
    heightMm: number;
  };
  columns: {
    count: number;
    widthMm: number;
    gapMm: number;
  };
  rows: {
    heightMm: number;
  };
  circle: {
    sizeMm: number;
    gapMm: number;
  };
  marginMm: number;
  markers: {
    sizeMm: number;
    positionsMm: {
      topLeft: { x: number; y: number };
      topRight: { x: number; y: number };
      bottomLeft: { x: number; y: number };
      bottomRight: { x: number; y: number };
    };
    centersMm: {
      topLeft: { x: number; y: number };
      topRight: { x: number; y: number };
      bottomLeft: { x: number; y: number };
      bottomRight: { x: number; y: number };
    };
    styles: {
      topLeft: BoardPrintMarkerStyle;
      topRight: BoardPrintMarkerStyle;
      bottomLeft: BoardPrintMarkerStyle;
      bottomRight: BoardPrintMarkerStyle;
    };
  };
  pageId: BoardPrintPageId;
  jobCode?: {
    sizeMm: number;
    gapMm: number;
    count: number;
    positionsMm: { x: number; y: number }[];
    pattern: number[];
  };
  pages: BoardPrintPage[];
};

export function buildBoardPrintLayout(
  tasks: BoardPrintTask[],
  options?: { layoutVersion?: string; paperSize?: PrintPaperSize; jobId?: string },
): BoardPrintLayout {
  const paperSize = options?.paperSize ?? "letter";
  const layoutVersion = options?.layoutVersion ?? BOARD_PRINT_LAYOUT_VERSION;
  if (!isSupportedBoardPrintVersion(layoutVersion)) {
    throw new Error(`Unsupported board print layout ${layoutVersion}. Reprint the board with this version of Taskify.`);
  }
  const paperDefinition = getPaperDefinition(paperSize);
  const margin = getBoardPrintMargins(paperSize);
  const pageWidthMm = paperDefinition.widthMm;
  const pageHeightMm = paperDefinition.heightMm;
  const headerTopMm = margin.top + MARKER_SIZE_MM + MARKER_GAP_MM;
  const contentTopMm = headerTopMm + HEADER_HEIGHT_MM + HEADER_GAP_MM;
  const contentHeightMm = pageHeightMm - margin.bottom - contentTopMm;
  const columnWidthMm =
    (pageWidthMm - margin.left - margin.right - COLUMN_GAP_MM * (COLUMN_COUNT - 1)) / COLUMN_COUNT;
  const rowsPerColumn = Math.max(1, Math.floor(contentHeightMm / ROW_HEIGHT_MM));
  const rowsPerPage = rowsPerColumn * COLUMN_COUNT;
  const pageIdWidthMm =
    PAGE_ID_BITS * PAGE_ID_MARKER_SIZE_MM + (PAGE_ID_BITS - 1) * PAGE_ID_MARKER_GAP_MM;
  const pageIdOriginXMm = pageWidthMm - margin.right - pageIdWidthMm;
  const pageIdOriginYMm = headerTopMm + 0.4;
  const jobCodeWidthMm =
    JOB_CODE_BITS * JOB_CODE_MARKER_SIZE_MM + (JOB_CODE_BITS - 1) * JOB_CODE_MARKER_GAP_MM;
  const jobCodeOriginXMm = pageWidthMm - margin.right - jobCodeWidthMm;
  const jobCodeOriginYMm = pageIdOriginYMm + PAGE_ID_MARKER_SIZE_MM + 0.6;
  const marginMm = Math.min(margin.top, margin.right, margin.bottom, margin.left);
  const markerPositions = {
    topLeft: { x: margin.left, y: margin.top },
    topRight: { x: pageWidthMm - margin.right - MARKER_SIZE_MM, y: margin.top },
    bottomLeft: { x: margin.left, y: pageHeightMm - margin.bottom - MARKER_SIZE_MM },
    bottomRight: {
      x: pageWidthMm - margin.right - MARKER_SIZE_MM,
      y: pageHeightMm - margin.bottom - MARKER_SIZE_MM,
    },
  };
  const markerCenters = {
    topLeft: {
      x: markerPositions.topLeft.x + MARKER_SIZE_MM / 2,
      y: markerPositions.topLeft.y + MARKER_SIZE_MM / 2,
    },
    topRight: {
      x: markerPositions.topRight.x + MARKER_SIZE_MM / 2,
      y: markerPositions.topRight.y + MARKER_SIZE_MM / 2,
    },
    bottomLeft: {
      x: markerPositions.bottomLeft.x + MARKER_SIZE_MM / 2,
      y: markerPositions.bottomLeft.y + MARKER_SIZE_MM / 2,
    },
    bottomRight: {
      x: markerPositions.bottomRight.x + MARKER_SIZE_MM / 2,
      y: markerPositions.bottomRight.y + MARKER_SIZE_MM / 2,
    },
  };

  const rows: Array<{ kind: "header"; label: string } | { kind: "task"; task: BoardPrintTask }> = [];
  const allowHeaders = layoutVersion !== "v1";
  if (allowHeaders) {
    let activeLabel: string | null = null;
    tasks.forEach((task) => {
      const nextLabel = typeof task.label === "string" ? task.label.trim() : "";
      if (nextLabel) {
        if (nextLabel !== activeLabel) {
          rows.push({ kind: "header", label: nextLabel });
          activeLabel = nextLabel;
        }
      } else {
        activeLabel = null;
      }
      rows.push({ kind: "task", task });
    });
  } else {
    tasks.forEach((task) => rows.push({ kind: "task", task }));
  }

  const detailed = layoutVersion === BOARD_PRINT_DETAIL_LAYOUT_VERSION;
  const detailedTask = (task: BoardPrintTask) => {
    const allSubtasks = (task.subtasks ?? []).filter((subtask) => subtask.title.trim());
    const subtasks = allSubtasks.slice(0, SUBTASK_MAX);
    const hiddenSubtaskCount = allSubtasks.length - subtasks.length;
    const photos = (task.photos ?? []).slice(0, BOARD_PRINT_PHOTO_MAX);
    const photoTotal = Math.min(task.photos?.length ?? task.photoCount ?? 0, BOARD_PRINT_PHOTO_MAX);
    const detailMm = task.detail ? BOARD_PRINT_DETAIL_LINE_MM : 0;
    const subtaskMm = (subtasks.length + (hiddenSubtaskCount ? 1 : 0)) * BOARD_PRINT_SUBTASK_LINE_MM;
    const photoMm = photoTotal > 0 ? PHOTO_BLOCK_MM : 0;
    const gapMm = detailMm || subtaskMm || photoMm ? 1 : 0;
    return {
      subtasks,
      hiddenSubtaskCount,
      photos,
      heightMm: ROW_HEIGHT_MM + detailMm + subtaskMm + photoMm + gapMm,
    };
  };
  const geometryFor = (rowItem: (typeof rows)[number]) =>
    rowItem.kind === "header" || !detailed ? null : detailedTask(rowItem.task);

  const slots: { pageIndex: number; yMm: number; heightMm: number }[] = [];
  if (detailed) {
    let pageIndex = 0;
    let usedMm = 0;
    rows.forEach((rowItem) => {
      const heightMm = rowItem.kind === "header" ? ROW_HEIGHT_MM : detailedTask(rowItem.task).heightMm;
      if (usedMm > 0 && usedMm + heightMm > contentHeightMm) {
        pageIndex += 1;
        usedMm = 0;
      }
      slots.push({ pageIndex, yMm: contentTopMm + usedMm, heightMm });
      usedMm += heightMm;
    });
  } else {
    rows.forEach((_, index) => {
      slots.push({
        pageIndex: Math.floor(index / rowsPerPage),
        yMm: contentTopMm + (index % rowsPerPage) * ROW_HEIGHT_MM,
        heightMm: ROW_HEIGHT_MM,
      });
    });
  }

  const pageCount = detailed
    ? Math.max(1, ...slots.map((slot) => slot.pageIndex + 1))
    : Math.max(1, Math.ceil(rows.length / rowsPerPage));
  if (pageCount > BOARD_PRINT_MAX_PAGES) {
    throw new Error(`This print needs ${pageCount} pages; the versioned scan format supports ${BOARD_PRINT_MAX_PAGES}.`);
  }
  const pages: BoardPrintPage[] = Array.from({ length: pageCount }, (_, index) => ({
    index,
    rows: [],
  }));

  const pageIdPositions = Array.from({ length: PAGE_ID_BITS }, (_, index) => ({
    x: pageIdOriginXMm + index * (PAGE_ID_MARKER_SIZE_MM + PAGE_ID_MARKER_GAP_MM),
    y: pageIdOriginYMm,
  }));
  const pageIdPatterns = pages.map((page) => boardPrintPagePattern(page.index));
  const jobCodePositions = Array.from({ length: JOB_CODE_BITS }, (_, index) => ({
    x: jobCodeOriginXMm + index * (JOB_CODE_MARKER_SIZE_MM + JOB_CODE_MARKER_GAP_MM),
    y: jobCodeOriginYMm,
  }));
  const includeJobCode = layoutVersion === BOARD_PRINT_CONTRACT_VERSION || layoutVersion === BOARD_PRINT_DETAIL_LAYOUT_VERSION;
  const jobCodePattern = boardPrintJobCodePattern(options?.jobId || "unknown");

  rows.forEach((rowItem, index) => {
    const slot = slots[index];
    const page = pages[slot?.pageIndex ?? 0];
    if (!slot || !page) return;
    const originX = margin.left;
    const originY = slot.yMm;
    if (rowItem.kind === "header") {
      page.rows.push({
        kind: "header",
        label: rowItem.label,
        x: originX,
        y: originY,
        widthMm: columnWidthMm,
        heightMm: ROW_HEIGHT_MM,
        textWidthMm: columnWidthMm,
      });
      return;
    }

    const titleBandMm = ROW_HEIGHT_MM;
    const circleX = originX;
    const circleY = originY + (titleBandMm - CIRCLE_SIZE_MM) / 2;
    const textX = originX + CIRCLE_SIZE_MM + CIRCLE_TEXT_GAP_MM;
    const textWidthMm = columnWidthMm - CIRCLE_SIZE_MM - CIRCLE_TEXT_GAP_MM;
    const geometry = geometryFor(rowItem);

    page.rows.push({
      kind: "task",
      taskId: rowItem.task.id,
      title: rowItem.task.title,
      label: rowItem.task.label,
      ...(rowItem.task.detail ? { detail: rowItem.task.detail } : {}),
      ...(detailed && rowItem.task.detail ? { detailBelow: true } : {}),
      ...(geometry?.subtasks.length ? { subtasks: geometry.subtasks } : {}),
      ...(geometry?.hiddenSubtaskCount ? { hiddenSubtaskCount: geometry.hiddenSubtaskCount } : {}),
      ...(geometry?.photos.length ? { photos: geometry.photos } : {}),
      x: originX,
      y: originY,
      widthMm: columnWidthMm,
      heightMm: slot.heightMm,
      titleBandMm,
      textX,
      textWidthMm,
      circleX,
      circleY,
    });
  });

  return {
    version: layoutVersion,
    page: {
      widthMm: pageWidthMm,
      heightMm: pageHeightMm,
      count: pageCount,
    },
    header: {
      topMm: headerTopMm,
      heightMm: HEADER_HEIGHT_MM,
      widthMm: pageWidthMm - margin.left - margin.right,
      leftMm: margin.left,
    },
    content: {
      topMm: contentTopMm,
      heightMm: contentHeightMm,
    },
    columns: {
      count: COLUMN_COUNT,
      widthMm: columnWidthMm,
      gapMm: COLUMN_GAP_MM,
    },
    rows: {
      heightMm: ROW_HEIGHT_MM,
    },
    circle: {
      sizeMm: CIRCLE_SIZE_MM,
      gapMm: CIRCLE_TEXT_GAP_MM,
    },
    marginMm,
    markers: {
      sizeMm: MARKER_SIZE_MM,
      positionsMm: markerPositions,
      centersMm: markerCenters,
      styles: {
        topLeft: "finder",
        topRight: "finder",
        bottomLeft: "solid",
        bottomRight: "solid",
      },
    },
    pageId: {
      sizeMm: PAGE_ID_MARKER_SIZE_MM,
      gapMm: PAGE_ID_MARKER_GAP_MM,
      count: PAGE_ID_BITS,
      positionsMm: pageIdPositions,
      patterns: pageIdPatterns,
    },
    ...(includeJobCode
      ? {
          jobCode: {
            sizeMm: JOB_CODE_MARKER_SIZE_MM,
            gapMm: JOB_CODE_MARKER_GAP_MM,
            count: JOB_CODE_BITS,
            positionsMm: jobCodePositions,
            pattern: jobCodePattern,
          },
        }
      : {}),
    pages,
  };
}
