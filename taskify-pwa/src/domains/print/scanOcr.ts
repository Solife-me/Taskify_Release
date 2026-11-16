import { createWorker, OEM, PSM } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";
import corePath from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import languagePath from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import type { BoardPrintLayout } from "../../components/BoardPrintLayout";
import { rectifyScanForText, type ScanPhoto, type ScanTextLine } from "./scanEngine";

export async function readChecklistText(photo: ScanPhoto, layout: BoardPrintLayout): Promise<ScanTextLine[]> {
  const { image, scale, toPhoto } = rectifyScanForText(photo, layout);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to read text from the checklist.");
  const rgba = context.createImageData(image.width, image.height);
  for (let pixel = 0; pixel < image.luma.length; pixel += 1) {
    const offset = pixel * 4;
    rgba.data[offset] = rgba.data[offset + 1] = rgba.data[offset + 2] = image.luma[pixel];
    rgba.data[offset + 3] = 255;
  }
  context.putImageData(rgba, 0, 0);
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath,
    corePath,
    langPath: new URL(".", new URL(languagePath, document.baseURI)).href,
    workerBlobURL: false,
  }, { load_system_dawg: "0", load_freq_dawg: "0" });
  try {
    const recognize = async (input: HTMLCanvasElement, mode: PSM, origin = { x: 0, y: 0 }) => {
      await worker.setParameters({ tessedit_pageseg_mode: mode, user_defined_dpi: "180" });
      const { data } = await worker.recognize(input, {}, { blocks: true, text: false });
      return (data.blocks ?? []).flatMap((block) => block.paragraphs).flatMap((paragraph) => paragraph.lines)
        .map(({ text, bbox }) => ({
          text: text.trim(),
          start: toPhoto({ x: origin.x + bbox.x0, y: origin.y + (bbox.y0 + bbox.y1) / 2 }),
        }))
        .filter(({ text }) => !!text);
    };
    const lines = await recognize(canvas, PSM.SPARSE_TEXT);

    // The corner marks and print codes are stronger than a faint title. OCR the title area
    // on its own as well so those graphics cannot dominate text segmentation.
    const header = document.createElement("canvas");
    const origin = { x: 0, y: Math.round((layout.header.topMm - 1) * scale) };
    header.width = Math.round(canvas.width * 0.65);
    header.height = Math.round((layout.content.topMm - 2) * scale) - origin.y;
    const headerContext = header.getContext("2d");
    if (!headerContext) return lines;
    headerContext.drawImage(canvas, 0, origin.y, header.width, header.height, 0, 0, header.width, header.height);
    return [...lines, ...await recognize(header, PSM.SINGLE_BLOCK, origin)];
  } finally {
    await worker.terminate();
  }
}
