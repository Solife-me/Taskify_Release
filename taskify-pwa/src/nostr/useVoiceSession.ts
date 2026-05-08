/**
 * useVoiceSession — voice-to-task pipeline hook
 *
 * Architecture:
 *   Web Speech API (browser-native) → live transcript
 *   POST /api/voice/extract (Gemini 2.0 Flash) → TaskOperation[] → reducer → candidates
 *   POST /api/voice/finalize (Gemini structured output) → FinalTask[]
 */
import { useCallback, useEffect, useRef, useReducer } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types (mirrored from worker)
// ─────────────────────────────────────────────────────────────────────────────

export type TaskCandidate = {
  id: string;
  title: string;
  dueText?: string;
  boardId?: string;
  subtasks?: string[];
  status: "draft" | "confirmed" | "dismissed";
};

export type TaskOperation = {
  type: "create_task" | "update_task" | "delete_task" | "mark_uncertain";
  title?: string;
  dueText?: string;
  subtasks?: string[];
  targetRef?: string;
  changes?: Partial<Pick<TaskCandidate, "title" | "dueText" | "boardId" | "subtasks">>;
};

export type FinalTask = {
  title: string;
  dueISO?: string;
  boardId?: string;
  notes?: string;
  subtasks?: string[];
  priority?: 1 | 2 | 3;
};

// ─────────────────────────────────────────────────────────────────────────────
// Session state & actions
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceSession = {
  transcript: string;
  interimTranscript: string;
  candidates: TaskCandidate[];
  operations: TaskOperation[];
  isListening: boolean;
  isProcessing: boolean;
  quotaExhausted: boolean;
};

export type VoiceSessionAction =
  | { type: "SET_INTERIM"; text: string }
  | { type: "COMMIT_TRANSCRIPT"; text: string }
  | { type: "APPLY_OPERATIONS"; operations: TaskOperation[] }
  | { type: "SET_PROCESSING"; value: boolean }
  | { type: "SET_LISTENING"; value: boolean }
  | { type: "DISMISS_CANDIDATE"; id: string }
  | { type: "CONFIRM_CANDIDATE"; id: string }
  | { type: "SET_QUOTA_EXHAUSTED" }
  | { type: "RESET" };

export const INITIAL_VOICE_SESSION: VoiceSession = {
  transcript: "",
  interimTranscript: "",
  candidates: [],
  operations: [],
  isListening: false,
  isProcessing: false,
  quotaExhausted: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure reducer — all testable without DOM
// ─────────────────────────────────────────────────────────────────────────────

function generateId(): string {
  // crypto.randomUUID is available in modern browsers and Node 19+
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for test environments
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function applyOperation(candidates: TaskCandidate[], op: TaskOperation): TaskCandidate[] {
  switch (op.type) {
    case "create_task": {
      const newCandidate: TaskCandidate = {
        id: generateId(),
        title: op.title ?? "",
        dueText: op.dueText,
        subtasks: op.subtasks,
        boardId: op.changes?.boardId,
        status: "confirmed",
      };
      return [...candidates, newCandidate];
    }

    case "update_task": {
      if (!candidates.length) return candidates;
      const target = resolveTargetRef(candidates, op.targetRef);
      if (target === -1) return candidates;
      return candidates.map((c, i) => {
        if (i !== target) return c;
        return {
          ...c,
          ...(op.changes?.title !== undefined ? { title: op.changes.title } : {}),
          ...(op.changes?.dueText !== undefined ? { dueText: op.changes.dueText } : {}),
          ...(op.changes?.boardId !== undefined ? { boardId: op.changes.boardId } : {}),
          ...(op.changes?.subtasks !== undefined ? { subtasks: op.changes.subtasks } : {}),
          // top-level title/dueText/subtasks fields on the op also apply
          ...(op.title !== undefined ? { title: op.title } : {}),
          ...(op.dueText !== undefined ? { dueText: op.dueText } : {}),
          ...(op.subtasks !== undefined ? { subtasks: op.subtasks } : {}),
        };
      });
    }

    case "delete_task": {
      if (!candidates.length) return candidates;
      if (op.targetRef === "all") {
        return candidates.map((c) => ({ ...c, status: "dismissed" }));
      }
      const target = resolveTargetRef(candidates, op.targetRef);
      if (target === -1) return candidates;
      return candidates.map((c, i) =>
        i === target ? { ...c, status: "dismissed" } : c,
      );
    }

    case "mark_uncertain": {
      if (!candidates.length) return candidates;
      const target = resolveTargetRef(candidates, op.targetRef);
      if (target === -1) return candidates;
      // mark_uncertain leaves status as draft (already draft on create)
      return candidates.map((c, i) =>
        i === target ? { ...c, status: "draft" } : c,
      );
    }

    default:
      return candidates;
  }
}

/** Returns the array index of the targeted candidate, or -1 if not found. */
function resolveTargetRef(candidates: TaskCandidate[], targetRef: string | undefined): number {
  if (!targetRef || targetRef === "last_task") {
    // Find the last non-dismissed candidate, fallback to absolute last
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].status !== "dismissed") return i;
    }
    return candidates.length - 1;
  }
  if (targetRef.startsWith("task:")) {
    const id = targetRef.slice("task:".length);
    return candidates.findIndex((c) => c.id === id);
  }
  // Try matching by title substring (findLastIndex not available below ES2023 target)
  const lower = targetRef.toLowerCase();
  let idx = -1;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i].title.toLowerCase().includes(lower)) {
      idx = i;
      break;
    }
  }
  return idx;
}

