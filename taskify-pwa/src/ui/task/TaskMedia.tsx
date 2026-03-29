import React, { useState, useMemo, useCallback } from "react";
import type { Task } from "../../domains/tasks/taskTypes";
import type { CalendarEvent } from "../../domains/tasks/taskTypes";
import type { TaskDocument } from "../../lib/documents";
import { useUrlPreview } from "../../lib/urlPreview";
import type { UrlPreviewData } from "../../lib/urlPreview";
import { extractFirstUrl, isUrlLike } from "../../lib/urlPreview";
import { autolink, stripUrlsFromText, fallbackTitleFromUrl, useTaskPreview } from "./TaskTitle";
import { DocumentThumbnail } from "./DocumentPreviewModal";
import { ImagePreviewModal } from "./ImagePreviewModal";

export function UrlPreviewCard({ preview }: { preview: UrlPreviewData; indent?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(preview.image && !imageFailed);
  const hasIcon = Boolean(!hasImage && preview.icon);
  const siteLabel = preview.siteName || preview.displayUrl;
  const mediaClass = hasImage ? "h-40 w-full" : "flex min-h-[3.25rem] w-full items-center justify-center bg-surface";

  const textContent = (
    <>
      <div className="truncate font-medium text-primary">{preview.title || preview.displayUrl}</div>
      {preview.description && (
        <div
          className="text-tertiary overflow-hidden text-ellipsis"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
        >
          {preview.description}
        </div>
      )}
      <div className="text-tertiary text-[10px] uppercase tracking-wide">{siteLabel}</div>
    </>
  );

  const card = (
    <a
      href={preview.finalUrl || preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full max-w-full overflow-hidden rounded-2xl border border-surface bg-surface-muted"
    >
      {hasImage ? (
        <>
          <div className={mediaClass}>
            <img
              src={preview.image!}
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="space-y-1 p-3 text-xs text-secondary">{textContent}</div>
        </>
      ) : hasIcon ? (
        <div className="flex items-start gap-3 p-3 text-xs text-secondary">
          <img src={preview.icon!} className="h-10 w-10 flex-shrink-0 rounded-lg border border-surface object-contain bg-surface" />
          <div className="space-y-1 flex-1 min-w-0">{textContent}</div>
        </div>
      ) : (
        <div className="space-y-1 p-3 text-xs text-secondary">{textContent}</div>
      )}
    </a>
  );

  return card;
}

export function TaskMedia({
  task,
  indent = false,
  onOpenDocument,
}: {
  task: Task;
  indent?: boolean;
  onOpenDocument?: (task: Task, doc: TaskDocument) => void;
}) {
  const noteText = useMemo(() => stripUrlsFromText(task.note), [task.note]);
  const hasImages = Boolean(task.images && task.images.length);
  const hasDocuments = Boolean(task.documents && task.documents.length);
  const derivedPreview = useTaskPreview(task);
  const hasPreview = Boolean(derivedPreview);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const openPreview = useCallback((src: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewSrc(src);
  }, []);

  if (!noteText && !hasImages && !hasDocuments && !hasPreview) return null;

  const wrapperClasses = "mt-2 space-y-1.5";
  const noteDetailClass = indent ? "task-card__details " : "";

  return (
    <div className={wrapperClasses}>
      {previewSrc && (
        <ImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
      {noteText && (
        <div
          className={`${noteDetailClass}text-xs text-secondary break-words`}
          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {autolink(noteText)}
        </div>
      )}
      {hasImages ? (
        <div className="space-y-2">
          {task.images!.map((img, i) => (
            <img
              key={i}
              src={img}
              className="max-h-40 w-full rounded-2xl object-contain cursor-zoom-in"
              onClick={(e) => openPreview(img, e)}
              role="button"
              aria-label="View full image"
            />
          ))}
        </div>
      ) : null}
      {hasDocuments ? (
        <div className="space-y-2">
          {task.documents!.map((doc) => (
            <DocumentThumbnail
              key={doc.id}
              document={doc}
              onClick={() => onOpenDocument?.(task, doc)}
            />
          ))}
        </div>
      ) : null}
      {derivedPreview && <UrlPreviewCard preview={derivedPreview} />}
    </div>
  );
}

export function useEventPreview(event: CalendarEvent): UrlPreviewData | null {
  const referencesText = useMemo(() => (event.references || []).join(" "), [event.references]);
  const previewSource = useMemo(
    () => `${event.title || ""} ${event.description || ""} ${referencesText}`,
    [event.title, event.description, referencesText],
  );
  return useUrlPreview(previewSource);
}

export function EventTitle({ event }: { event: CalendarEvent }) {
  const derivedPreview = useEventPreview(event);
  const isTitleUrl = isUrlLike(event.title);
  const urlFromTitle = isTitleUrl ? event.title.trim() : null;
  const urlFromDescription = extractFirstUrl(event.description || "");
  const urlFromReferences = extractFirstUrl((event.references || []).join(" "));
  const canonicalUrl = derivedPreview?.finalUrl || derivedPreview?.url || urlFromTitle || urlFromDescription || urlFromReferences;

  if (isTitleUrl) {
    const titleTarget = urlFromTitle || canonicalUrl || event.title.trim();
    const displayTitle = derivedPreview?.title || derivedPreview?.displayUrl || fallbackTitleFromUrl(titleTarget);
    return canonicalUrl ? <span className="link-accent">{displayTitle}</span> : <>{displayTitle}</>;
  }
  if (canonicalUrl) {
    return <span className="link-accent">{event.title}</span>;
  }
  return <>{event.title}</>;
}

export function EventMedia({
  event,
  onOpenDocument,
}: {
  event: CalendarEvent;
  onOpenDocument?: (event: CalendarEvent, doc: TaskDocument) => void;
}) {
  const noteText = useMemo(() => stripUrlsFromText(event.description), [event.description]);
  const hasDocuments = Boolean(event.documents && event.documents.length);
  const derivedPreview = useEventPreview(event);
  const hasPreview = Boolean(derivedPreview);

  if (!noteText && !hasDocuments && !hasPreview) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {noteText && (
        <div
          className="task-card__details text-xs text-secondary break-words"
          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {autolink(noteText)}
        </div>
      )}
      {hasDocuments ? (
        <div className="space-y-2">
          {event.documents!.map((doc) => (
            <DocumentThumbnail
              key={doc.id}
              document={doc}
              onClick={() => onOpenDocument?.(event, doc)}
            />
          ))}
        </div>
      ) : null}
      {derivedPreview && <UrlPreviewCard preview={derivedPreview} />}
    </div>
  );
}
