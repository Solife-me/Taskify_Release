/** Attached documents in the task and event editors: uploads in progress, then the files. */
import { useEffect, useState } from "react";
import type { TaskDocument } from "../../../lib/documents";
import { startUploadingDotsTimer, type UploadingDocumentRow } from "../../task/uploadProgress";

export function AttachmentList({
  documents,
  uploading = [],
  onPreview,
  onRemove,
  disabled = false,
}: {
  documents: TaskDocument[];
  uploading?: UploadingDocumentRow[];
  onPreview?: (doc: TaskDocument) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const [dotPhase, setDotPhase] = useState(0);
  useEffect(() => startUploadingDotsTimer(uploading.length, setDotPhase), [uploading.length]);
  if (!uploading.length && !documents.length) return null;
  return (
    <ul className="space-y-1">
      {uploading.map((doc) => (
        <li key={doc.id} className="doc-edit-row doc-edit-row--uploading">
          <div className="doc-edit-row__info">
            <div className="doc-edit-row__name" title={doc.name}>{doc.name}</div>
            <div className="doc-edit-row__meta">{doc.kind}</div>
          </div>
          <div className="doc-edit-row__actions">
            <span className="doc-edit-row__status">
              {doc.phase === "processing" ? "Processing" : "Uploading"}
              <span className="doc-edit-row__dots">{".".repeat(dotPhase)}</span>
            </span>
          </div>
          <div
            className={`doc-edit-row__progress${doc.indeterminate ? " doc-edit-row__progress--indeterminate" : ""}`}
            aria-hidden="true"
          >
            <div
              className={`doc-edit-row__progress-bar${doc.indeterminate ? " doc-edit-row__progress-bar--indeterminate" : ""}`}
              style={doc.indeterminate ? undefined : { width: `${Math.max(12, Math.round(doc.progress * 100))}%` }}
            />
          </div>
        </li>
      ))}
      {documents.map((doc) => (
        <li key={doc.id} className="doc-edit-row">
          <div className="doc-edit-row__info">
            <div className="doc-edit-row__name" title={doc.name}>{doc.name}</div>
            <div className="doc-edit-row__meta">{doc.kind.toUpperCase()}</div>
          </div>
          <div className="doc-edit-row__actions">
            <button type="button" className="ghost-button button-sm pressable" onClick={() => onPreview?.(doc)}>
              Preview
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable text-rose-500"
              onClick={() => onRemove(doc.id)}
              disabled={disabled}
            >
              Remove
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