export function voiceSessionReducer(state: VoiceSession, action: VoiceSessionAction): VoiceSession {
  switch (action.type) {
    case "SET_INTERIM":
      return { ...state, interimTranscript: action.text };

    case "COMMIT_TRANSCRIPT": {
      const separator = state.transcript ? " " : "";
      return {
        ...state,
        transcript: state.transcript + separator + action.text,
        interimTranscript: "",
      };
    }

    case "APPLY_OPERATIONS": {
      let candidates = state.candidates;
      for (const op of action.operations) {
        candidates = applyOperation(candidates, op);
      }
      return { ...state, candidates, operations: [...state.operations, ...action.operations] };
    }

    case "SET_PROCESSING":
      return { ...state, isProcessing: action.value };

    case "SET_LISTENING":
      return { ...state, isListening: action.value };

    case "DISMISS_CANDIDATE":
      return {
        ...state,
        candidates: state.candidates.map((c) =>
          c.id === action.id ? { ...c, status: "dismissed" } : c,
        ),
      };

    case "CONFIRM_CANDIDATE":
      return {
        ...state,
        candidates: state.candidates.map((c) =>
          c.id === action.id ? { ...c, status: "confirmed" } : c,
        ),
      };

    case "SET_QUOTA_EXHAUSTED":
      return { ...state, quotaExhausted: true };

    case "RESET":
      return { ...INITIAL_VOICE_SESSION };

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Web Speech API types (not in lib.dom.d.ts by default in all TS versions)
// ─────────────────────────────────────────────────────────────────────────────

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

// Both `SpeechRecognition` and `webkitSpeechRecognition` are accessed via
// `(window as any)` below, so no ambient declaration is needed.

export function isSpeechRecognitionSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    (typeof (window as any).SpeechRecognition === "function" ||
      typeof (window as any).webkitSpeechRecognition === "function")
  );
}

function createSpeechRecognition(): SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec: SpeechRecognition = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  return rec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook options and return type
// ─────────────────────────────────────────────────────────────────────────────

export type UseVoiceSessionOptions = {
  workerBaseUrl: string;
  npub: string;
  defaultBoardId?: string;
  onSave: (tasks: FinalTask[]) => void;
};

