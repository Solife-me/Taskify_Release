# Voice Dictation — Implementation Plan

**Status:** READY TO IMPLEMENT  
**Feature branch:** `feat/cli-pwa-feature-parity`  
**Last updated:** 2026-03-24

---

## Overview

Two-phase voice-to-task pipeline:
- **Phase A (Live extraction):** Web Speech API transcript → POST `/api/voice/extract` → Gemini 2.0 Flash → `operations[]` → PWA reducer animates task cards live
- **Phase B (Finalization):** User reviews candidates → POST `/api/voice/finalize` → Gemini structured output → `tasks[]` → written to Nostr

---

## Files to Create / Modify

### Worker (backend)

| File | Action | Purpose |
|------|--------|---------|
| `worker/migrations/0002_voice_quota.sql` | **CREATE** | D1 table for per-user daily quota tracking |
| `worker/src/index.ts` | **MODIFY** | Add `GEMINI_API_KEY` to `Env`, `voice_quota` in `ensureSchema`, two route handlers |
| `worker/src/index.test.ts` | **MODIFY** | Append voice endpoint tests (10 tests) |

### PWA (frontend)

| File | Action | Purpose |
|------|--------|---------|
| `taskify-pwa/src/nostr/useVoiceSession.ts` | **CREATE** | Hook: Web Speech API + reducer + Gemini extract loop |
| `taskify-pwa/src/nostr/useVoiceSession.test.ts` | **CREATE** | Reducer unit tests (pure functions only, no DOM) |
| `taskify-pwa/src/components/VoiceDictationModal.tsx` | **CREATE** | Review UI: mic button, live transcript, candidate cards, selective save |

---

## Shared Types

These types are defined in the worker and mirrored in the PWA hook:

```ts
// ── Task candidate (live, in-memory only) ──────────────────────────────────
type TaskCandidate = {
  id: string              // uuid, frontend-generated
  title: string
  dueText?: string        // raw "tomorrow 3pm" — resolved at finalize time
  boardId?: string
  status: 'draft' | 'confirmed' | 'dismissed'
}

// ── Operation returned by /api/voice/extract ───────────────────────────────
type TaskOperation = {
  type: 'create_task' | 'update_task' | 'delete_task' | 'mark_uncertain'
  title?: string          // for create_task / update_task
  dueText?: string        // for create_task / update_task
  targetRef?: string      // "last_task", "task:<id>", or positional hint
  changes?: Partial<Pick<TaskCandidate, 'title' | 'dueText' | 'boardId'>>
}

// ── Full voice session state (in hook) ────────────────────────────────────
type VoiceSession = {
  transcript: string
  interimTranscript: string   // dimmed/italic while speaking
  candidates: TaskCandidate[]
  operations: TaskOperation[]
  isListening: boolean
  isProcessing: boolean       // Gemini call in-flight
  quotaExhausted: boolean
}
```

---

## D1 Schema — `voice_quota`

```sql
-- worker/migrations/0002_voice_quota.sql
CREATE TABLE IF NOT EXISTS voice_quota (
  npub         TEXT    NOT NULL,
  date         TEXT    NOT NULL,   -- YYYY-MM-DD UTC
  session_count INTEGER NOT NULL DEFAULT 0,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (npub, date)
);
```

**Quota limits** (constants in `index.ts`):
```ts
const VOICE_MAX_SESSIONS_PER_DAY = 5
const VOICE_MAX_SECONDS_PER_DAY = 300   // 5 minutes total audio per day
```

---

## Worker API

### `POST /api/voice/extract`

**Request body:**
```json
{
  "npub": "npub1...",
  "transcript": "call dentist friday 2pm also pick up groceries",
  "candidates": [],                  // current candidate array (for update/delete ops)
  "sessionDurationSeconds": 12       // elapsed audio seconds (for quota tracking)
}
```

**Happy path:**
1. Validate: `npub` present + starts with "npub", `transcript` non-empty string
2. Require `GEMINI_API_KEY` — 501 if not configured
3. Query quota row: `SELECT * FROM voice_quota WHERE npub=? AND date=?`
4. If `session_count >= VOICE_MAX_SESSIONS_PER_DAY` OR `total_seconds >= VOICE_MAX_SECONDS_PER_DAY`:
   - Return 429 `{ error: "quota_exceeded", operations: <rule_based_fallback> }`
   - Fallback: split transcript on commas / "and" / "also" → create_task per segment (best-effort, no AI)
5. Call Gemini 2.0 Flash:
   - Model: `gemini-2.0-flash`
   - System prompt: extracts operations from transcript (see Gemini prompts section)
   - Parse JSON response
