// Voice dictation — extracted from index.ts (Item #12 worker module split, pass 4).
//
// Pipeline:
//   handleVoiceExtract: raw transcript → TaskOperation[] (Gemini primary, GLM
//     fallback, rule-based fallback when both fail/exceed quota).
//   handleVoiceFinalize: candidate tasks → finalized FinalTask[] with dueISO,
//     priority, board hint, subtasks. Daily per-npub quota enforced via D1.

import type { Env, D1Database } from "./lib.ts";
import { requireDb, jsonResponse, parseJson } from "./lib.ts";
import { normalizeVoiceDue, voiceLocalDates } from "./voice-dates.ts";
import { normalizeNostrPublicKey, verifyTaskifyAuth } from "./nostr-auth.ts";

// ---- Constants ----

const VOICE_MAX_SESSIONS_PER_DAY = 10;
const VOICE_MAX_SECONDS_PER_DAY = 300;

const GEMINI_MODEL_PRIMARY = "gemini-3.5-flash-lite";
const GEMINI_MODEL_FALLBACK_1 = "gemini-3.7-flash";
const GEMINI_MODEL_FALLBACK_2 = "gemini-3.6-flash";

// ---- Types ----

type TaskCandidate = {
  id: string;
  title: string;
  dueText?: string;
  reminderText?: string;
  notes?: string;
  recurrenceText?: string;
  boardId?: string;
  subtasks?: string[];
  status: "draft" | "confirmed" | "dismissed";
};

// Wire format for recurrence on finalized voice tasks. Mirrors the PWA's
// taskify-core Recurrence shape (minus untilISO) so the client can assign it
// directly to Task.recurrence.
type VoiceRecurrence =
  | { type: "none" }
  | { type: "daily" }
  | { type: "weekly"; days: number[] }
  | { type: "every"; n: number; unit: "hour" | "day" | "week" }
  | { type: "monthlyDay"; day: number; interval?: number };

// Optional board context supplied by the client so the model can route tasks
// to a named board/list when the user asks for one.
type VoiceBoardContext = {
  id: string;
  name: string;
  kind: string;
  columns?: { id: string; name: string }[];
};

type TaskOperation = {
  type: "create_task" | "update_task" | "delete_task" | "mark_uncertain";
  title?: string;
  dueText?: string;
  reminderText?: string;
  notes?: string;
  recurrenceText?: string;
  subtasks?: string[];
  targetRef?: string;
  changes?: Partial<Pick<TaskCandidate, "title" | "dueText" | "reminderText" | "boardId" | "subtasks" | "notes" | "recurrenceText">>;
};

type FinalTask = {
  title: string;
  dueISO?: string;
  boardId?: string;
  columnId?: string;
  notes?: string;
  subtasks?: string[];
  priority?: 1 | 2 | 3;
  reminderMinutesBeforeDue?: number[];
  reminderTime?: string;
  recurrence?: VoiceRecurrence;
};

type VoiceQuotaRow = {
  npub: string;
  date: string;
  session_count: number;
  total_seconds: number;
};

// ---- Helpers + handlers ----

// ─────────────────────────────────────────────────────────────────────────────
// Voice dictation helpers
// ─────────────────────────────────────────────────────────────────────────────

function utcDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Rule-based fallback: split transcript on commas / "and" / "also" to produce
 * create_task operations without any AI. Used when Gemini is unavailable or
 * quota is exhausted.
 */
function ruleBasedOperations(transcript: string): TaskOperation[] {
  const segments = transcript
    .split(/,|\band\b|\balso\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.map((title) => ({ type: "create_task" as const, title }));
}

function isGarbageTaskTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (t.length < 4) return true;
  if (/^(and|also|then|so|i|i\s+need|i\s+have|uh|um|like)$/.test(t)) return true;
  return false;
}

function cleanupTaskTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^(?:and\s+then|and|then|also)\s+/i, "");
  title = title.replace(/^(?:please\s+)?(?:remind|notify|alert|nudge|ping)\s+me\s+(?:to|about|that)\s*/i, "");
  title = title.replace(/^(?:set|create|add)\s+(?:a\s+)?(?:reminder|notification|alert)\s+(?:to|for|about)\s*/i, "");
  title = title.replace(/^(?:i\s+need\s+to|i\s+have\s+to|i(?:'| a)?m\s+going\s+to|i\s+can(?:not|'?t)\s+forget\s+to|there(?:'s|\s+is)\s+|we\s+have\s+(?:a\s+)?)\s*/i, "");
  title = title.replace(/^to\s+/i, "");
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

function extractPickupItems(title: string): string[] {
  const m = title.match(/^(?:pick\s+up|get|buy)\s+(?:some\s+)?(.+)$/i);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw) return [];
  const splitByDelims = raw.split(/,|\band\b/i).map((v) => v.trim()).filter(Boolean);
  if (splitByDelims.length > 1) return splitByDelims;
  return [];
}

function normalizeSubtasks(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  return out.length ? out : undefined;
}

function normalizeReminderText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /^null$/i.test(trimmed) || /^none$/i.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeReminderMinutes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    const n = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isFinite(n)) continue;
    const rounded = Math.round(n);
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    out.push(rounded);
  }
  return out.length ? out : undefined;
}

function normalizeReminderTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.includes(":")) return undefined;
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number.parseInt(hourRaw ?? "", 10);
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function hasExplicitReminderRequest(candidate: TaskCandidate): boolean {
  if (normalizeReminderText(candidate.reminderText)) return true;
  const text = `${candidate.title || ""} ${candidate.dueText || ""}`.toLowerCase();
  return /\b(remind\s+me|set\s+(?:a\s+)?reminder|add\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|alert\s+me|notify\s+me|nudge\s+me|ping\s+me|notification)\b/.test(text);
}

function dedupe(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.length ? out : undefined;
}

function applyTranscriptCorrections(operations: TaskOperation[], transcript: string): TaskOperation[] {
  if (!operations.length) return operations;
  const out = [...operations];
  const lower = transcript.toLowerCase();

  const correction = lower.match(/actually\s+change\s+the\s+([^.,;]+?)\s+to\s+([^.,;]+)/i);
  if (correction) {
    const targetPhrase = correction[1].trim();
    const newTime = correction[2].trim();
    const targetIdx = out.findIndex((op) =>
      op.type === "create_task" &&
      typeof op.title === "string" &&
      op.title.toLowerCase().includes(targetPhrase.replace(/\b(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i, "").trim()),
    );
    if (targetIdx >= 0) {
      const priorDue = out[targetIdx].dueText ?? "";
      const day = priorDue.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+sunday|next\s+monday|next\s+tuesday|next\s+wednesday|next\s+thursday|next\s+friday|next\s+saturday)\b/i)?.[0];
      out[targetIdx] = {
        ...out[targetIdx],
        dueText: day ? `${day} at ${newTime}` : newTime,
      };
    }
  }

  return out;
}

