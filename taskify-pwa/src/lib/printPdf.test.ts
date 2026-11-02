// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { buildBoardPrintLayout, type BoardPrintJob } from "../components/BoardPrintLayout";
import { buildBoardPrintPdf } from "./printPdf";

afterEach(() => vi.restoreAllMocks());

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
