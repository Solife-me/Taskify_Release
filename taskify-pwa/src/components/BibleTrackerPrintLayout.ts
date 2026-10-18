import { BIBLE_BOOKS } from "../domains/scripture/bibleTrackerModel";
import { getPaperDefinition, type PrintPaperSize } from "./printPaper";

export type BiblePrintLayoutVersion = "v2" | "v3";

export const BIBLE_PRINT_LAYOUT_VERSION: BiblePrintLayoutVersion = "v3";
export const BIBLE_PRINT_PAGE_COUNT = 2;

const BASE_MARGIN_MM = 8;
const BASE_MARGIN_A6_V3_MM = 6;
const A6_BINDING_MARGIN_MM = 4;
const A6_BINDING_MARGIN_V3_MM = 6;
const MARKER_SIZE_MM = 6;
const MARKER_GAP_MM = 2;
const HEADER_HEIGHT_MM = 8;
const HEADER_HEIGHT_A6_MM = 11;
const HEADER_HEIGHT_A6_V3_MM = 10;
const HEADER_GAP_MM = 2;
const COLUMN_GAP_MM = 6;
const COLUMN_COUNT = 2;
const COLUMN_COUNT_A6 = 1;
const BOX_SIZE_MM = 4;
const BOX_GAP_MM = 1;
const BOX_SIZE_A6_MM = 3.4;
const BOX_GAP_A6_MM = 0.7;
const BOX_SIZE_A6_V3_MM = 3.6;
const BOX_GAP_A6_V3_MM = 0.6;
const LABEL_HEIGHT_MM = 3.8;
const LABEL_GAP_MM = 1.2;
const LABEL_HEIGHT_A6_MM = 3;
const LABEL_GAP_A6_MM = 0.6;
const BLOCK_GAP_MM = 1.6;
const BLOCK_GAP_A6_MM = 0.8;
const PAGE_ID_MARKER_SIZE_MM = 2.4;
const PAGE_ID_MARKER_GAP_MM = 1.2;
const PAGE_ID_MARKER_BITS = 5;
const PAGE_ID_PATTERNS = [
  [1, 0, 1, 0, 1],
  [0, 1, 0, 1, 0],
  [1, 1, 0, 0, 1],
  [0, 0, 1, 1, 0],
];

type BiblePrintMarkerStyle = "solid" | "finder";
type BiblePrintMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

function getBiblePrintMargins(paperSize: PrintPaperSize, layoutVersion: BiblePrintLayoutVersion): BiblePrintMargins {
  if (paperSize === "a6") {
    const baseMarginMm = layoutVersion === "v3" ? BASE_MARGIN_A6_V3_MM : BASE_MARGIN_MM;
    const bindingMarginMm = layoutVersion === "v3" ? A6_BINDING_MARGIN_V3_MM : A6_BINDING_MARGIN_MM;
    return {
      top: baseMarginMm,
      right: baseMarginMm,
      bottom: baseMarginMm,
      left: baseMarginMm + bindingMarginMm,
    };
  }
  return {
    top: BASE_MARGIN_MM,
    right: BASE_MARGIN_MM,
    bottom: BASE_MARGIN_MM,
    left: BASE_MARGIN_MM,
  };
}

function buildBiblePageIdPatterns(count: number): number[][] {
  if (count <= PAGE_ID_PATTERNS.length) {
    return PAGE_ID_PATTERNS.slice(0, count);
  }
  const patterns = [...PAGE_ID_PATTERNS];
  const used = new Set(patterns.map((pattern) => pattern.join("")));
  for (let value = 1; patterns.length < count && value < 1 << PAGE_ID_MARKER_BITS; value += 1) {
    const pattern = Array.from({ length: PAGE_ID_MARKER_BITS }, (_, bit) => (value >> bit) & 1);
    const key = pattern.join("");
    if (used.has(key)) continue;
    used.add(key);
    patterns.push(pattern);
  }
  return patterns.slice(0, count);
}

export type BiblePrintChapterBox = {
  bookId: string;
  chapter: number;
  x: number;
  y: number;
};

export type BiblePrintBookBlock = {
  bookId: string;
  name: string;
  x: number;
  y: number;
  rows: number;
  boxes: BiblePrintChapterBox[];
};

export type BiblePrintPage = {
  index: number;
  blocks: BiblePrintBookBlock[];
  boxes: BiblePrintChapterBox[];
};

export type BiblePrintPageId = {
  sizeMm: number;
  gapMm: number;
  count: number;
  positionsMm: { x: number; y: number }[];
  patterns: number[][];
};

export type BiblePrintLayout = {
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
  boxes: {
    sizeMm: number;
    gapMm: number;
    pitchMm: number;
    perRow: number;
  };
  labels: {
    heightMm: number;
    gapMm: number;
  };
  blockGapMm: number;
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
      topLeft: BiblePrintMarkerStyle;
      topRight: BiblePrintMarkerStyle;
      bottomLeft: BiblePrintMarkerStyle;
      bottomRight: BiblePrintMarkerStyle;
    };
  };
  pageId: BiblePrintPageId;
  pages: BiblePrintPage[];
};

