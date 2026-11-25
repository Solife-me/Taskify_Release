/**
 * Small formatting helpers shared by the panel's views.
 */
import type { Task } from "taskify-core";

/** `Today`, `Tomorrow`, or a short date. */
export function formatDueLabel(dueISO: string | undefined, now = new Date()): string {
  if (!dueISO) return "";
  const due = new Date(dueISO);
  if (Number.isNaN(due.getTime())) return "";

  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(due) - startOf(now)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return due.toLocaleDateString(undefined, { weekday: "long" });
  if (days < -1 && days > -7) return `${Math.abs(days)} days ago`;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Whether a due date has passed. */
export function isOverdue(task: Pick<Task, "dueISO" | "completed">, now = new Date()): boolean {
  if (task.completed || !task.dueISO) return false;
  const due = new Date(task.dueISO);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}

/** A short time, for the chat bubbles. */
export function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The board a task belongs to, by id. */
export function boardName(boardId: string, boards: { id: string; name: string }[]): string {
  return boards.find((board) => board.id === boardId)?.name ?? "No board";
}

/** A short name for a file: its name, trimmed to something that fits a narrow panel. */
export function shortFileName(name: string, max = 34): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${name.slice(0, max - extension.length - 1)}…${extension}`;
}

/** A readable size, for an attachment chip. */
export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