6. If Gemini fails (network error, bad JSON): return fallback rule-based operations (not a 500)
7. Upsert quota: `INSERT ... ON CONFLICT DO UPDATE SET session_count=session_count+1, total_seconds=total_seconds+?`
8. Return 200 `{ operations: TaskOperation[] }`

**Error responses:**
- 400: missing/invalid npub or transcript
- 429: quota exceeded
- 501: GEMINI_API_KEY not configured

---

### `POST /api/voice/finalize`

**Request body:**
```json
{
  "npub": "npub1...",
  "candidates": [
    { "id": "abc", "title": "Call dentist", "dueText": "friday 2pm", "status": "confirmed" },
    { "id": "def", "title": "Pick up groceries", "status": "confirmed" }
  ],
  "boardId": "board-xyz",     // optional default board
  "referenceDate": "2026-03-24T18:00:00Z"   // user's local "now" for relative date resolution
}
```

**Happy path:**
1. Validate: `npub` present, `candidates` non-empty array of confirmed tasks
2. Filter to `status === 'confirmed'` only
3. Require `GEMINI_API_KEY` — 501 if not configured
4. For each confirmed candidate, call Gemini to normalize:
   - Resolve `dueText` → ISO 8601 datetime (relative to `referenceDate`)
   - Return validated task fields
5. If Gemini fails: return tasks with `dueISO: undefined` (title-only fallback — never 500)
6. Return 200 `{ tasks: FinalTask[] }`

**`FinalTask` shape:**
```ts
type FinalTask = {
  title: string
  dueISO?: string     // ISO 8601, undefined if not parseable
  boardId?: string
  notes?: string
}
```

**Error responses:**
- 400: missing npub, empty candidates array, or no confirmed candidates

---

## Gemini Prompts

### Extract prompt (Phase A)
```
You are a voice task extraction assistant. Given a voice transcript, extract task operations.

Current candidates: {JSON.stringify(candidates)}

Transcript: "{transcript}"

Return a JSON object with shape: { "operations": TaskOperation[] }

Rules:
- create_task: new task mentioned
- update_task: correction of existing task (use targetRef "last_task" or match by title)
- delete_task: user says "never mind", "remove", "cancel that", "scratch that"
- mark_uncertain: unclear/ambiguous intent

Keep titles concise. Extract dueText verbatim from the transcript (e.g. "friday 2pm", "tomorrow morning").
Return ONLY valid JSON.
```

### Finalize prompt (Phase B — per candidate)
```
You are a task normalization assistant. Given a task candidate, return a normalized task.

Reference date (user's now): {referenceDate}

Task: { "title": "{title}", "dueText": "{dueText}" }

Return JSON with shape: { "title": string, "dueISO": string | null }

Rules:
- Normalize title (capitalize properly, remove filler words)
- Resolve dueText to ISO 8601 UTC datetime relative to the reference date
- If dueText is absent or unparseable, return dueISO: null
Return ONLY valid JSON.
```

---

## `useVoiceSession` Hook Architecture

```ts
// taskify-pwa/src/nostr/useVoiceSession.ts

type UseVoiceSessionOptions = {
  workerBaseUrl: string
  npub: string
  defaultBoardId?: string
  onSave: (tasks: FinalTask[]) => void
}

// Pure reducer (testable without DOM)
export function voiceSessionReducer(
  state: VoiceSession,
  action: VoiceSessionAction,
): VoiceSession

// Main hook
export function useVoiceSession(options: UseVoiceSessionOptions): {
  session: VoiceSession
  startListening: () => void
  stopListening: () => void
  dismissCandidate: (id: string) => void
  confirmCandidate: (id: string) => void
  save: () => Promise<void>
  reset: () => void
}
```

**Actions:**
```ts
type VoiceSessionAction =
  | { type: 'SET_INTERIM'; text: string }
  | { type: 'COMMIT_TRANSCRIPT'; text: string }
  | { type: 'APPLY_OPERATIONS'; operations: TaskOperation[] }
  | { type: 'SET_PROCESSING'; value: boolean }
  | { type: 'SET_LISTENING'; value: boolean }
  | { type: 'DISMISS_CANDIDATE'; id: string }
  | { type: 'CONFIRM_CANDIDATE'; id: string }
  | { type: 'SET_QUOTA_EXHAUSTED' }
  | { type: 'RESET' }
```

**Key reducer behaviors (each must have a test):**
- `APPLY_OPERATIONS` with `create_task` → appends new candidate with `status: 'draft'`
- `APPLY_OPERATIONS` with `update_task` targeting `last_task` → mutates last candidate in-place
- `APPLY_OPERATIONS` with `delete_task` → sets status to `'dismissed'`
- `APPLY_OPERATIONS` with `mark_uncertain` → sets status to `'draft'` (no-op if already uncertain)
- `DISMISS_CANDIDATE` → sets status to `'dismissed'`
- `CONFIRM_CANDIDATE` → sets status to `'confirmed'`
- `RESET` → returns initial state
- Multiple sequential operations applied in order

