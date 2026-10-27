/**
 * The scan engine on synthetic photos of real print layouts: the page is drawn the way
 * `printPdf` prints it (corner markers, finder markers on top, page-id marks, outlined marks)
 * and photographed through a projective transform, with uneven light and noise.
 */
import { describe, expect, test } from "vitest";
import { buildBoardPrintLayout, type BoardPrintLayout } from "../../components/BoardPrintLayout";
import { buildBiblePrintLayout } from "../../components/BibleTrackerPrintLayout";
import { boardScanMarks } from "../../components/BoardScanSheet";
import { bibleScanMarks } from "../../components/BibleTrackerScanSheet";
import { applyHomography, scanPage, solveHomography, type ScanLayout, type ScanMarkGeometry, type ScanPhoto, type ScanPoint } from "./scanEngine";

const INK = 30;
const PAPER = 235;
const TABLE = 70;

type Shape =
  | { kind: "rect"; x: number; y: number; size: number; hollow?: number }
  | { kind: "ring"; cx: number; cy: number; r: number; filled: boolean }
  | { kind: "box"; x: number; y: number; size: number; filled: boolean };

/** Where the page's corners land in the photo, clockwise from top left. */
type Placement = [ScanPoint, ScanPoint, ScanPoint, ScanPoint];

function photograph(layout: ScanLayout, shapes: Shape[], placement: Placement, size = { width: 900, height: 1200 }): ScanPhoto {
  const { widthMm, heightMm } = layout.page;
  const pageCorners = [{ x: 0, y: 0 }, { x: widthMm, y: 0 }, { x: widthMm, y: heightMm }, { x: 0, y: heightMm }];
  const toPage = solveHomography([...placement], pageCorners)!;
  const toImage = solveHomography(pageCorners, [...placement])!;
  const luma = new Uint8ClampedArray(size.width * size.height);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 12;
  };
  const paperAt = (p: ScanPoint) => PAPER * (1 - 0.22 * (p.x / widthMm)) + noise();
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const p = applyHomography({ x: x + 0.5, y: y + 0.5 }, toPage);
      const onPage = p.x >= 0 && p.y >= 0 && p.x <= widthMm && p.y <= heightMm;
      luma[y * size.width + x] = onPage ? paperAt(p) : TABLE + noise();
    }
  }
  const inside = (shape: Shape, p: ScanPoint): boolean => {
    if (shape.kind === "rect") {
      const within = p.x >= shape.x && p.y >= shape.y && p.x <= shape.x + shape.size && p.y <= shape.y + shape.size;
      if (!within || !shape.hollow) return within;
      const inset = (shape.size - shape.size * shape.hollow) / 2;
      return !(p.x > shape.x + inset && p.x < shape.x + shape.size - inset && p.y > shape.y + inset && p.y < shape.y + shape.size - inset);
    }
    if (shape.kind === "ring") {
      const d = Math.hypot(p.x - shape.cx, p.y - shape.cy);
      return shape.filled ? d <= shape.r * 0.9 : d <= shape.r && d >= shape.r - 0.3;
    }
    const within = p.x >= shape.x && p.y >= shape.y && p.x <= shape.x + shape.size && p.y <= shape.y + shape.size;
    if (!within || shape.filled) return within;
    return p.x < shape.x + 0.3 || p.y < shape.y + 0.3 || p.x > shape.x + shape.size - 0.3 || p.y > shape.y + shape.size - 0.3;
  };
  for (const shape of shapes) {
    const [x0, y0, x1, y1] =
      shape.kind === "ring" ? [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r] : [shape.x, shape.y, shape.x + shape.size, shape.y + shape.size];
    const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((c) => applyHomography(c, toImage));
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))));
    const maxX = Math.min(size.width - 1, Math.ceil(Math.max(...corners.map((c) => c.x))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))));
    const maxY = Math.min(size.height - 1, Math.ceil(Math.max(...corners.map((c) => c.y))));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (inside(shape, applyHomography({ x: x + 0.5, y: y + 0.5 }, toPage))) luma[y * size.width + x] = INK + noise();
      }
    }
  }
  const full = { luma, ...size };
  return { full, reduced: full, scale: 1 };
}

function printedFrame(layout: ScanLayout & { markers: { positionsMm: Record<string, ScanPoint> } }, pageIndex: number): Shape[] {
  const shapes: Shape[] = [];
  for (const [corner, pos] of Object.entries(layout.markers.positionsMm)) {
    const finder = layout.markers.styles?.[corner as keyof typeof layout.markers.styles] === "finder";
    shapes.push({ kind: "rect", x: pos.x, y: pos.y, size: layout.markers.sizeMm, ...(finder ? { hollow: 0.45 } : {}) });
  }
  layout.pageId?.positionsMm.forEach((pos, bit) => {
    if (layout.pageId!.patterns[pageIndex]?.[bit]) shapes.push({ kind: "rect", x: pos.x, y: pos.y, size: layout.pageId!.sizeMm });
  });
  return shapes;
}

