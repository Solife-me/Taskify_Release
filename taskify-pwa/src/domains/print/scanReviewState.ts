import type { BoardPrintTask } from "../../components/BoardPrintLayout";

export function mergeBoardScanReview(
  current: BoardPrintTask[],
  detected: BoardPrintTask[],
): BoardPrintTask[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of detected) {
    if (!byId.has(task.id)) byId.set(task.id, task);
  }
  return Array.from(byId.values());
}

export function defaultSelectedScanIds(tasks: BoardPrintTask[]): Set<string> {
  return new Set(tasks.filter((task) => !task.completed).map((task) => task.id));
}

export function applyableScanIds(tasks: BoardPrintTask[], selected: ReadonlySet<string>): string[] {
  return tasks
    .filter((task) => !task.completed && selected.has(task.id))
    .map((task) => task.id);
}
