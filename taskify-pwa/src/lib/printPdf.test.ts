// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { buildBoardPrintLayout, type BoardPrintJob } from "../components/BoardPrintLayout";
import { buildBoardPrintPdf } from "./printPdf";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a board PDF draws the job code the scanner requires", async () => {
  const rects: { x: number; y: number; size: number; fillStyle: unknown }[] = [];
  let canvasWidth = 0;
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === "fillRect") {
        return (x: number, y: number, size: number) => rects.push({ x, y, size, fillStyle: target.fillStyle });
      }
      if (key === "measureText") return () => ({ width: 0 });
      return key in target ? target[key] : () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    canvasWidth = this.width;
    return context as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob);
  });

  const job = {
    id: "current-print",
    boardName: "Board",
    printedAtISO: "2026-11-01T00:00:00.000Z",
    tasks: [{ id: "a", title: "A" }],
  } as unknown as BoardPrintJob;
  await buildBoardPrintPdf({ job, paperSize: "letter" });

  const layout = buildBoardPrintLayout(job.tasks, { jobId: job.id, paperSize: "letter" });
  const jobCode = layout.jobCode!;
  const pxPerMm = canvasWidth / layout.page.widthMm;
  jobCode.positionsMm.forEach((pos, bit) => {
    const drawn = rects.find(
      (rect) => Math.abs(rect.x - pos.x * pxPerMm) < 1 && Math.abs(rect.y - pos.y * pxPerMm) < 1 && Math.abs(rect.size - jobCode.sizeMm * pxPerMm) < 1,
    );
    expect(drawn?.fillStyle).toBe(jobCode.pattern[bit] ? "#101828" : "#ffffff");
  });
});

test("a board PDF prints a task's detail line beneath its title", async () => {
  const texts: string[] = [];
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === "fillText") return (value: string) => texts.push(value);
      if (key === "measureText") return () => ({ width: 0 });
      return key in target ? target[key] : () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return context as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob);
  });

  const job = {
    id: "detail-print",
    boardName: "Board",
    printedAtISO: "2026-11-01T00:00:00.000Z",
    tasks: [{ id: "a", title: "A task", detail: "Sep 4, 2026 · buy milk" }],
  } as unknown as BoardPrintJob;
  await buildBoardPrintPdf({ job, paperSize: "letter" });

  expect(texts).toContain("A task");
  expect(texts).toContain("Sep 4, 2026 · buy milk");
});

test("a detailed board PDF draws its subtasks and photo thumbnails", async () => {
  const texts: string[] = [];
  const images: unknown[] = [];
  vi.stubGlobal("Image", class {
    naturalWidth = 120;
    naturalHeight = 90;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  });
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === "fillText") return (value: string) => texts.push(value);
      if (key === "drawImage") return (...args: unknown[]) => images.push(args);
      if (key === "measureText") return () => ({ width: 0 });
      return key in target ? target[key] : () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return context as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob);
  });

  const job = {
    id: "detail-print",
    boardName: "Board",
    printedAtISO: "2026-11-01T00:00:00.000Z",
    layoutVersion: "v4",
    tasks: [{
      id: "a",
      title: "A task",
      detail: "Sep 4, 2026",
      subtasks: [{ title: "Buy stamps", completed: true }],
      photos: ["data:image/jpeg;base64,AA"],
    }],
  } as unknown as BoardPrintJob;
  await buildBoardPrintPdf({ job, paperSize: "letter" });

  expect(texts).toContain("Buy stamps");
  expect(images).toHaveLength(1);
});