export function buildBiblePrintLayout(
  paperSize: PrintPaperSize = "letter",
  options?: { layoutVersion?: BiblePrintLayoutVersion },
): BiblePrintLayout {
  const layoutVersion = options?.layoutVersion ?? BIBLE_PRINT_LAYOUT_VERSION;
  const paperDefinition = getPaperDefinition(paperSize);
  const margin = getBiblePrintMargins(paperSize, layoutVersion);
  const isA6 = paperSize === "a6";
  const isV3 = layoutVersion === "v3";
  const columnCount = isA6 ? COLUMN_COUNT_A6 : COLUMN_COUNT;
  const columnGapMm = columnCount === 1 ? 0 : COLUMN_GAP_MM;
  const headerHeightMm = isA6
    ? isV3
      ? HEADER_HEIGHT_A6_V3_MM
      : HEADER_HEIGHT_A6_MM
    : HEADER_HEIGHT_MM;
  const boxSizeMm = isA6 ? (isV3 ? BOX_SIZE_A6_V3_MM : BOX_SIZE_A6_MM) : BOX_SIZE_MM;
  const boxGapMm = isA6 ? (isV3 ? BOX_GAP_A6_V3_MM : BOX_GAP_A6_MM) : BOX_GAP_MM;
  const boxPitchMm = boxSizeMm + boxGapMm;
  const labelHeightMm = isA6 ? LABEL_HEIGHT_A6_MM : LABEL_HEIGHT_MM;
  const labelGapMm = isA6 ? LABEL_GAP_A6_MM : LABEL_GAP_MM;
  const blockGapMm = isA6 ? BLOCK_GAP_A6_MM : BLOCK_GAP_MM;
  const bottomSafeMm = isA6 ? MARKER_SIZE_MM + MARKER_GAP_MM : 0;
  const pageWidthMm = paperDefinition.widthMm;
  const pageHeightMm = paperDefinition.heightMm;
  const headerTopMm = margin.top + MARKER_SIZE_MM + MARKER_GAP_MM;
  const contentTopMm = headerTopMm + headerHeightMm + HEADER_GAP_MM;
  const contentHeightMm = pageHeightMm - margin.bottom - contentTopMm - bottomSafeMm;
  const columnWidthMm =
    (pageWidthMm - margin.left - margin.right - columnGapMm * (columnCount - 1)) / columnCount;
  const chaptersPerRow = Math.max(1, Math.floor(columnWidthMm / boxPitchMm));
  const pageIdWidthMm =
    PAGE_ID_MARKER_BITS * PAGE_ID_MARKER_SIZE_MM + (PAGE_ID_MARKER_BITS - 1) * PAGE_ID_MARKER_GAP_MM;
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

  const pages: BiblePrintPage[] = [];
  const ensurePage = (pageIndex: number) => {
    if (!pages[pageIndex]) {
      pages[pageIndex] = { index: pageIndex, blocks: [], boxes: [] };
    }
    return pages[pageIndex];
  };
  let columnIndex = 0;
  let columnY = 0;

  for (const book of BIBLE_BOOKS) {
    const rows = Math.ceil(book.chapters / chaptersPerRow);
    const blockHeight = labelHeightMm + labelGapMm + rows * boxPitchMm + blockGapMm;
    if (columnY + blockHeight > contentHeightMm && columnY > 0) {
      columnIndex += 1;
      columnY = 0;
    }

    const pageIndex = Math.floor(columnIndex / columnCount);
    const columnInPage = columnIndex % columnCount;
    const originX = margin.left + columnInPage * (columnWidthMm + columnGapMm);
    const originY = contentTopMm + columnY;
    const page = ensurePage(pageIndex);

    const boxes: BiblePrintChapterBox[] = [];
    for (let chapter = 1; chapter <= book.chapters; chapter += 1) {
      const idx = chapter - 1;
      const row = Math.floor(idx / chaptersPerRow);
      const col = idx % chaptersPerRow;
      boxes.push({
        bookId: book.id,
        chapter,
        x: originX + col * boxPitchMm,
        y: originY + labelHeightMm + labelGapMm + row * boxPitchMm,
      });
    }

    const block: BiblePrintBookBlock = {
      bookId: book.id,
      name: book.name,
      x: originX,
      y: originY,
      rows,
      boxes,
    };

    page.blocks.push(block);
    page.boxes.push(...boxes);
    columnY += blockHeight;
  }

  if (!pages.length) {
    pages.push({ index: 0, blocks: [], boxes: [] });
  }

  const pageIdPositions = Array.from({ length: PAGE_ID_MARKER_BITS }, (_, index) => ({
    x: pageIdOriginXMm + index * (PAGE_ID_MARKER_SIZE_MM + PAGE_ID_MARKER_GAP_MM),
    y: pageIdOriginYMm,
  }));
  const pageIdPatterns = buildBiblePageIdPatterns(pages.length);

  return {
    version: layoutVersion,
    page: {
      widthMm: pageWidthMm,
      heightMm: pageHeightMm,
      count: pages.length,
    },
    header: {
      topMm: headerTopMm,
      heightMm: headerHeightMm,
      widthMm: pageWidthMm - margin.left - margin.right,
      leftMm: margin.left,
    },
    content: {
      topMm: contentTopMm,
      heightMm: contentHeightMm,
    },
    columns: {
      count: columnCount,
      widthMm: columnWidthMm,
      gapMm: columnGapMm,
    },
    boxes: {
      sizeMm: boxSizeMm,
      gapMm: boxGapMm,
      pitchMm: boxPitchMm,
      perRow: chaptersPerRow,
    },
    labels: {
      heightMm: labelHeightMm,
      gapMm: labelGapMm,
    },
    blockGapMm,
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
      count: PAGE_ID_MARKER_BITS,
      positionsMm: pageIdPositions,
      patterns: pageIdPatterns,
    },
    pages,
  };
}
