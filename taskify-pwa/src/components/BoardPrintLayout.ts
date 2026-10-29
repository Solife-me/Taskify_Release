import { getPaperDefinition, type PrintPaperSize } from "./printPaper";

export const BOARD_PRINT_LAYOUT_VERSION = "v2";

export type BoardPrintTask = {
  id: string;
  title: string;
  label?: string;
  /** Stable list/day identifier used when the user prints only selected lists. */
  listId?: string;
};

export type BoardPrintScope =
  | { kind: "board" }
  | { kind: "lists"; listIds: string[] }
  | { kind: "selection" };

export type BoardPrintListChoice = {
  id: string;
  label: string;
};

export type BoardPrintJob = {
  id: string;
  boardId: string;
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

const BASE_MARGIN_MM = 10;
const A6_BINDING_MARGIN_MM = 4;
const MARKER_SIZE_MM = 6;
const MARKER_GAP_MM = 2;
const HEADER_HEIGHT_MM = 11;
const HEADER_GAP_MM = 3.5;
const COLUMN_GAP_MM = 8;
const COLUMN_COUNT = 1;
const ROW_HEIGHT_MM = 7;
const CIRCLE_SIZE_MM = 4.2;
const CIRCLE_TEXT_GAP_MM = 2.4;
const PAGE_ID_MARKER_SIZE_MM = 2.4;
const PAGE_ID_MARKER_GAP_MM = 1.2;
const PAGE_ID_BITS = 6;

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
  x: number;
  y: number;
  widthMm: number;
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
  pages: BoardPrintPage[];
};

export function buildBoardPrintLayout(
  tasks: BoardPrintTask[],
  options?: { layoutVersion?: string; paperSize?: PrintPaperSize },
): BoardPrintLayout {
  const paperSize = options?.paperSize ?? "letter";
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
  const layoutVersion = options?.layoutVersion ?? BOARD_PRINT_LAYOUT_VERSION;
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

  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const pages: BoardPrintPage[] = Array.from({ length: pageCount }, (_, index) => ({
    index,
    rows: [],
  }));

  const pageIdPositions = Array.from({ length: PAGE_ID_BITS }, (_, index) => ({
    x: pageIdOriginXMm + index * (PAGE_ID_MARKER_SIZE_MM + PAGE_ID_MARKER_GAP_MM),
    y: pageIdOriginYMm,
  }));
  const pageIdPatterns = pages.map((page) => {
    const value = page.index + 1;
    return Array.from({ length: PAGE_ID_BITS }, (_, bit) => (value >> bit) & 1);
  });

  rows.forEach((rowItem, index) => {
    const pageIndex = Math.floor(index / rowsPerPage);
    const page = pages[pageIndex];
    if (!page) return;
    const indexInPage = index % rowsPerPage;
    const columnIndex = Math.floor(indexInPage / rowsPerColumn);
    const rowIndex = indexInPage % rowsPerColumn;
    const originX = margin.left + columnIndex * (columnWidthMm + COLUMN_GAP_MM);
    const originY = contentTopMm + rowIndex * ROW_HEIGHT_MM;
    if (rowItem.kind === "header") {
      page.rows.push({
        kind: "header",
        label: rowItem.label,
        x: originX,
        y: originY,
        widthMm: columnWidthMm,
        textWidthMm: columnWidthMm,
      });
      return;
    }

    const circleX = originX;
    const circleY = originY + (ROW_HEIGHT_MM - CIRCLE_SIZE_MM) / 2;
    const textX = originX + CIRCLE_SIZE_MM + CIRCLE_TEXT_GAP_MM;
    const textWidthMm = columnWidthMm - CIRCLE_SIZE_MM - CIRCLE_TEXT_GAP_MM;

    page.rows.push({
      kind: "task",
      taskId: rowItem.task.id,
      title: rowItem.task.title,
      label: rowItem.task.label,
      x: originX,
      y: originY,
      widthMm: columnWidthMm,
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
    pages,
  };
}
