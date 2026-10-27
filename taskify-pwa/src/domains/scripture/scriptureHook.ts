import { useState, useEffect, useSyncExternalStore } from "react";
import React from "react";
import type { BibleTrackerState } from "./bibleTrackerModel";
import { sanitizeBibleTrackerState } from "./bibleTrackerModel";
import type { ScriptureMemoryState } from "./scriptureTypes";
import { sanitizeScriptureMemoryState } from "./scriptureUtils";
import { kvStorage } from "../../storage/kvStorage";
import { LS_BIBLE_TRACKER, LS_SCRIPTURE_MEMORY } from "../storageKeys";
import { createStateStore, type StateStore, type StateUpdater } from "../../state/stateStore";

let bibleTracker: StateStore<BibleTrackerState> | null = null;

/**
 * The Bible reading tracker, saved on every change. A store rather than component state, so
 * actions read the current value synchronously and apply each change exactly once.
 */
export function bibleTrackerStore(): StateStore<BibleTrackerState> {
  if (!bibleTracker) {
    let initial = sanitizeBibleTrackerState(null);
    try {
      const raw = kvStorage.getItem(LS_BIBLE_TRACKER);
      if (raw) initial = sanitizeBibleTrackerState(JSON.parse(raw));
    } catch {
      // keep the empty tracker
    }
    const store = createStateStore(initial);
    store.subscribe(() => {
      try {
        kvStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(store.get()));
      } catch {
        // storage full or unavailable: keep the in-memory state
      }
    });
    bibleTracker = store;
  }
  return bibleTracker;
}

function useBibleTracker(): [BibleTrackerState, (update: StateUpdater<BibleTrackerState>) => void] {
  const store = bibleTrackerStore();
  return [useSyncExternalStore(store.subscribe, store.get), store.set];
}

function useScriptureMemory(): [ScriptureMemoryState, React.Dispatch<React.SetStateAction<ScriptureMemoryState>>] {
  const [state, setState] = useState<ScriptureMemoryState>(() => {
    try {
      const raw = kvStorage.getItem(LS_SCRIPTURE_MEMORY);
      if (raw) {
        return sanitizeScriptureMemoryState(JSON.parse(raw));
      }
    } catch {}
    return sanitizeScriptureMemoryState(null);
  });
  useEffect(() => {
    try {
      kvStorage.setItem(LS_SCRIPTURE_MEMORY, JSON.stringify(state));
    } catch {}
  }, [state]);
  return [state, setState];
}

export { useBibleTracker, useScriptureMemory };
