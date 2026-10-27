import type { ReactNode } from "react";
import type { Nip05CheckState } from "../../domains/tasks/contactUtils";
import type { Contact } from "../../lib/contacts";
import type { Task } from "../../domains/tasks/taskTypes";

/** What the task editor gives its bounty slot. */
export type TaskBountyEditorContext = {
  task: Task;
  /** Saves the task with these fields changed, including the editor's unsaved edits. */
  saveWith: (overrides: Partial<Task>) => unknown;
  contacts: Contact[];
  nip05Cache: Record<string, Nip05CheckState>;
};

/**
 * Bounty editing, supplied by the wallet where it is enabled (`ui/wallet/TaskBountyEditor`). The
 * task editor imports no wallet code: without this, it shows bounties copy-only.
 */
export type TaskBountyExtension = {
  renderSection: (context: TaskBountyEditorContext) => ReactNode;
  renderActions?: (context: { task: Task }) => ReactNode;
};
