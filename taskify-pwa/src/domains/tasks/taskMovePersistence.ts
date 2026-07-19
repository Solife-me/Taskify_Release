type BoardScopedTask = {
  boardId: string;
};

export class TaskPublishVersionTracker {
  private readonly versions = new Map<string, number>();

  reserve(key: string): number {
    const next = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, next);
    return next;
  }

  isCurrent(key: string, version: number): boolean {
    return this.versions.get(key) === version;
  }

  finish(key: string, version: number): boolean {
    return this.isCurrent(key, version);
  }
}

export function reserveTaskMutationTimestamp(now: number, current: number = 0): number {
  const normalizedNow = Number.isFinite(now) ? Math.floor(now) : 0;
  const normalizedCurrent = Number.isFinite(current) ? Math.floor(current) : 0;
  return Math.max(normalizedNow, normalizedCurrent + 1);
}

export function taskMovePersistencePlan<
  Source extends BoardScopedTask,
  Target extends BoardScopedTask,
>(source: Source, target: Target): {
  sourceToDelete: Source | null;
  targetToPublish: Target;
} {
  return {
    sourceToDelete: source.boardId === target.boardId ? null : source,
    targetToPublish: target,
  };
}
