/**
 * What a task editor's save writes (C8-2). The editor records the task as it built it when it
 * opened; on save, a field the user changed takes the edited value, and a field the user left
 * alone takes the task's current value, which may have changed meanwhile on another device.
 * Fields that only make sense together move as one group, and subtasks merge item by item.
 * Swift has the same rule in `TaskEditorFields`.
 */
import type { Subtask, Task } from "./taskContracts.js";
/** The edited list in its order, each untouched subtask as it is now, then any added elsewhere. */
export declare function mergeSubtaskEdit(opened: readonly Subtask[] | undefined, edited: readonly Subtask[] | undefined, current: readonly Subtask[] | undefined): Subtask[];
/** The task to save: `edited` where the user changed something since `opened`, `current` elsewhere. */
export declare function mergeTaskEdit<T extends Task>(opened: T, edited: T, current: T): T;