function boardSheet(layout: BoardPrintLayout, pageIndex: number, filled: Set<string>): Shape[] {
  const r = layout.circle.sizeMm / 2;
  return [
    ...printedFrame(layout, pageIndex),
    ...boardScanMarks(layout, pageIndex).map((mark): Shape => ({ kind: "ring", cx: mark.centerMm.x, cy: mark.centerMm.y, r, filled: filled.has(mark.key) })),
  ];
}

function boardGeometry(layout: BoardPrintLayout): ScanMarkGeometry {
  // As BoardScanSheet samples a task circle.
  const c = layout.circle.sizeMm;
  const ox = Math.max(c * 0.8, 2);
  const oy = Math.max(layout.rows.heightMm * 0.45, c * 0.6);
  return {
    sampleRadiusMm: Math.max(0.55, c * 0.16),
    innerOffsetMm: c * 0.25,
    backgroundOffsets: [{ x: -ox, y: 0 }, { x: -ox, y: -oy }, { x: -ox, y: oy }, { x: 0, y: -oy }, { x: 0, y: oy }],
    backgroundRadiusMm: Math.max(0.7, c * 0.25),
  };
}

const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
const board = buildBoardPrintLayout(tasks);
const scanBoard = (photo: ScanPhoto, pageSelection: number | "auto" = "auto") =>
  scanPage(photo, board, {
    pageSelection,
    pageCount: board.pages.length,
    marksOnPage: (pageIndex) => boardScanMarks(board, pageIndex),
    geometry: boardGeometry(board),
  });

const upright: Placement = [{ x: 60, y: 50 }, { x: 840, y: 50 }, { x: 840, y: 1060 }, { x: 60, y: 1060 }];

describe("scanning a board sheet", () => {
  test("reads exactly the circles filled in, and identifies the page", () => {
    const result = scanBoard(photograph(board, boardSheet(board, 0, new Set(["t1", "t4", "t9"])), upright));
    expect(result.filled).toEqual(["t1", "t4", "t9"]);
    expect(result.pageIndex).toBe(0);
    expect(result.pageIdDetected).toBe(true);
  });

  test("a blank sheet reads as nothing filled", () => {
    expect(scanBoard(photograph(board, boardSheet(board, 0, new Set()), upright)).filled).toEqual([]);
  });

  test("a photo taken upside down is turned the right way by the finder markers", () => {
    const upsideDown: Placement = [upright[2], upright[3], upright[0], upright[1]];
    expect(scanBoard(photograph(board, boardSheet(board, 0, new Set(["t0", "t7"])), upsideDown)).filled).toEqual(["t0", "t7"]);
  });

  test("a photo at an angle, darker on one side, still reads correctly", () => {
    const skewed: Placement = [{ x: 110, y: 80 }, { x: 800, y: 30 }, { x: 870, y: 1120 }, { x: 40, y: 1040 }];
    expect(scanBoard(photograph(board, boardSheet(board, 0, new Set(["t2", "t3", "t11"])), skewed)).filled).toEqual(["t2", "t3", "t11"]);
  });

  test("a page whose corners are out of the photo is refused with a message", () => {
    const cropped: Placement = [{ x: -200, y: -150 }, { x: 900, y: -150 }, { x: 900, y: 1300 }, { x: -200, y: 1300 }];
    expect(() => scanBoard(photograph(board, boardSheet(board, 0, new Set(["t1"])), cropped))).toThrow(/markers/i);
  });
});

describe("scanning the Bible tracker", () => {
  test("reads the chapter boxes filled in", () => {
    const layout = buildBiblePrintLayout("letter");
    const marks = bibleScanMarks(layout, 0);
    const chosen = new Set([marks[0], marks[5], marks[40]].map((m) => `${m.key.bookId}:${m.key.chapter}`));
    const size = layout.boxes.sizeMm;
    const shapes: Shape[] = [
      ...printedFrame(layout, 0),
      ...marks.map((m): Shape => ({ kind: "box", x: m.centerMm.x - size / 2, y: m.centerMm.y - size / 2, size, filled: chosen.has(`${m.key.bookId}:${m.key.chapter}`) })),
    ];
    const gap = layout.boxes.gapMm;
    const offset = size * 0.5 + gap * 0.55;
    const result = scanPage(photograph(layout, shapes, upright), layout, {
      pageSelection: 0,
      pageCount: layout.pages.length,
      marksOnPage: (pageIndex) => bibleScanMarks(layout, pageIndex),
      geometry: {
        sampleRadiusMm: Math.max(0.55, size * 0.14),
        innerOffsetMm: size * 0.23,
        backgroundOffsets: [
          { x: offset, y: 0 }, { x: -offset, y: 0 }, { x: 0, y: offset }, { x: 0, y: -offset },
          { x: offset, y: offset }, { x: -offset, y: offset }, { x: offset, y: -offset }, { x: -offset, y: -offset },
        ],
        backgroundRadiusMm: Math.max(0.7, gap * 0.55),
      },
    });
    expect(result.filled.map((k) => `${k.bookId}:${k.chapter}`).sort()).toEqual([...chosen].sort());
  });
});