**Debounce / call loop:**
- Gemini extract call debounced 1500ms after last `isFinal` transcript
- Live interim transcripts update UI immediately (no Gemini call)
- Only one in-flight Gemini call at a time (queue/cancel)
- Post-EOSE: 150ms micro-batch coalescer for live events (not relevant here, but same pattern)

---

## `VoiceDictationModal` Component

**Props:**
```ts
type VoiceDictationModalProps = {
  isOpen: boolean
  onClose: () => void
  onSave: (tasks: FinalTask[]) => void
  workerBaseUrl: string
  npub: string
  defaultBoardId?: string
}
```

**Layout (single screen, no full-page loaders):**
```
┌─────────────────────────────────────┐
│  🎙 Voice Add Tasks           [×]   │
│                                     │
│  [transcript area]                  │
│  "Call dentist friday 2pm..."       │
│  also pick up groceries_            │  ← interim: dimmed/italic
│                                     │
│  ┌──────────────────────────────┐   │
│  │ ☑ Call dentist               │   │  ← confirmed card
│  │   Fri, Mar 28 · 2:00 PM      │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │ ☑ Pick up groceries          │   │  ← confirmed card
│  └──────────────────────────────┘   │
│                                     │
│  [● Listening…] [Processing…]       │  ← mic pulse / processing indicator
│                                     │
│  [Stop]          [Save 2 Tasks]     │
└─────────────────────────────────────┘
```

**UX rules (non-negotiable):**
- Interim transcript dimmed/italic, solidifies on `isFinal`
- Task cards animate in: slide-up + fade
- In-place card mutation on corrections (no replace-all)
- Mic pulse animation while `isListening`
- `"Processing…"` micro-indicator (inline, not modal) during Gemini call
- NO full-page loading states
- NO "submit transcript" button
- Only `status: 'confirmed'` cards shown in save count

---

## Build Order

### Step 1 — Worker: D1 migration + schema
1. Create `worker/migrations/0002_voice_quota.sql`
2. Add `voice_quota` to `ensureSchema()` in `index.ts`

### Step 2 — Worker: Types + Env
1. Add `GEMINI_API_KEY: string` to `Env` interface
2. Add `TaskCandidate`, `TaskOperation`, `VoiceExtractRequest`, `VoiceFinalizeRequest`, `FinalTask` types
3. Add quota constants

### Step 3 — Worker: Route handlers
1. `handleVoiceExtract()` 
2. `handleVoiceFinalize()`
3. Add routes to `fetch()` router
4. Add `voice_quota` to `MockD1` for tests

### Step 4 — PWA: `useVoiceSession` hook
1. Pure reducer + types
2. Web Speech API integration
3. Gemini extract debounce loop
4. Finalize flow

### Step 5 — PWA: `VoiceDictationModal`
1. Layout + transcript display
2. Candidate cards with animations
3. Mic pulse + processing indicator
4. Selective save flow

---

## Quota Table in MockD1

The mock needs a new `quota` map:
```ts
quota = new Map<string, { session_count: number; total_seconds: number }>()
// key: `${npub}:${date}`
```

And handle:
- `SELECT * FROM voice_quota WHERE npub=? AND date=?`
- `INSERT INTO voice_quota ... ON CONFLICT DO UPDATE SET ...`

---

## Edge Cases

| Case | Handling |
|------|---------|
| Web Speech API not supported | Show "Voice not supported in this browser" in modal, no mic button |
| Gemini network error on extract | Rule-based fallback (split on comma/"and"/"also"), no 500 |
| Gemini network error on finalize | Return tasks with title only, `dueISO: undefined` |
| Quota exceeded mid-session | Return 429 + fallback operations; set `quotaExhausted: true` in hook state; show "Daily limit reached" banner |
| Empty transcript | Skip Gemini call entirely |
| User says "never mind all of that" | `delete_task` with `targetRef: "all"` → dismiss all candidates |
| Duplicate task detection | Not implemented v1 — Gemini may emit `mark_uncertain` for ambiguous re-mentions |
| `referenceDate` missing in finalize | Default to `new Date().toISOString()` on server |
| `boardId` not specified | Omit from FinalTask; PWA selects active board |

---

## wrangler.toml addition needed

```toml
# Add to .dev.vars for local dev:
# GEMINI_API_KEY = "your-key-here"
```

The `GEMINI_API_KEY` is a Worker secret — set via `wrangler secret put GEMINI_API_KEY` for production. No `wrangler.toml` binding needed (secrets are implicit).