export type UseVoiceSessionResult = {
  session: VoiceSession;
  supported: boolean;
  startListening: () => void;
  stopListening: () => void;
  dismissCandidate: (id: string) => void;
  confirmCandidate: (id: string) => void;
  extractFromText: (text: string) => Promise<void>;
  save: () => Promise<void>;
  reset: () => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main hook
// ─────────────────────────────────────────────────────────────────────────────

export function useVoiceSession(options: UseVoiceSessionOptions): UseVoiceSessionResult {
  const { workerBaseUrl, npub, defaultBoardId, onSave } = options;
  const [session, dispatch] = useReducer(voiceSessionReducer, INITIAL_VOICE_SESSION);

  const recRef = useRef<SpeechRecognition | null>(null);
  const sessionStartRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const transcriptRef = useRef<string>("");
  const interimRef = useRef<string>("");
  const candidatesRef = useRef<TaskCandidate[]>([]);
  const quotaExhaustedRef = useRef<boolean>(false);
  const extractedOnceRef = useRef<boolean>(false);

  // Keep refs in sync with state for use in callbacks
  useEffect(() => {
    transcriptRef.current = session.transcript;
    interimRef.current = session.interimTranscript;
    candidatesRef.current = session.candidates;
    quotaExhaustedRef.current = session.quotaExhausted;
  }, [session.transcript, session.interimTranscript, session.candidates, session.quotaExhausted]);

  const callExtract = useCallback(
    async (transcript: string) => {
      if (!transcript.trim() || inFlightRef.current) return;
      inFlightRef.current = true;
      dispatch({ type: "SET_PROCESSING", value: true });

      const sessionDurationSeconds = Math.round((Date.now() - sessionStartRef.current) / 1000);

      try {
        const res = await fetch(`${workerBaseUrl}/api/voice/extract`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            npub,
            transcript,
            candidates: candidatesRef.current,
            sessionDurationSeconds,
          }),
        });

        if (res.status === 429) {
          const body = await res.json() as { error: string; operations?: TaskOperation[] };
          dispatch({ type: "SET_QUOTA_EXHAUSTED" });
          if (Array.isArray(body.operations) && body.operations.length > 0) {
            dispatch({ type: "APPLY_OPERATIONS", operations: body.operations });
          }
          return;
        }

        if (!res.ok) return;

        const body = await res.json() as { operations: TaskOperation[] };
        if (Array.isArray(body.operations) && body.operations.length > 0) {
          dispatch({ type: "APPLY_OPERATIONS", operations: body.operations });
        }
      } catch {
        // Network error — silently skip; next transcript commit will retry
      } finally {
        inFlightRef.current = false;
        dispatch({ type: "SET_PROCESSING", value: false });
      }
    },
    [workerBaseUrl, npub],
  );

  const runFinalExtractPass = useCallback(async () => {
    if (extractedOnceRef.current) return;
    const finalTranscript = [transcriptRef.current, interimRef.current].filter(Boolean).join(" ").trim();
    if (!finalTranscript) return;
    extractedOnceRef.current = true;
    await callExtract(finalTranscript);
  }, [callExtract]);

  const startListening = useCallback(() => {
    if (recRef.current) return; // already running
    const rec = createSpeechRecognition();
    if (!rec) return;

    sessionStartRef.current = Date.now();
    extractedOnceRef.current = false;
    transcriptRef.current = "";
    interimRef.current = "";
    recRef.current = rec;

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          dispatch({ type: "COMMIT_TRANSCRIPT", text });
          transcriptRef.current = [transcriptRef.current, text].filter(Boolean).join(" ").trim();
        } else {
          interim += text;
        }
      }
      interimRef.current = interim;
      dispatch({ type: "SET_INTERIM", text: interim });
    };

    rec.onerror = () => {
      dispatch({ type: "SET_LISTENING", value: false });
      recRef.current = null;
    };

    rec.onend = () => {
      dispatch({ type: "SET_LISTENING", value: false });
      recRef.current = null;
      void runFinalExtractPass();
    };

    rec.start();
    dispatch({ type: "SET_LISTENING", value: true });
  }, [runFinalExtractPass]);

  const stopListening = useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    dispatch({ type: "SET_LISTENING", value: false });
    dispatch({ type: "SET_INTERIM", text: "" });
    void runFinalExtractPass();
  }, [runFinalExtractPass]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recRef.current?.abort();
      recRef.current = null;
    };
  }, []);

  const dismissCandidate = useCallback((id: string) => {
    dispatch({ type: "DISMISS_CANDIDATE", id });
  }, []);

  const confirmCandidate = useCallback((id: string) => {
    dispatch({ type: "CONFIRM_CANDIDATE", id });
  }, []);

  const extractFromText = useCallback(async (text: string) => {
    const transcript = (text || "").trim();
    if (!transcript) return;
    stopListening();
    dispatch({ type: "RESET" });
    dispatch({ type: "COMMIT_TRANSCRIPT", text: transcript });
    transcriptRef.current = transcript;
    interimRef.current = "";
    extractedOnceRef.current = true;
    await callExtract(transcript);
  }, [callExtract, stopListening]);

  const save = useCallback(async () => {
    const confirmed = candidatesRef.current.filter((c) => c.status === "confirmed");
    if (!confirmed.length) return;

    dispatch({ type: "SET_PROCESSING", value: true });
    try {
      const res = await fetch(`${workerBaseUrl}/api/voice/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          npub,
          candidates: confirmed,
          boardId: defaultBoardId,
          referenceDate: new Date().toISOString(),
          referenceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          referenceOffsetMinutes: new Date().getTimezoneOffset(),
        }),
      });
      if (!res.ok) {
        // Fallback: use candidate titles as-is
        const fallback: FinalTask[] = confirmed.map((c) => ({
          title: c.title,
          boardId: c.boardId ?? defaultBoardId,
          subtasks: c.subtasks,
        }));
        onSave(fallback);
        return;
      }
      const body = await res.json() as { tasks: FinalTask[] };
      onSave(Array.isArray(body.tasks) ? body.tasks : []);
    } catch {
      // Network failure fallback
      const fallback: FinalTask[] = confirmed.map((c) => ({
        title: c.title,
        boardId: c.boardId ?? defaultBoardId,
        subtasks: c.subtasks,
      }));
      onSave(fallback);
    } finally {
      dispatch({ type: "SET_PROCESSING", value: false });
    }
  }, [workerBaseUrl, npub, defaultBoardId, onSave]);

  const reset = useCallback(() => {
    stopListening();
    dispatch({ type: "RESET" });
  }, [stopListening]);

  return {
    session,
    supported: isSpeechRecognitionSupported(),
    startListening,
    stopListening,
    dismissCandidate,
    confirmCandidate,
    extractFromText,
    save,
    reset,
  };
}
