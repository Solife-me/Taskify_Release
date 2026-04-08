import React, { useMemo, useCallback } from "react";
import type { CalendarEvent } from "../../domains/tasks/taskTypes";
import { normalizeTimeZone } from "../../domains/dateTime/dateUtils";
import { isoDatePart } from "../../domains/dateTime/dateUtils";
import { toNpub } from "../../lib/nostr";
import { isUrlLike, extractFirstUrl } from "../../lib/urlPreview";
import { stripUrlsFromText } from "../task/TaskTitle";
import { EventTitle, EventMedia } from "../task/TaskMedia";
import type { TaskDocument } from "../../lib/documents";

export function isEventCardDragEnabled(isSelectionMode?: boolean, isDraggable?: boolean) {
  return Boolean(isDraggable) && !isSelectionMode;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getDraggedEventId(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) return null;
  const id = dataTransfer.getData("text/event-id");
  return id || null;
}

function formatTimeLabel(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const safeZone = normalizeTimeZone(timeZone);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(safeZone ? { timeZone: safeZone } : {}),
  });
}

export function EventCard({
  event,
  onEdit,
  showDate,
  meta,
  trailing,
  onOpenDocument,
  onDragStart,
  onDragEnd,
  isSelectionMode,
  isSelected,
  onToggleSelect,
}: {
  event: CalendarEvent;
  onEdit?: () => void;
  showDate?: boolean;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  onOpenDocument?: (event: CalendarEvent, doc: TaskDocument) => void;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const iconSizeStyle = useMemo(() => ({ "--icon-size": "1.85rem" } as React.CSSProperties), []);
  const creatorNpub = useMemo(() => toNpub(event.createdBy || event.boardPubkey || ""), [event.createdBy, event.boardPubkey]);
  const lastEditorNpub = useMemo(
    () => toNpub(event.lastEditedBy || event.createdBy || event.boardPubkey || ""),
    [event.lastEditedBy, event.createdBy, event.boardPubkey],
  );
  const dateKey = useMemo(() => {
    if (event.kind === "date") return ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : isoDatePart(new Date().toISOString());
    return isoDatePart(event.startISO, event.startTzid);
  }, [event]);
  const timeLabel = useMemo(() => {
    if (event.kind === "date") {
      const startKey = ISO_DATE_PATTERN.test(event.startDate) ? event.startDate : dateKey;
      const endKey = event.endDate && ISO_DATE_PATTERN.test(event.endDate) && event.endDate >= startKey ? event.endDate : "";
      const formatShort = (key: string) => {
        const parsed = new Date(`${key}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return key;
        return parsed.toLocaleDateString([], { month: "short", day: "numeric" });
      };
      const isMultiDay = !!(endKey && endKey !== startKey);
      if (!showDate) {
        return isMultiDay ? `All-day • ${formatShort(startKey)} – ${formatShort(endKey)}` : "";
      }
      if (isMultiDay) {
        return `All-day • ${formatShort(startKey)} – ${formatShort(endKey)}`;
      }
      return formatShort(startKey);
    }

    const start = formatTimeLabel(event.startISO, event.startTzid);
    const end = event.endISO ? formatTimeLabel(event.endISO, event.endTzid || event.startTzid) : "";
    const core = end ? `${start} – ${end}` : start;
    if (!showDate) return core;
    const parsed = new Date(`${dateKey}T00:00:00`);
    const dateLabel = Number.isNaN(parsed.getTime())
      ? dateKey
      : parsed.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${core} • ${dateLabel}`;
  }, [dateKey, event, showDate]);
  const locationLabel = useMemo(() => {
    const loc = event.locations?.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
    return loc || "";
  }, [event.locations]);
  const metaNode = meta ?? (locationLabel ? locationLabel : null);
  const hasUrl = useMemo(
    () => isUrlLike(event.title) || Boolean(extractFirstUrl(`${event.description || ""} ${(event.references || []).join(" ")}`)),
    [event.description, event.references, event.title],
  );
  const hasDetail =
    !!stripUrlsFromText(event.description) ||
    (event.documents && event.documents.length > 0) ||
    hasUrl;
  const isInteractive = typeof onEdit === "function";
  const isDraggable = typeof onDragStart === "function";
  const dragEnabled = isEventCardDragEnabled(isSelectionMode, isDraggable);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (isSelectionMode && onToggleSelect) {
        onToggleSelect(event.id);
        return;
      }
      onEdit?.();
    },
    [event.id, isSelectionMode, onEdit, onToggleSelect],
  );
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dragEnabled || !onDragStart) return;
      e.dataTransfer.setData("text/event-id", event.id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
      onDragStart(event.id);
    },
    [dragEnabled, event.id, onDragStart],
  );
  const handleDragEnd = useCallback(() => {
    onDragEnd?.();
  }, [onDragEnd]);

  return (
    <div
      className="task-card group relative select-none"
      data-form={hasDetail ? "stacked" : "pill"}
      data-event-id={event.id}
      data-agent-entity="event"
      data-agent-creator-npub={creatorNpub || undefined}
      data-agent-last-editor-npub={lastEditorNpub || undefined}
      style={{ touchAction: "auto" }}
      draggable={dragEnabled}
      onDragStart={dragEnabled ? handleDragStart : undefined}
      onDragEnd={dragEnabled ? handleDragEnd : undefined}
    >
      <div className="flex items-start gap-3">
        {isSelectionMode ? (
          <div
            className="flex-shrink-0 flex items-center justify-center pt-1"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onToggleSelect?.(event.id);
            }}
            role="checkbox"
            aria-checked={isSelected}
            tabIndex={0}
          >
            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--secondary)]'}`}>
              {isSelected ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> : null}
            </div>
          </div>
        ) : null}
        <div className="icon-button flex-shrink-0" style={iconSizeStyle} aria-hidden="true">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="pointer-events-none h-[18px] w-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </div>
        <div
          className={`flex-1 min-w-0 space-y-1 ${isInteractive || isSelectionMode ? "cursor-pointer" : ""}`}
          role={isInteractive || isSelectionMode ? "button" : undefined}
          tabIndex={isInteractive || isSelectionMode ? 0 : undefined}
          onClick={() => {
            if (isSelectionMode && onToggleSelect) {
              onToggleSelect(event.id);
              return;
            }
            onEdit?.();
          }}
          onKeyDown={isInteractive || isSelectionMode ? handleKeyDown : undefined}
        >
          <div className="task-card__title">{event.title ? <EventTitle event={event} /> : "Untitled"}</div>
          {timeLabel ? <div className="text-xs text-secondary">{timeLabel}</div> : null}
          {metaNode ? <div className="task-card__meta">{metaNode}</div> : null}
        </div>
        {trailing ? <div className="flex-shrink-0 pt-0.5">{trailing}</div> : null}
      </div>
      <EventMedia event={event} onOpenDocument={onOpenDocument} />
    </div>
  );
}
