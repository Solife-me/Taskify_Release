import type { BoardPrintTask } from "../../components/BoardPrintLayout";

export function reviewTasksForScan(ids: string[], catalog: ReadonlyMap<string, BoardPrintTask>): BoardPrintTask[] {
  return ids.flatMap((id) => {
    const task = catalog.get(id);
    return task ? [task] : [];
  });
}

export function defaultSelectedScanIds(tasks: BoardPrintTask[]): Set<string> {
  return new Set(tasks.filter((task) => !task.completed).map((task) => task.id));
}

export function applyableScanIds(tasks: BoardPrintTask[], selected: ReadonlySet<string>): string[] {
  return tasks
    .filter((task) => !task.completed && selected.has(task.id))
    .map((task) => task.id);
}
