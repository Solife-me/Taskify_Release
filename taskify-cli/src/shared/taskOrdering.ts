export function parseTaskOrder(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Order must be a non-negative safe integer.");
  }
  return Number(value);
}

/** Rebalance the selected scope using the same zero-based payload order as the apps. */
export function planTaskReorder<T extends { id: string; boardId: string; order?: number }>(
  tasks: T[], taskRef: string, position: number,
): Array<T & { order: number }> {
  const exact = tasks.find((task) => task.id === taskRef);
  const matches = exact ? [exact] : tasks.filter((task) => task.id.startsWith(taskRef));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous task ID: ${taskRef}` : `Task not found in selected scope: ${taskRef}`);
  if (new Set(tasks.map((task) => task.boardId)).size > 1) {
    throw new Error("Reorder requires a single source board. Select a child board for compound boards.");
  }
  if (!Number.isSafeInteger(position) || position < 1 || position > tasks.length) {
    throw new Error(`Position must be between 1 and ${tasks.length}.`);
  }
  const ordered = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const task = matches[0];
  ordered.splice(ordered.findIndex((candidate) => candidate.id === task.id), 1);
  ordered.splice(position - 1, 0, task);
  return ordered.flatMap((candidate, order) => candidate.order === order ? [] : [{ ...candidate, order }]);
}
