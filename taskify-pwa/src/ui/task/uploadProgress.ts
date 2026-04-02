import type React from "react";
import type { TaskDocument } from "../../lib/documents";

export type UploadingDocumentRow = {
  id: string;
  name: string;
  kind: string;
  progress: number;
  phase: "uploading" | "processing";
  indeterminate: boolean;
  progressEventCount: number;
  lastProgressAt: number | null;
};

export function createUploadingDocumentRow(doc: TaskDocument, fallbackName: string): UploadingDocumentRow {
  return {
    id: `${doc.id}-uploading`,
    name: doc.name || fallbackName || "attachment",
    kind: doc.kind.toUpperCase(),
    progress: 0,
    phase: "uploading",
    indeterminate: true,
    progressEventCount: 0,
    lastProgressAt: null,
  };
}

export function updateUploadingDocumentRowProgress(rows: UploadingDocumentRow[], id: string, progress: number): UploadingDocumentRow[] {
  const now = Date.now();
  const clamped = Math.max(0, Math.min(progress, 1));
  return rows.map((row) => {
    if (row.id !== id) return row;
    const progressEventCount = row.progressEventCount + 1;
    const hasMeaningfulProgress = progressEventCount >= 2 || clamped >= 0.12;
    return {
      ...row,
      progress: clamped,
      indeterminate: !hasMeaningfulProgress,
      progressEventCount,
      lastProgressAt: now,
    };
  });
}

export function setUploadingDocumentRowPhase(rows: UploadingDocumentRow[], id: string, phase: "uploading" | "processing"): UploadingDocumentRow[] {
  return rows.map((row) => (
    row.id === id
      ? { ...row, phase, indeterminate: phase === "uploading" ? row.indeterminate : false, progress: phase === "processing" ? Math.max(row.progress, 1) : row.progress }
      : row
  ));
}

export function markStaleUploadingRowsIndeterminate(rows: UploadingDocumentRow[], now = Date.now()): UploadingDocumentRow[] {
  return rows.map((row) => {
    if (row.phase !== "uploading") return row;
    if (row.lastProgressAt == null) return row;
    if (row.progress >= 1) return row;
    if (now - row.lastProgressAt < 900) return row;
    return { ...row, indeterminate: true };
  });
}

export function removeUploadingDocumentRow(rows: UploadingDocumentRow[], id: string): UploadingDocumentRow[] {
  return rows.filter((row) => row.id !== id);
}

export function startUploadingDotsTimer(
  rowCount: number,
  setUploadingDotPhase: React.Dispatch<React.SetStateAction<number>>,
): (() => void) | undefined {
  if (!rowCount) {
    setUploadingDotPhase(0);
    return undefined;
  }
  const interval = window.setInterval(() => {
    setUploadingDotPhase((prev) => (prev + 1) % 4);
  }, 420);
  return () => window.clearInterval(interval);
}
