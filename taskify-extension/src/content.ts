/**
 * The content script: the only part of the extension that touches the page.
 *
 * It runs on demand (the panel asks for a capture), reads the page's own DOM, and hands the
 * result back over the extension's message channel. It never sends anything anywhere itself, and
 * it holds no state between calls.
 */
import { extractReadableText, extractSelection, captureFilename, type PageCapture } from "./lib/capture";

type CaptureRequest = {
  type: "taskify:capture";
  kind: PageCapture["kind"];
};

function buildCapture(kind: PageCapture["kind"]): PageCapture {
  if (kind === "selection") {
    const selection = extractSelection();
    if (selection) {
      return {
        kind: "selection",
        url: selection.url,
        title: selection.title,
        text: selection.text,
        filename: captureFilename("selection", selection.title),
        mimeType: "text/markdown",
      };
    }
    // Nothing selected: the page's readable text is the useful fallback.
  }

  const page = extractReadableText();
  return {
    kind: kind === "selection" ? "text" : kind,
    url: page.url,
    title: page.title,
    text: page.text,
    filename: captureFilename(kind === "selection" ? "text" : kind, page.title),
    mimeType: "text/markdown",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as CaptureRequest;
  if (!request || request.type !== "taskify:capture") return false;
  try {
    sendResponse({ ok: true, capture: buildCapture(request.kind) });
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
});

// Exposed so the capture can be exercised against a real page without the extension's
// messaging channel. The panel never uses this; the content script's own message handler does.
(globalThis as unknown as { taskifyCapture?: (kind: PageCapture["kind"]) => PageCapture }).taskifyCapture =
  buildCapture;
