import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { Task } from "../../domains/tasks/taskTypes";
import { bountyStateLabel } from "../../domains/tasks/taskUtils";
import { normalizeTimeZone } from "../../domains/dateTime/dateUtils";
import { toNpub } from "../../lib/nostr";
import { TaskTitle, useTaskPreview } from "./TaskTitle";
import { TaskMedia } from "./TaskMedia";
import type { TaskDocument } from "../../lib/documents";

export function isCardDragEnabled(isSelectionMode?: boolean) {
  return !isSelectionMode;
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

export function getDraggedTaskId(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) return null;
  const id = dataTransfer.getData("text/task-id") || dataTransfer.getData("text/plain");
  return id || null;
}

export function Card({
  task,
  meta,
  trailing,
  onComplete,
  onEdit,
  onDropBefore,
  showStreaks,
  onToggleSubtask,
  onFlyToCompleted,
  onDragStart,
  onDragEnd,
  hideCompletedSubtasks,
  onOpenDocument,
  onDismissInbox,
  isSelectionMode,
  isSelected,
  onToggleSelect,
}: {
  task: Task;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  onComplete: (from?: DOMRect) => void;
  onEdit: () => void;
  onDropBefore: (dragId: string) => void;
  showStreaks: boolean;
  onToggleSubtask: (subId: string) => void;
  onFlyToCompleted: (rect: DOMRect) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  hideCompletedSubtasks: boolean;
  onOpenDocument: (task: Task, doc: TaskDocument) => void;
  onDismissInbox?: () => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [overBefore, setOverBefore] = useState(false);
  const [isStacked, setIsStacked] = useState(false);
  const iconSizeStyle = useMemo(() => ({ '--icon-size': '1.85rem' } as React.CSSProperties), []);
  const visibleSubtasks = useMemo(() => (
    hideCompletedSubtasks
      ? (task.subtasks?.filter((st) => !st.completed) ?? [])
      : (task.subtasks ?? [])
  ), [hideCompletedSubtasks, task.subtasks]);
  const preview = useTaskPreview(task);
  const creatorNpub = useMemo(() => toNpub(task.createdBy || ""), [task.createdBy]);
  const lastEditorNpub = useMemo(
    () => toNpub(task.lastEditedBy || task.completedBy || task.createdBy || ""),
    [task.lastEditedBy, task.completedBy, task.createdBy],
  );
  const hasDetail =
    !!task.note?.trim() ||
    (task.images && task.images.length > 0) ||
    (task.documents && task.documents.length > 0) ||
    (visibleSubtasks.length > 0) ||
    !!task.bounty ||
    Boolean(preview);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;

    let raf = 0;
    const compute = () => {
      const styles = window.getComputedStyle(el);
      const lineHeight = parseFloat(styles.lineHeight || '0');
      if (!lineHeight) {
        setIsStacked(false);
        return;
      }
      const lines = Math.round(el.scrollHeight / lineHeight);
      setIsStacked(lines > 1);
    };

    compute();

    // Use a single debounced resize listener instead of per-card ResizeObserver
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [task.title, task.priority, task.note, task.images?.length, task.documents?.length, visibleSubtasks.length]);

  function handleDragStart(e: React.DragEvent) {
    if (!isCardDragEnabled(isSelectionMode)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/task-id', task.id);
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 0, 0);
    onDragStart(task.id);
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    setOverBefore(e.clientY < midpoint);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const dragId = getDraggedTaskId(e.dataTransfer);
    if (dragId && dragId !== task.id) onDropBefore(dragId);
    setOverBefore(false);
    onDragEnd();
  }
  function handleDragLeave() {
    setOverBefore(false);
  }
  function handleDragEnd() {
    onDragEnd();
  }

  function handleCompleteClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    if (!task.completed) {
      try { onFlyToCompleted(rect); } catch {}
    }
    onComplete(rect);
  }

  const handleEditKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onEdit();
      }
    },
    [onEdit],
  );

  const bountyClass = task.bounty
    ? task.bounty.state === 'unlocked'
      ? 'chip chip-accent'
      : task.bounty.state === 'revoked'
        ? 'chip chip-danger'
        : task.bounty.state === 'claimed'
          ? 'chip chip-warn'
          : 'chip'
    : '';
  const bountyLabel = task.bounty ? bountyStateLabel(task.bounty) : "";

  const stackedForm = isStacked || hasDetail;

  return (
    <div
      ref={cardRef}
      className="task-card group relative select-none"
      data-task-id={task.id}
      data-state={task.completed ? 'completed' : undefined}
      data-form={stackedForm ? 'stacked' : 'pill'}
      data-agent-entity="task"
      data-agent-creator-npub={creatorNpub || undefined}
      data-agent-last-editor-npub={lastEditorNpub || undefined}
      style={{ touchAction: 'auto' }}
      draggable={isCardDragEnabled(isSelectionMode)}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {overBefore && (
        <div
          className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      )}

      <div className="flex items-start gap-3">
        {isSelectionMode && (
          <div 
            className="flex-shrink-0 flex items-center justify-center pt-1" 
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleSelect?.(task.id); }}
            role="checkbox"
            aria-checked={isSelected}
            tabIndex={0}
          >
            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--secondary)]'}`}>
              {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>}
            </div>
          </div>
        )}
        <button
          onClick={(e) => {
            if (isSelectionMode && onToggleSelect) {
              e.preventDefault();
              e.stopPropagation();
              onToggleSelect(task.id);
              return;
            }
            handleCompleteClick(e);
          }}
          aria-label={task.completed ? 'Mark incomplete' : 'Complete task'}
          title={task.completed ? 'Mark incomplete' : 'Mark complete'}
          className="icon-button pressable flex-shrink-0"
          style={iconSizeStyle}
          data-active={task.completed}
        >
          {task.completed && (
            <svg width="18" height="18" viewBox="0 0 24 24" className="pointer-events-none">
              <path
                d="M20.285 6.707l-10.09 10.09-4.48-4.48"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>

        <div
          className="flex-1 min-w-0 cursor-pointer space-y-1"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            if (isSelectionMode && onToggleSelect) {
              e.preventDefault();
              e.stopPropagation();
              onToggleSelect(task.id);
            } else {
              onEdit();
            }
          }}
          onKeyDown={handleEditKeyDown}
        >
          <div
            ref={titleRef}
            className={`task-card__title ${task.completed ? 'task-card__title--done' : ''}`}
          >
            <TaskTitle key={`${task.id}:${task.priority ?? "none"}`} task={task} />
          </div>
          {showStreaks &&
            task.recurrence &&
            (task.recurrence.type === 'daily' || task.recurrence.type === 'weekly') &&
            typeof task.streak === 'number' && task.streak > 0 && (
              <div className="flex items-center gap-1 text-xs text-secondary">
                <span role="img" aria-hidden>
                  🔥
                </span>
                <span>{task.streak}</span>
              </div>
            )}
          {task.dueTimeEnabled && (
            <div className="text-xs text-secondary">
              Due at {formatTimeLabel(task.dueISO, task.dueTimeZone)}
            </div>
          )}
          {meta ? <div className="task-card__meta">{meta}</div> : null}
        </div>
        {trailing ? <div className="flex-shrink-0 pt-0.5">{trailing}</div> : null}
      </div>

      <TaskMedia task={task} indent onOpenDocument={onOpenDocument} />

      {visibleSubtasks.length ? (
        <ul className="task-card__details mt-2 space-y-1.5 text-xs text-secondary">
          {visibleSubtasks.map((st) => (
            <li key={st.id} className="subtask-row">
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => onToggleSubtask(st.id)}
                className="subtask-row__checkbox"
              />
              <span className={`subtask-row__text ${st.completed ? 'line-through text-tertiary' : 'text-secondary'}`}>{st.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {task.inboxItem && !task.completed && onDismissInbox && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="ghost-button button-sm pressable text-rose-400"
            onClick={onDismissInbox}
          >
            Delete
          </button>
        </div>
      )}

      {task.completed && task.bounty && task.bounty.state !== 'claimed' && (
        <div className="task-card__details mt-2 text-xs text-secondary">
          {task.bounty.state === 'unlocked' ? 'Bounty unlocked!' : 'Complete! - Unlock bounty'}
        </div>
      )}

      {task.bounty && (
        <div className="task-card__details mt-2">
          <span className={bountyClass}>
            Bounty {typeof task.bounty.amount === 'number' ? `• ${task.bounty.amount} sats` : ''} • {bountyLabel}
          </span>
        </div>
      )}
    </div>
  );
}
