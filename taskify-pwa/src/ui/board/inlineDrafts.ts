/**
 * What has been typed in each day's or list's "New Task" field, keyed by column. Kept outside
 * React state so a keystroke re-renders only the field being typed in: not `App`, not the board,
 * not the cards.
 */
import { useSyncExternalStore } from "react";
import { createStateStore } from "../../state/stateStore";

const drafts = createStateStore<Record<string, string>>({});

export function getInlineDraft(key: string): string {
  return drafts.get()[key] ?? "";
}

export function setInlineDraft(key: string, value: string): void {
  drafts.set((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
}

export function clearInlineDraft(key: string): void {
  setInlineDraft(key, "");
}

/** The draft for one column; re-renders only when that column's text changes. */
export function useInlineDraft(key: string): string {
  return useSyncExternalStore(drafts.subscribe, () => getInlineDraft(key));
}
