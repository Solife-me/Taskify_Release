import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { TaskDocument } from "../../lib/documents";
import { resolveDocumentAsset } from "./documentAsset";
import type { DownloadProgress } from "../../lib/binary";
import { PdfViewer } from "./viewers/PdfViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { VideoViewer } from "./viewers/VideoViewer";
import { DocumentViewer } from "./viewers/DocumentViewer";
import { SpreadsheetViewer } from "./viewers/SpreadsheetViewer";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(value?: number): string | null {
  if (!value || !Number.isFinite(value)) return null;
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function ViewerShell({
  title,
  subtitle,
  actions,
  children,
  onClose,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] bg-[#111214]/95 text-white" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-6xl flex-col px-3 pb-4 pt-[max(14px,env(safe-area-inset-top))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 pb-3">
          <button type="button" className="ghost-button button-sm pressable" onClick={onClose}>
            Close
          </button>
          <div className="min-w-0 flex-1 text-center">
            <div className="truncate text-sm font-medium text-white">{title}</div>
            {subtitle ? <div className="truncate text-xs text-white/60">{subtitle}</div> : null}
          </div>
          <div className="flex min-w-[72px] justify-end gap-2">{actions}</div>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

const IMAGE_KINDS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const VIDEO_KINDS = new Set(["mp4", "mov", "webm"]);

export function DocumentPreviewModal({
  document,
  boardId,
  onClose,
  onDownloadDocument,
}: {
  document: TaskDocument;
  boardId?: string;
  onClose: () => void;
  onDownloadDocument?: (doc: TaskDocument, boardId?: string) => void;
}) {
  const [resolvedDocument, setResolvedDocument] = useState<TaskDocument>(document);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const label = document.name || "Document";
  const decryptBoardId = document.encryptionBoardId || boardId;

  useEffect(() => {
    let cancelled = false;
    if (!document.remoteUrl) {
      setResolvedDocument(document);
      setLoadingRemote(false);
      setDownloadProgress(null);
      setRemoteError(null);
      return;
    }
    setLoadingRemote(true);
    setDownloadProgress(null);
    setRemoteError(null);
    resolveDocumentAsset(document, boardId, (next) => { if (!cancelled) setDownloadProgress(next); })
      .then((resolved) => {
        if (cancelled) return;
        setResolvedDocument(resolved);
        setLoadingRemote(false);
        setDownloadProgress(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRemoteError((err as Error)?.message || "Failed to decrypt document");
          setLoadingRemote(false);
        }
      });
    return () => { cancelled = true; };
  }, [document, boardId]);

  const doc = resolvedDocument;
  const full = doc.full;

  const subtitle = useMemo(
    () =>
      [doc.kind.toUpperCase(), formatBytes(doc.size), doc.encrypted ? "Encrypted" : null]
        .filter(Boolean)
        .join(" • "),
    [doc],
  );

const actions = (
    <>
      <button
        type="button"
        className="ghost-button button-sm pressable"
        onClick={() => onDownloadDocument?.(doc, decryptBoardId)}
      >
        Download
      </button>
    </>
  );

  let content: React.ReactNode;

  if (loadingRemote) {
    const percent = downloadProgress?.fraction == null ? null : Math.round(downloadProgress.fraction * 100);
    content = (
      <div className="flex h-full items-center justify-center text-white/70" role="status">
        {percent == null ? "Downloading document…" : percent >= 100 ? "Decrypting document…" : `Downloading ${percent}%`}
      </div>
    );
  } else if (remoteError) {
    content = (
      <div className="flex h-full items-center justify-center text-center text-white/70">
        {remoteError}
      </div>
    );
  } else if (doc.kind === "pdf") {
    content = <PdfViewer dataUrl={doc.dataUrl} />;
  } else if (IMAGE_KINDS.has(doc.kind) && full?.type === "image") {
    content = <ImageViewer src={full.data} alt={label} />;
  } else if (VIDEO_KINDS.has(doc.kind) && full?.type === "video") {
    content = (
      <VideoViewer
        src={full.data}
        poster={doc.preview?.type === "image" ? doc.preview.data : undefined}
      />
    );
  } else if (full?.type === "audio") {
    content = (
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-xl rounded-[28px] bg-[#1b1c20] p-6 shadow-2xl">
          <div className="mb-4 text-center text-sm text-white/70">Audio attachment</div>
          <audio controls src={full.data} className="w-full" />
        </div>
      </div>
    );
  } else if (doc.kind === "xlsx" && full?.type === "html") {
    content = <SpreadsheetViewer html={full.data} />;
  } else if (full?.type === "html") {
    content = <DocumentViewer content={{ type: "html", data: full.data }} />;
  } else if (full?.type === "text") {
    content = <DocumentViewer content={{ type: "text", data: full.data }} />;
  } else {
    content = (
      <div className="flex h-full items-center justify-center">
        <div className="rounded-[28px] bg-[#1b1c20] px-6 py-8 text-center text-white/70 shadow-2xl">
          Preview unavailable. Use Download to open the original file.
        </div>
      </div>
    );
  }

  return (
    <ViewerShell title={label} subtitle={subtitle} actions={actions} onClose={onClose}>
      {content}
    </ViewerShell>
  );
}
