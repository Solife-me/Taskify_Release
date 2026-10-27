/**
 * Small flights across the screen that show where something went: a check to Completed, a new
 * task to its column or to Upcoming. Each draws into `layer` (a fixed overlay)
 * and cleans up after itself.
 */
import { isListLikeBoard } from "taskify-core";
import { taskWeekday } from "../../domains/dateTime/dateUtils";
import { compoundColumnKey, isVisibleNow } from "../../domains/tasks/boardUtils";
import type { Board, Task } from "../../domains/tasks/taskTypes";

/** Where a newly added task appears: a day or list column, or Upcoming when it is hidden for now. */
export type TaskArrivalDestination =
  | { type: "column"; key: string; label: string }
  | { type: "upcoming"; label: string };

export function flyCheckToTarget(layer: HTMLElement | null, targetEl: HTMLElement | null, from: DOMRect): void {
  if (!layer || !targetEl) return;
  const target = targetEl.getBoundingClientRect();

  const startX = from.left + from.width / 2;
  const startY = from.top + from.height / 2;
  const endX = target.left + target.width / 2;
  const endY = target.top + target.height / 2;

  const rem = (() => {
    try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
  })();
  const dotSize = 1.25 * rem; // 20px @ 16px base
  const dotFont = 0.875 * rem; // 14px @ 16px base

  const rootStyles = getComputedStyle(document.documentElement);
  const accent = rootStyles.getPropertyValue("--accent").trim() || "#34c759";
  const accentSoft = rootStyles.getPropertyValue("--accent-soft").trim() || "rgba(52, 199, 89, 0.28)";
  const accentOn = rootStyles.getPropertyValue("--accent-on").trim() || "#0a1f12";

  const dot = document.createElement('div');
  dot.style.position = 'fixed';
  dot.style.left = `${startX - dotSize / 2}px`;
  dot.style.top = `${startY - dotSize / 2}px`;
  dot.style.width = `${dotSize}px`;
  dot.style.height = `${dotSize}px`;
  dot.style.borderRadius = '9999px';
  dot.style.background = accent;
  dot.style.color = accentOn || '#ffffff';
  dot.style.display = 'grid';
  dot.style.placeItems = 'center';
  dot.style.fontSize = `${dotFont}px`;
  dot.style.lineHeight = `${dotSize}px`;
  dot.style.boxShadow = `0 0 0 2px ${accentSoft || 'rgba(16,185,129,0.3)'}, 0 6px 16px rgba(0,0,0,0.35)`;
  dot.style.zIndex = '1000';
  dot.style.transform = 'translate(0, 0) scale(1)';
  dot.style.transition = 'transform 600ms cubic-bezier(.2,.7,.3,1), opacity 300ms ease 420ms';
  dot.textContent = '✓';
  layer.appendChild(dot);

  requestAnimationFrame(() => {
    const dx = endX - startX;
    const dy = endY - startY;
    dot.style.transform = `translate(${dx}px, ${dy}px) scale(0.5)`;
    dot.style.opacity = '0.6';
    setTimeout(() => {
      try { layer.removeChild(dot); } catch {}
    }, 750);
  });
}

export function flyTaskCard(
  layer: HTMLElement | null,
  from: DOMRect | null,
  dest: TaskArrivalDestination,
  /** The column or the Upcoming button the card flies to, looked up once it can be measured. */
  findTarget: () => HTMLElement | null,
): void {
  if (!layer) return;
  if (typeof window === "undefined") return;
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
  } catch {}

  requestAnimationFrame(() => {
    const targetEl = findTarget();
    if (!targetEl) return;

    const targetRect = targetEl.getBoundingClientRect();
    const startRect = from ?? targetRect;
    const startX = startRect.left + startRect.width / 2;
    const startY = startRect.top + startRect.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    const endY =
      dest.type === "column"
        ? targetRect.top + Math.min(targetRect.height / 2, 56)
        : targetRect.top + targetRect.height / 2;

    const card = document.createElement("div");
    const text = (dest.label || "Task").trim();
    const truncated = text.length > 60 ? `${text.slice(0, 57)}…` : text || "Task";
    const widthSource = from ? from.width : startRect.width;
    const cardWidth = Math.max(Math.min(widthSource * 0.55, 280), 150);
    card.className = `fly-task-card ${
      dest.type === "column" ? "fly-task-card--board" : "fly-task-card--upcoming"
    }`;
    card.style.position = "fixed";
    card.style.left = `${startX}px`;
    card.style.top = `${startY}px`;
    card.style.width = `${cardWidth}px`;
    card.style.transform = "translate(-50%, -50%) scale(0.92)";
    card.style.opacity = "0.98";
    card.style.pointerEvents = "none";
    card.style.zIndex = "1000";
    card.style.boxShadow =
      dest.type === "column"
        ? "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(16,185,129,0.2)"
        : "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(59,130,246,0.2)";
    card.style.willChange = "transform, left, top, opacity";

    const body = document.createElement("div");
    body.className = "fly-task-card__body";

    const titleEl = document.createElement("div");
    titleEl.className = "fly-task-card__title";
    titleEl.textContent = truncated;
    body.appendChild(titleEl);

    card.appendChild(body);
    layer.appendChild(card);

    const pulseClass =
      dest.type === "column" ? "fly-target-pulse-board" : "fly-target-pulse-upcoming";
    targetEl.classList.add(pulseClass);
    window.setTimeout(() => {
      try {
        targetEl.classList.remove(pulseClass);
      } catch {}
    }, 650);

    requestAnimationFrame(() => {
      card.style.left = `${endX}px`;
      card.style.top = `${endY}px`;
      card.style.transform = "translate(-50%, -50%) scale(0.75)";
      card.style.opacity = "0";
      window.setTimeout(() => {
        try {
          layer.removeChild(card);
        } catch {}
      }, 700);
    });
  });
}

export function taskArrivalDestination(
  task: Task,
  board: Board,
  /** For a compound board, the child board and list a task's list comes from. */
  compoundSource: (boardId: string, columnId: string) => { boardId: string; columnId: string } | undefined,
): TaskArrivalDestination | null {
  if (!board || task.completed) return null;
  const labelSource = task.title || (task.images?.length ? "Image" : task.documents?.[0]?.name || "");
  const label = labelSource.trim() || "Task";
  if (!isVisibleNow(task)) {
    return { type: "upcoming", label };
  }

  if (board.kind === "week") {
    const dueWeekday = taskWeekday(task);
    if (dueWeekday == null) return null;
    return { type: "column", key: `week-day-${dueWeekday}`, label };
  } else if (isListLikeBoard(board) && task.columnId) {
    let columnKey: string | null = null;
    if (board.kind === "compound") {
      const source = compoundSource(task.boardId, task.columnId);
      if (source) {
        columnKey = compoundColumnKey(source.boardId, source.columnId);
      }
    } else {
      columnKey = task.columnId;
    }
    if (columnKey) return { type: "column", key: `list-${columnKey}`, label };
  }
  return null;
}
