// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { TaskDocument } from "../../lib/documents";
import { DocumentThumbnail } from "./DocumentThumbnail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/documents")>()),
  // The stored preview is what the card shows; regenerating it needs the document libraries.
  loadDocumentPreview: async (doc: TaskDocument) => doc.preview ?? null,
}));

test("an HTML preview is sanitized, with the sanitizer loaded only when needed", async () => {
  const doc: TaskDocument = {
    id: "d1",
    name: "Plan.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "docx",
    dataUrl: "data:,",
    createdAt: "2026-10-18T12:00:00.000Z",
    preview: {
      type: "html",
      data: '<p class="doc-rich">Hello</p><img src="https://tracker.example/p.gif" onerror="alert(1)"><script>alert(2)</script>',
    },
  };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<DocumentThumbnail document={doc} onClick={() => {}} />));

  await vi.waitFor(() => expect(host.querySelector(".doc-thumb__html p")?.textContent).toBe("Hello"));
  const html = host.querySelector(".doc-thumb__html")!.innerHTML;
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("tracker.example");
  await act(async () => root.unmount());
});