function toOperationsFromStructuredTasks(result: unknown): TaskOperation[] {
  const tasks = Array.isArray((result as any)?.tasks) ? ((result as any).tasks as any[]) : [];
  if (!tasks.length) return [];
  const operations: TaskOperation[] = [];

  for (const t of tasks) {
    let title = typeof t?.title === "string" ? cleanupTaskTitle(t.title) : "";
    if (isGarbageTaskTitle(title)) continue;

    let dueText = typeof t?.dueText === "string" && t.dueText.trim() ? t.dueText.trim() : undefined;
    const reminderText = normalizeReminderText(t?.reminderText);
    const notes = typeof t?.notes === "string" && t.notes.trim() ? t.notes.trim() : undefined;
    const recurrenceText = typeof t?.recurrenceText === "string" && t.recurrenceText.trim() ? t.recurrenceText.trim() : undefined;
    let subtasks = normalizeSubtasks(t?.subtasks);

    const groceryContext = /grocery|groceries|store|shopping|supermarket/i.test(`${title} ${dueText ?? ""}`);
    const pickupItems = extractPickupItems(title);
    if (groceryContext && pickupItems.length) {
      const prev = operations[operations.length - 1];
      if (prev?.type === "create_task" && /grocery|store|shopping/i.test(prev.title || "")) {
        prev.subtasks = dedupe([...(prev.subtasks || []), ...pickupItems]);
        continue;
      }
      title = "Go to the grocery store";
      subtasks = dedupe([...(subtasks || []), ...pickupItems]);
    }

    const inlineDue = title.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (inlineDue && !dueText) {
      dueText = inlineDue[1];
      title = title.replace(new RegExp(`\\b${inlineDue[1]}\\b`, "i"), "").replace(/\s+/g, " ").trim();
    }

    const dayPrefix = title.match(/^(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b\s*(.*)$/i);
    if (dayPrefix) {
      if (!dueText) dueText = dayPrefix[1];
      if (dayPrefix[2]) title = dayPrefix[2].trim();
    }

    const birthday = title.match(/^([A-Za-z][A-Za-z' -]{1,40})\s+has\s+a\s+birthday\s+party/i);
    if (birthday) {
      const who = birthday[1].trim().replace(/\s+/g, " ");
      title = `${who}'s birthday party`;
    }
    const birthdayFor = title.match(/^birthday\s+party(?:\s+for)?\s+([A-Za-z][A-Za-z' -]{1,40})/i);
    if (birthdayFor) {
      const who = birthdayFor[1].trim().replace(/\s+/g, " ");
      title = `Birthday party for ${who}`;
    }

    const dinnerAfterChurch = title.match(/dinner\s+after\s+church/i);
    if (dinnerAfterChurch) {
      title = "Dinner after church";
    }

    if (isGarbageTaskTitle(title)) continue;
    operations.push({ type: "create_task", title, dueText, reminderText, notes, recurrenceText, subtasks });
  }

  return operations;
}

function normalizeRecurrence(value: unknown): VoiceRecurrence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as any;
  const type = typeof r.type === "string" ? r.type : "";
  if (type === "daily") return { type: "daily" };
  if (type === "weekly") {
    if (!Array.isArray(r.days)) return undefined;
    const days = [...new Set(
      r.days
        .map((d: unknown) => (typeof d === "number" ? Math.round(d) : Number(d)))
        .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6),
    )] as number[];
    return days.length ? { type: "weekly", days } : undefined;
  }
  if (type === "every") {
    const n = Math.round(Number(r.n));
    if (!Number.isFinite(n) || n < 1 || n > 999) return undefined;
    if (r.unit !== "hour" && r.unit !== "day" && r.unit !== "week") return undefined;
    return { type: "every", n, unit: r.unit };
  }
  if (type === "monthlyDay") {
    const day = Math.round(Number(r.day));
    if (!Number.isFinite(day) || day < 1 || day > 31) return undefined;
    const intervalRaw = Math.round(Number(r.interval));
    const interval = Number.isFinite(intervalRaw) && intervalRaw > 1 ? intervalRaw : undefined;
    return interval ? { type: "monthlyDay", day, interval } : { type: "monthlyDay", day };
  }
  return undefined;
}

function parseTaskPriority(value: unknown): 1 | 2 | 3 | undefined {
  const n = typeof value === "number" ? Math.round(value) : Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return undefined;
}

function parseDueTextFallback(dueText: string, referenceDate: string, referenceOffsetMinutes = 0): string | undefined {
  const text = dueText.trim().toLowerCase();
  if (!text) return undefined;

  const refUtcMs = Date.parse(referenceDate);
  const safeRefUtcMs = Number.isNaN(refUtcMs) ? Date.now() : refUtcMs;
  const safeOffsetMinutes = Number.isFinite(referenceOffsetMinutes) ? referenceOffsetMinutes : 0;

  // Represent user's local wall-clock time on a UTC-based Date object.
  const localNow = new Date(safeRefUtcMs - safeOffsetMinutes * 60_000);

  const dayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  const dayMatch = text.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (!dayMatch) return undefined;

  const targetLocal = new Date(localNow.getTime());
  const dayWord = dayMatch[1];

  if (dayWord === "tomorrow") {
    targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
  } else if (dayWord !== "today" && dayWord !== "tonight") {
    const targetDow = dayMap[dayWord];
    const currentDow = targetLocal.getUTCDay();
    let delta = (targetDow - currentDow + 7) % 7;
    if (delta === 0) delta = 7;
    targetLocal.setUTCDate(targetLocal.getUTCDate() + delta);
  }

  let hours: number | undefined;
  let minutes = 0;

  if (/\bnoon\b/.test(text)) {
    hours = 12;
  } else if (/\bmidnight\b/.test(text)) {
    hours = 0;
  } else {
    const tm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (tm) {
      const h = Number(tm[1]);
      const m = tm[2] ? Number(tm[2]) : 0;
      if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
        hours = h % 12;
        if (tm[3] === "pm") hours += 12;
        minutes = m;
      }
    }
  }

  if (hours === undefined) return undefined;

  const y = targetLocal.getUTCFullYear();
  const m = targetLocal.getUTCMonth();
  const d = targetLocal.getUTCDate();

  // local wall-clock -> UTC
  const utcMs = Date.UTC(y, m, d, hours, minutes, 0, 0) + safeOffsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

async function getVoiceQuota(db: D1Database, npub: string, date: string): Promise<VoiceQuotaRow | null> {
  return db
    .prepare<VoiceQuotaRow>("SELECT npub, date, session_count, total_seconds FROM voice_quota WHERE npub = ? AND date = ?")
    .bind(npub, date)
    .first<VoiceQuotaRow>();
}

async function incrementVoiceQuota(db: D1Database, npub: string, date: string, addSeconds: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO voice_quota (npub, date, session_count, total_seconds)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(npub, date) DO UPDATE SET
         session_count = session_count + 1,
         total_seconds = total_seconds + ?`,
    )
    .bind(npub, date, addSeconds, addSeconds)
    .run();
}

/**
 * Call the configured Gemini Flash models and parse the JSON embedded in the first candidate's
 * text part. Returns null on any error (network, parse, unexpected shape).
 */
function parseJsonStringSafely(text: unknown): unknown | null {
  if (typeof text !== "string") return null;
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// Bound the response body as well as headers. Four provider attempts fit within the
// native clients' 60-second request window, leaving time for auth, quota, and transit.
async function fetchVoiceJSON(url: string, init: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(apiKey: string, prompt: string): Promise<unknown | null> {
  const models = [GEMINI_MODEL_PRIMARY, GEMINI_MODEL_FALLBACK_1, GEMINI_MODEL_FALLBACK_2];
  for (const model of models) {
    const json = await fetchVoiceJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 1.0,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
          },
        }),
      },
    );
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = parseJsonStringSafely(text);
    if (parsed) return parsed;
  }
  return null;
}

async function callCloudflareGlmFallback(env: Env, prompt: string): Promise<unknown | null> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) return null;
  const json = await fetchVoiceJSON(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/zai-org/glm-5.3-flash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
        temperature: 0.1,
      }),
    },
  );
  return parseJsonStringSafely(json?.result?.response ?? json?.result?.output_text ?? json?.response);
}

async function callVoiceModelWithFallback(env: Env, prompt: string): Promise<unknown | null> {
  if (env.GEMINI_API_KEY) {
    const gemini = await callGemini(env.GEMINI_API_KEY, prompt);
    if (gemini) return gemini;
  }
  return callCloudflareGlmFallback(env, prompt);
}

async function handleVoiceExtract(request: Request, env: Env): Promise<Response> {
  const auth = await verifyTaskifyAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  if (!env.GEMINI_API_KEY && !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)) {
    return jsonResponse({ error: "Voice extraction is not configured" }, 501);
  }

  const body = await parseJson(request);
  const npub = typeof body?.npub === "string" ? body.npub.trim() : "";
  const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
  const candidates: TaskCandidate[] = Array.isArray(body?.candidates) ? body.candidates : [];
  const sessionDurationSeconds: number =
    typeof body?.sessionDurationSeconds === "number" && Number.isFinite(body.sessionDurationSeconds)
      ? Math.max(0, body.sessionDurationSeconds)
      : 0;

  if (!npub) return jsonResponse({ error: "npub is required" }, 400);
  if (normalizeNostrPublicKey(npub) !== auth.npub) {
    return jsonResponse({ error: "Authenticated identity does not match request npub" }, 401);
  }
  if (!transcript) {
    return jsonResponse({ error: "transcript must be a non-empty string" }, 400);
  }

  const db = requireDb(env);
  const today = utcDateString();
  const quota = await getVoiceQuota(db, auth.npub, today);

  const currentSessions = quota?.session_count ?? 0;
  const currentSeconds = quota?.total_seconds ?? 0;
  const projectedSessions = currentSessions + 1;
  const projectedSeconds = currentSeconds + sessionDurationSeconds;

  const overQuota = (
    projectedSessions > VOICE_MAX_SESSIONS_PER_DAY ||
    projectedSeconds > VOICE_MAX_SECONDS_PER_DAY
  );

  if (overQuota) {
    return jsonResponse(
      { error: "quota_exceeded", message: "Voice extraction unavailable right now. Please try again later." },
      429,
    );
  }

  const prompt = `Extract actionable tasks from this full voice transcript.

Transcript: "${transcript}"

Return ONLY JSON in this exact shape:
{
  "tasks": [
    { "title": string, "dueText": string|null, "reminderText": string|null, "notes": string|null, "recurrenceText": string|null, "subtasks": string[] }
  ]
}

Rules:
- Prefer fewer, high-quality tasks. Do not split one task into fragments.
- Never keep leading fragments in titles (drop/clean: "I need to", "then", "and then", "then tomorrow", "then Friday", "we have", "there's").
- Never keep reminder-command wording in titles (drop/clean: "remind me to", "set a reminder to", "alert me to", "notify me to").
- If user says grocery/shopping item lists, keep ONE parent task and put items in subtasks.
- Keep relative date/time phrases in dueText (e.g. "tomorrow 2:00 PM", "Friday at noon", "today at 5 PM").
- Preserve spoken time ranges in dueText with "from" (e.g. "tomorrow from 1-2"). Do not invent AM for an unqualified appointment range. Preserve explicit AM/PM and morning/night context.
- reminderText defaults to null. Set reminderText ONLY when the user explicitly asks for a reminder/alert/notification/nudge, such as "remind me", "set a reminder", "alert me", or "notify me".
- If the user says "remind me" without a reminder offset, set reminderText to "at due time".
- If the user gives reminder timing, keep it in reminderText (e.g. "15 minutes before", "1 hour before", "tomorrow at 9 AM").
- If the user requests several reminders for one task (e.g. "remind me 15 minutes before and 1 hour before"), include every requested offset in reminderText.
- Do not infer reminderText from dueText alone.
- notes defaults to null. Set notes ONLY when the user explicitly asks to attach details or a note to a task ("note that ...", "add a note ...", "with the details ...", "put in the notes ..."). Keep the note content verbatim, minus the command wording. Never move task title or due info into notes.
- recurrenceText defaults to null. Set it ONLY when the user says a task repeats (e.g. "every Monday", "every Monday and Thursday", "daily", "weekdays", "every 3 days", "every 2 weeks", "monthly on the 15th", "every other week"). Keep the phrase verbatim; do not set it for one-off tasks.
- Apply in-sentence corrections: if user says "actually change X to Y", update the earlier task for X.
- Keep title nouns concise and board-ready.
- Good title examples: "Go to the grocery store", "Birthday party for Ashley", "Play date", "Dinner after church", "Get dogs from Gran Gran's".
- Bad titles: "then I", "also", "and", "next Sunday at 2 PM we have...".
- If no valid tasks exist, return {"tasks":[]}.

Output JSON only.`;

  const result = await callVoiceModelWithFallback(env, prompt);
  if (!result) {
    return jsonResponse({ error: "gemini_unavailable", message: "Voice extraction unavailable right now. Please try again later." }, 503);
  }

  let operations = toOperationsFromStructuredTasks(result);

  if (!operations.length && Array.isArray((result as any).operations)) {
    operations = (result as any).operations as TaskOperation[];
  }

  operations = applyTranscriptCorrections(operations, transcript);

  // Increment quota on successful (non-quota-exceeded) path
  await incrementVoiceQuota(db, auth.npub, today, sessionDurationSeconds);

  return jsonResponse({ operations });
}

async function handleVoiceFinalize(request: Request, env: Env): Promise<Response> {
  const auth = await verifyTaskifyAuth(request);
  if (!auth) return jsonResponse({ error: "Unauthorized" }, 401);

  if (!env.GEMINI_API_KEY && !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)) {
    return jsonResponse({ error: "Voice finalization is not configured" }, 501);
  }

  const body = await parseJson(request);
  const npub = typeof body?.npub === "string" ? body.npub.trim() : "";
  const rawCandidates: unknown = body?.candidates;
  const boardId = typeof body?.boardId === "string" ? body.boardId : undefined;
  const referenceDate =
    typeof body?.referenceDate === "string" && body.referenceDate
      ? body.referenceDate
      : new Date().toISOString();
  const referenceTimeZone =
    typeof body?.referenceTimeZone === "string" && body.referenceTimeZone.trim()
      ? body.referenceTimeZone.trim()
      : "UTC";
  const referenceOffsetMinutes =
    typeof body?.referenceOffsetMinutes === "number" && Number.isFinite(body.referenceOffsetMinutes)
      ? body.referenceOffsetMinutes
      : 0;
  const boards: VoiceBoardContext[] = Array.isArray(body?.boards)
    ? (body.boards as unknown[])
      .map((b) => {
        if (!b || typeof b !== "object") return null;
        const board = b as any;
        if (typeof board.id !== "string" || !board.id.trim()) return null;
        if (typeof board.name !== "string" || !board.name.trim()) return null;
        const columns = Array.isArray(board.columns)
          ? (board.columns as unknown[])
            .map((c: any) => (
              c && typeof c === "object" && typeof c.id === "string" && c.id.trim() && typeof c.name === "string" && c.name.trim()
                ? { id: c.id.trim(), name: c.name.trim() }
                : null
            ))
            .filter((c): c is { id: string; name: string } => !!c)
          : undefined;
        return {
          id: board.id.trim(),
          name: board.name.trim(),
          kind: typeof board.kind === "string" ? board.kind : "week",
          ...(columns?.length ? { columns } : {}),
        } satisfies VoiceBoardContext;
      })
      .filter((b): b is VoiceBoardContext => !!b)
    : [];

  if (!npub) return jsonResponse({ error: "npub is required" }, 400);
  if (normalizeNostrPublicKey(npub) !== auth.npub) {
    return jsonResponse({ error: "Authenticated identity does not match request npub" }, 401);
  }
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    return jsonResponse({ error: "candidates must be a non-empty array" }, 400);
  }

  const confirmed = (rawCandidates as TaskCandidate[]).filter(
    (c) => c && typeof c === "object" && c.status === "confirmed",
  );

  if (confirmed.length === 0) {
    return jsonResponse({ error: "No confirmed candidates to finalize" }, 400);
  }

  const tasks: FinalTask[] = [];

  const localDates = voiceLocalDates(referenceDate, referenceTimeZone, referenceOffsetMinutes);
  const batchPrompt = `You are a Taskify task/event finalization assistant.

Reference instant (UTC, not the user's calendar date): ${referenceDate}
User's local calendar date (today): ${localDates.today}
Tomorrow in the user's time zone: ${localDates.tomorrow}
Day after tomorrow in the user's time zone: ${localDates.dayAfterTomorrow}
User time zone: ${referenceTimeZone}
User UTC offset minutes (Date.getTimezoneOffset): ${referenceOffsetMinutes}

Available boards (id, name, kind, optional columns) — empty array means only the current board:
${JSON.stringify(boards)}

Candidates:
${JSON.stringify(
    confirmed.map((c) => ({
      id: c.id,
      title: c.title,
      dueText: c.dueText ?? null,
      reminderText: c.reminderText ?? null,
      notes: c.notes ?? null,
      recurrenceText: c.recurrenceText ?? null,
      subtasks: c.subtasks ?? [],
      boardId: c.boardId ?? boardId ?? null,
    })),
  )}

Return ONLY JSON with exact shape:
{
  "tasks": [
    {
      "id": string,
      "title": string,
      "dueISO": string | null,
      "subtasks": string[],
      "notes": string | null,
      "boardId": string | null,
      "columnId": string | null,
      "recurrence": { "type": "daily" } | { "type": "weekly", "days": number[] } | { "type": "every", "n": number, "unit": "hour" | "day" | "week" } | { "type": "monthlyDay", "day": number, "interval"?: number } | null,
      "priority": 1 | 2 | 3 | null,
      "reminderMinutesBeforeDue": number[] | null,
      "reminderTime": string | null
    }
  ]
}

Rules:
- Return one finalized output item for every input candidate id.
- Fill all fields for each item.
- If dueText contains a date/time intent (e.g. "tomorrow 2 PM", "Friday at noon"), dueISO MUST be a valid ISO-8601 UTC datetime.
- If dueText contains a date but no task due/start clock time, dueISO MAY be a YYYY-MM-DD date string.
- Resolve "today" and "tomorrow" using the explicit local calendar dates above, never the UTC date of the reference instant.
- For time ranges, schedule the task at the start of the range. A daytime appointment "from 1-2" means 1 PM to 2 PM unless AM/morning/night is explicit. Preserve explicit AM/PM. "11 to 1 PM" starts at 11 AM.
- Use dueISO null only when there is truly no parseable date/time intent.
- Priority defaults to null. Only set priority when the user explicitly states it: "high priority", "urgent", "ASAP", "important" => 3; "medium priority" => 2; "low priority" => 1. Do NOT infer priority from normal planning language.
- reminderMinutesBeforeDue defaults to null. Set it ONLY when reminderText is non-null or the candidate/title explicitly asks for a reminder/alert/notification.
- If a reminder was requested without a lead time, use [0].
- reminderMinutesBeforeDue is an array and MUST include EVERY distinct offset the user requested, in the order given: "15 minutes before" => [15]; "1 hour before" => [60]; "1 day before" => [1440]; "1 week before" => [10080]; "15 minutes before and 1 hour before" => [15, 60].
- If the user requested a date-only reminder at a specific clock time, set reminderMinutesBeforeDue to [0] and reminderTime to "HH:MM"; otherwise reminderTime is null.
- Do not infer reminders from dueText alone.
- notes: preserve the candidate's notes text verbatim as the notes string; use null only when the candidate has no notes.
- recurrence defaults to null. Set it ONLY when recurrenceText (or the candidate title) clearly states a repeat pattern:
  - "daily" => {"type":"daily"}
  - "weekdays" => {"type":"weekly","days":[1,2,3,4,5]}
  - "every Monday" / "every Monday and Thursday" => {"type":"weekly","days":[...]} (0=Sunday ... 6=Saturday)
  - "every 3 days" => {"type":"every","n":3,"unit":"day"}
  - "every 2 weeks" => {"type":"every","n":2,"unit":"week"}
  - "every 4 hours" => {"type":"every","n":4,"unit":"hour"}
  - "monthly on the 15th" => {"type":"monthlyDay","day":15}
  - "every other month on the 1st" => {"type":"monthlyDay","day":1,"interval":2}
- Board routing: only when the user explicitly names a board from the available boards list, set boardId to that board's exact id; otherwise null (the client keeps the current board). When the target board's kind is "lists" and the user names a list/column, set columnId to that column's exact id; otherwise columnId null. Never guess board/column ids that are not in the list.
- Keep title clean and action-oriented.
- Preserve checklist-like nouns as subtasks.
- No markdown, no prose.`;

  const batchResult = await callVoiceModelWithFallback(env, batchPrompt);
  if (!batchResult) {
    return jsonResponse({ error: "gemini_unavailable", message: "Voice finalization unavailable right now. Please try again later." }, 503);
  }
  const batchTasks = Array.isArray((batchResult as any)?.tasks) ? (batchResult as any).tasks as any[] : [];
  const batchById = new Map<string, any>();
  for (const t of batchTasks) {
    const id = typeof t?.id === "string" ? t.id : "";
    if (id) batchById.set(id, t);
  }

  for (const candidate of confirmed) {
    const fromBatch = batchById.get(candidate.id);
    let normalizedTitle = candidate.title;
    let dueISO: string | undefined;
    let subtasks = candidate.subtasks;
    let notes: string | undefined;
    let normalizedBoardId = candidate.boardId ?? boardId;
    let priority: 1 | 2 | 3 | undefined;
    let reminderMinutesBeforeDue: number[] | undefined;
    let reminderTime: string | undefined;

    if (fromBatch && typeof fromBatch.title === "string" && fromBatch.title.trim()) {
      normalizedTitle = fromBatch.title.trim();
    }
    if (fromBatch && typeof fromBatch.dueISO === "string") {
      const candidateDue = fromBatch.dueISO.trim();
      if (candidateDue && !Number.isNaN(Date.parse(candidateDue))) {
        dueISO = candidateDue;
      }
    }
    if (fromBatch && typeof fromBatch.notes === "string" && fromBatch.notes.trim()) {
      notes = fromBatch.notes.trim();
    }
    if (fromBatch && typeof fromBatch.boardId === "string" && fromBatch.boardId.trim()) {
      normalizedBoardId = fromBatch.boardId.trim();
    }
    dueISO = normalizeVoiceDue(dueISO, candidate.dueText, candidate.title, referenceDate, referenceTimeZone, referenceOffsetMinutes);
    priority = parseTaskPriority(fromBatch?.priority);
    subtasks = normalizeSubtasks(fromBatch?.subtasks) ?? subtasks;
    const recurrence = normalizeRecurrence(fromBatch?.recurrence);
    // Guard against hallucinated board ids: only accept a model-chosen board
    // when the client supplied a boards list and the id exists in it.
    if (boards.length && fromBatch && typeof fromBatch.boardId === "string" && fromBatch.boardId.trim()) {
      if (!boards.some((b) => b.id === fromBatch.boardId.trim())) {
        normalizedBoardId = candidate.boardId ?? boardId;
      }
    }
    const matchedBoard = boards.find((b) => b.id === normalizedBoardId);
    const requestedColumnId = typeof fromBatch?.columnId === "string" ? fromBatch.columnId.trim() : "";
    const columnId = matchedBoard?.kind === "lists" && matchedBoard.columns?.some((c) => c.id === requestedColumnId)
      ? requestedColumnId
      : undefined;
    const reminderRequested = hasExplicitReminderRequest(candidate);
    if (reminderRequested) {
      reminderMinutesBeforeDue = normalizeReminderMinutes(fromBatch?.reminderMinutesBeforeDue);
      reminderTime = normalizeReminderTime(fromBatch?.reminderTime);
      if (!reminderMinutesBeforeDue?.length && dueISO) {
        reminderMinutesBeforeDue = [0];
      }
    }

    tasks.push({
      title: normalizedTitle,
      dueISO,
      boardId: normalizedBoardId,
      columnId,
      notes,
      subtasks,
      priority,
      reminderMinutesBeforeDue,
      reminderTime,
      recurrence,
    });
  }

  return jsonResponse({ tasks });
}

export { handleVoiceExtract, handleVoiceFinalize };
