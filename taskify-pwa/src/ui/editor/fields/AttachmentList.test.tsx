// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { TaskDocument } from "../../../lib/documents";
import { AttachmentList } from "./AttachmentList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = { id: "d1", name: "Plan.pdf", kind: "pdf", mimeType: "application/pdf", dataUrl: "data:,", createdAt: "" } as TaskDocument;

test("lists uploads in progress and attached files; preview and remove act on the file", async () => {
  const onPreview = vi.fn();
  const onRemove = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  const uploading = [{ id: "u1", name: "Big.docx", kind: "docx", progress: 0.4, phase: "uploading" as const, indeterminate: false, progressEventCount: 1, lastProgressAt: 0 }];
  await act(async () => root.render(<AttachmentList documents={[doc]} uploading={uploading} onPreview={onPreview} onRemove={onRemove} />));
  expect(host.querySelector(".doc-edit-row--uploading")?.textContent).toContain("Uploading");
  const buttons = [...host.querySelectorAll("button")];
  await act(async () => buttons.find((b) => b.textContent === "Preview")!.click());
  await act(async () => buttons.find((b) => b.textContent === "Remove")!.click());
  expect(onPreview).toHaveBeenCalledWith(doc);
  expect(onRemove).toHaveBeenCalledWith("d1");
  await act(async () => root.render(<AttachmentList documents={[]} onRemove={onRemove} />));
  expect(host.innerHTML).toBe("");
  await act(async () => root.unmount());
});
