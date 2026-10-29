/**
 * An attachment's thumbnail on a task card. Kept apart from the document viewer, so cards do not
 * load the viewers or the HTML sanitizer; the sanitizer loads only for an HTML (Word) preview.
 */
import React, { useEffect, useState } from "react";
import type { TaskDocument, TaskDocumentPreview } from "../../lib/documents";
import { loadDocumentPreview } from "../../lib/documents";
import { resolveDocumentAsset } from "./documentAsset";
import type { DownloadProgress } from "../../lib/binary";

function SanitizedHtmlPreview({ html }: { html: string }) {
  const [safeHtml, setSafeHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSafeHtml(null);
    void import("../../lib/sanitize").then(({ sanitizeHtml }) => {
      if (!cancelled) setSafeHtml(sanitizeHtml(html));
    });
    return () => {
      cancelled = true;
    };
  }, [html]);
  if (safeHtml === null) return <div className="doc-thumb__html" />;
  return <div className="doc-thumb__html" dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}

export function DocumentThumbnail({
  document: doc,
  boardId,
  onClick,
}: {
  document: TaskDocument;
  boardId?: string;
  onClick: () => void;
}) {
  const [derivedPreview, setDerivedPreview] = useState<TaskDocumentPreview | null>(doc.preview ?? null);
  const [loading, setLoading] = useState(Boolean(doc.remoteUrl));
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDerivedPreview(doc.preview ?? null);
    setLoading(Boolean(doc.remoteUrl));
    setProgress(null);
    resolveDocumentAsset(doc, boardId, (next) => { if (!cancelled) setProgress(next); })
      .then((resolved) => loadDocumentPreview(resolved))
      .then((next) => { if (!cancelled) setDerivedPreview(next); })
      .catch(() => { if (!cancelled) setDerivedPreview(doc.preview ?? null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [doc, boardId]);

  const preview = derivedPreview ?? doc.preview ?? null;
  const label = doc.name || "Document";

  let previewNode: React.ReactNode;
  if (preview?.type === "image") {
    previewNode = <img src={preview.data} alt="" className="doc-thumb__image" />;
  } else if (preview?.type === "html") {
    previewNode = <SanitizedHtmlPreview html={preview.data} />;
  } else if (preview?.type === "text") {
    previewNode = <pre className="doc-thumb__text">{preview.data.split(/\n+/).slice(0, 6).join("\n")}</pre>;
  } else if (loading) {
    const percent = progress?.fraction == null ? null : Math.round(progress.fraction * 100);
    previewNode = (
      <div className="doc-thumb__placeholder">
        {percent == null ? "Downloading…" : percent >= 100 ? "Decrypting…" : `Downloading ${percent}%`}
      </div>
    );
  } else {
    previewNode = <div className="doc-thumb__placeholder">{doc.kind.toUpperCase()}</div>;
  }

  return (
    <button type="button" className="doc-thumb" onClick={onClick}>
      <div className="doc-thumb__preview">{previewNode}</div>
      <div className="doc-thumb__footer" style={{ display: 'none' }}>
        <span className="doc-thumb__name" title={label}>{label}</span>
        <span className="doc-thumb__kind">{doc.kind.toUpperCase()}</span>
      </div>
    </button>
  );
}
