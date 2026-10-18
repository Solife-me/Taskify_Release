import { useState, useEffect } from "react";
import React from "react";
import type { BibleTrackerState } from "./bibleTrackerModel";
import { sanitizeBibleTrackerState } from "./bibleTrackerModel";
import type { ScriptureMemoryState } from "./scriptureTypes";
import { sanitizeScriptureMemoryState } from "./scriptureUtils";
import { kvStorage } from "../../storage/kvStorage";
import { LS_BIBLE_TRACKER, LS_SCRIPTURE_MEMORY } from "../storageKeys";

function useBibleTracker(): [BibleTrackerState, React.Dispatch<React.SetStateAction<BibleTrackerState>>] {
  const [state, setState] = useState<BibleTrackerState>(() => {
    try {
      const raw = kvStorage.getItem(LS_BIBLE_TRACKER);
      if (raw) {
        return sanitizeBibleTrackerState(JSON.parse(raw));
      }
    } catch {}
    return sanitizeBibleTrackerState(null);
  });
  useEffect(() => {
    try {
      kvStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(state));
    } catch {}
  }, [state]);
  return [state, setState];
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
