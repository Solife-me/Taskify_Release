/**
 * Pasting JSON into a "New Task" field imports tasks and events (one object, a list, or
 * `{ tasks: [...], events: [...] }`, with smart quotes and trailing punctuation tolerated).
 * Parsing and building are pure: the caller adds the results to the board and publishes them.
 */
import {
  ISO_DATE_PATTERN,
  normalizeReminderTime,
  normalizeTaskRecurrence,
  sanitizeReminderList,
  type Board,
  type CalendarEvent,
  type CalendarEventBase,
  type CalendarEventParticipant,
  type Recurrence,
  type Subtask,
  type Task,
} from "taskify-core";
import {
  isoDatePart,
  isoForToday,
  isoFromDateTime,
  isoTimePart,
  normalizeIsoTimestamp,
  normalizeTimeZone,
  parseDateKey,
} from "../dateTime/dateUtils";
import { ensureDocumentPreview, normalizeDocumentList } from "../../lib/documents";
import { normalizeAgentPubkey } from "./assignmentUtils";
import { applyHiddenForCalendarEvent, nextOrderForBoard, nextOrderForCalendarBoard } from "./boardUtils";
import { normalizeTaskCreatedAt, normalizeTaskPriority } from "./taskUtils";
import type { Settings } from "./settingsTypes";

/** What imported items are added to: the open board, its settings and who is adding them. */
export type InlineImportContext = {
  board: Board;
  weekStart: Settings["weekStart"];
  newTaskPosition: Settings["newTaskPosition"];
  /** The user's public key, recorded as the creator. */
  actorPubkey: string | null | undefined;
};

export type InlineImportType = "task" | "event";
export type InlineImportItem = {
  type: InlineImportType;
  payload: Record<string, unknown>;
};

function normalizeInlineJsonPunctuation(raw: string): string {
  return (raw || "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[：]/g, ":")
    .replace(/[，]/g, ",")
    .replace(/[［]/g, "[")
    .replace(/[］]/g, "]")
    .replace(/[｛]/g, "{")
    .replace(/[｝]/g, "}");
}

function normalizeInlineJsonInput(raw: string): string {
  return normalizeInlineJsonPunctuation(raw)
    .replace(/[“”„‟]/g, "\"")
    .replace(/[‘’‚‛]/g, "'");
}

function normalizeInlineSmartQuotedJsonInput(raw: string): string {
  const source = normalizeInlineJsonPunctuation(raw);
  let out = "";
  let inSmartString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "“" || ch === "”" || ch === "„" || ch === "‟") {
      inSmartString = !inSmartString;
      out += "\"";
      continue;
    }
    if (inSmartString) {
      if (ch === "\\") {
        out += "\\\\";
        continue;
      }
      if (ch === "\"") {
        out += "\\\"";
        continue;
      }
      if (ch === "\r") {
        if (source[i + 1] === "\n") continue;
        out += "\\n";
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function tryParseInlineJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  const normalized = normalizeInlineJsonInput(raw);
  const smartQuoted = normalizeInlineSmartQuotedJsonInput(raw);
  const attempts = Array.from(new Set([raw, normalized, smartQuoted]));
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt) };
    } catch {
      // continue trying
    }
  }
  return { ok: false };
}

function extractInlineImportRoot(raw: string): unknown | undefined {
  const trimmed = (raw || "").trim();
  if (!trimmed) return undefined;

  const direct = tryParseInlineJson(trimmed);
  if (direct.ok) return direct.value;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const block = tryParseInlineJson(fenced[1].trim());
    if (block.ok) return block.value;
  }

  const lines = trimmed.split(/\n+/g).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const parsedLines: unknown[] = [];
    for (const line of lines) {
      const parsed = tryParseInlineJson(line);
      if (!parsed.ok) return undefined;
      parsedLines.push(parsed.value);
    }
    return parsedLines;
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const slicedObject = tryParseInlineJson(trimmed.slice(objectStart, objectEnd + 1));
    if (slicedObject.ok) return slicedObject.value;
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const slicedArray = tryParseInlineJson(trimmed.slice(arrayStart, arrayEnd + 1));
    if (slicedArray.ok) return slicedArray.value;
  }

  return undefined;
}

function detectInlineImportType(
  payload: Record<string, unknown>,
  forcedType?: InlineImportType,
): InlineImportType | null {
  if (forcedType) return forcedType;

  const rawType = typeof payload.type === "string" ? payload.type.trim().toLowerCase() : "";
  if (rawType === "task") return "task";
  if (rawType === "event" || rawType === "calendar-event" || rawType === "calendar_event") return "event";
  if (rawType === "board" || rawType === "contact") return null;

  const rawKind = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
  if (rawKind === "date" || rawKind === "time") return "event";

  if (
    typeof payload.startISO === "string" ||
    typeof payload.endISO === "string" ||
    typeof payload.startDate === "string" ||
    typeof payload.endDate === "string" ||
    typeof payload.start === "string" ||
    typeof payload.end === "string"
  ) {
    return "event";
  }

  return "task";
}

function collectInlineImportItems(root: unknown, forcedType?: InlineImportType): InlineImportItem[] {
  if (Array.isArray(root)) {
    return root.flatMap((entry) => collectInlineImportItems(entry, forcedType));
  }
  if (!root || typeof root !== "object") return [];

  const record = root as Record<string, unknown>;

  if (record.v === 1 && record.kind === "taskify-share" && record.item) {
    return collectInlineImportItems(record.item, forcedType);
  }

  const groupedItems: InlineImportItem[] = [];
  const tasksValue = record.tasks;
  const eventsValue = record.events;
  const itemsValue = record.items;

  if (Array.isArray(tasksValue)) {
    groupedItems.push(...tasksValue.flatMap((entry) => collectInlineImportItems(entry, "task")));
  }
  if (Array.isArray(eventsValue)) {
    groupedItems.push(...eventsValue.flatMap((entry) => collectInlineImportItems(entry, "event")));
  }
  if (Array.isArray(itemsValue)) {
    groupedItems.push(...itemsValue.flatMap((entry) => collectInlineImportItems(entry, forcedType)));
  }
  if (groupedItems.length) return groupedItems;

  const detectedType = detectInlineImportType(record, forcedType);
  if (!detectedType) return [];
  return [{ type: detectedType, payload: record }];
}

export function parseInlineImportItems(raw: string): InlineImportItem[] {
  const root = extractInlineImportRoot(raw);
  if (root === undefined) return [];
  return collectInlineImportItems(root);
}

function normalizeImportedSubtasks(value: unknown): Subtask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const subtasks: Subtask[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const title = entry.trim();
      if (!title) continue;
      subtasks.push({ id: crypto.randomUUID(), title, completed: false });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const title = typeof (entry as any).title === "string" ? (entry as any).title.trim() : "";
    if (!title) continue;
    subtasks.push({
      id: crypto.randomUUID(),
      title,
      completed: !!(entry as any).completed,
    });
  }
  return subtasks.length ? subtasks : undefined;
}

function normalizeImportedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return out.length ? Array.from(new Set(out)) : undefined;
}

function normalizeImportedParticipants(value: unknown): CalendarEventParticipant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CalendarEventParticipant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const pubkey = typeof (entry as any).pubkey === "string" ? (entry as any).pubkey.trim() : "";
    if (!pubkey) continue;
    const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
    const role = typeof (entry as any).role === "string" ? (entry as any).role.trim() : "";
    out.push({
      pubkey,
      ...(relay ? { relay } : {}),
      ...(role ? { role } : {}),
    });
  }
  return out.length ? out : undefined;
}

export function normalizeImportedRecurrence(value: unknown): Recurrence | undefined {
  const normalized = normalizeTaskRecurrence(value) as Recurrence | undefined;
  return normalized?.type === "none" ? undefined : normalized;
}

function normalizeImportedDateKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!ISO_DATE_PATTERN.test(trimmed)) return undefined;
  return parseDateKey(trimmed) ? trimmed : undefined;
}

export function buildImportedTaskFromPayload(
  payload: Record<string, unknown>,
  options: { overrides?: Partial<Task>; taskPool: Task[] },
  context: InlineImportContext,
): Task | null {
  const currentBoard = context.board;

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) return null;

  const overrides = options.overrides ?? {};
  const { dueISO: overrideDueISORaw, ...overridesWithoutDueISO } = overrides;
  const baseBoardId = typeof overrides.boardId === "string" ? overrides.boardId : currentBoard.id;
  const nextOrder = nextOrderForBoard(baseBoardId, options.taskPool, context.newTaskPosition);
  const id = crypto.randomUUID();

  const parsedDueISO =
    normalizeIsoTimestamp(payload.dueISO)
    ?? normalizeIsoTimestamp(payload.startISO)
    ?? (() => {
      const startDate = normalizeImportedDateKey(payload.startDate);
      return startDate ? isoFromDateTime(startDate) : undefined;
    })();
  const overrideDueISO = typeof overrideDueISORaw === "string" ? normalizeIsoTimestamp(overrideDueISORaw) : undefined;
  const dueDateEnabled = typeof payload.dueDateEnabled === "boolean" ? payload.dueDateEnabled : !!parsedDueISO;
  const dueTimeEnabled = typeof payload.dueTimeEnabled === "boolean" ? payload.dueTimeEnabled : undefined;
  const dueTimeZoneRaw =
    typeof payload.dueTimeZone === "string"
      ? payload.dueTimeZone
      : typeof payload.startTzid === "string"
        ? payload.startTzid
        : undefined;
  const dueTimeZone = normalizeTimeZone(dueTimeZoneRaw) ?? undefined;
  let dueISO = parsedDueISO || isoForToday();
  if (overrideDueISO) {
    if (parsedDueISO && dueTimeEnabled) {
      const targetDate = isoDatePart(overrideDueISO, dueTimeZone);
      const sourceTime = isoTimePart(parsedDueISO, dueTimeZone);
      const recomposed = isoFromDateTime(targetDate, sourceTime || undefined, dueTimeZone);
      dueISO = normalizeIsoTimestamp(recomposed) || overrideDueISO;
    } else {
      dueISO = overrideDueISO;
    }
  }
  const reminders = sanitizeReminderList(payload.reminders);
  const reminderTime = normalizeReminderTime(payload.reminderTime);
  const priority = normalizeTaskPriority(payload.priority);
  const createdAt = normalizeTaskCreatedAt(payload.createdAt) ?? Date.now();
  const createdBy =
    normalizeAgentPubkey(payload.createdBy)
    ?? normalizeAgentPubkey(overrides.createdBy)
    ?? undefined;
  const lastEditedBy =
    normalizeAgentPubkey(payload.lastEditedBy)
    ?? normalizeAgentPubkey(overrides.lastEditedBy)
    ?? createdBy;
  const documents = normalizeDocumentList(payload.documents);
  const images = Array.isArray(payload.images)
    ? payload.images
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : undefined;
  const noteRaw =
    typeof payload.note === "string"
      ? payload.note.trim()
      : typeof payload.description === "string"
        ? payload.description.trim()
        : "";
  const recurrence = normalizeImportedRecurrence(payload.recurrence);
  const subtasks = normalizeImportedSubtasks(payload.subtasks);

  const imported: Task = {
    id,
    boardId: baseBoardId,
    order: nextOrder,
    title,
    dueISO,
    createdAt,
    ...(createdBy ? { createdBy } : {}),
    ...(lastEditedBy ? { lastEditedBy } : {}),
    completed: false,
    ...(priority ? { priority } : {}),
    ...(noteRaw ? { note: noteRaw } : {}),
    ...(images?.length ? { images } : {}),
    ...(documents ? { documents: documents.map(ensureDocumentPreview) } : {}),
    ...(subtasks?.length ? { subtasks } : {}),
    ...(typeof dueDateEnabled === "boolean" ? { dueDateEnabled } : {}),
    ...(typeof dueTimeEnabled === "boolean" ? { dueTimeEnabled } : {}),
    ...(dueTimeZone ? { dueTimeZone } : {}),
    ...(reminders !== undefined ? { reminders } : {}),
    ...(reminderTime ? { reminderTime } : {}),
    ...(recurrence ? { recurrence, seriesId: id } : {}),
    ...overridesWithoutDueISO,
  };

  imported.boardId = typeof imported.boardId === "string" ? imported.boardId : baseBoardId;
  if (imported.recurrence) imported.seriesId = imported.seriesId || id;
  else imported.seriesId = undefined;
  return imported;
}

export function buildImportedCalendarEventFromPayload(
  payload: Record<string, unknown>,
  options: {
    boardId: string;
    boardKind: Board["kind"];
    columnId?: string;
    fallbackDateKey: string;
    eventPool: CalendarEvent[];
  },
  context: InlineImportContext,
): CalendarEvent | null {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) return null;

  const id = crypto.randomUUID();
  const order = nextOrderForCalendarBoard(options.boardId, options.eventPool, context.newTaskPosition);
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  const descriptionRaw =
    typeof payload.description === "string"
      ? payload.description.trim()
      : typeof payload.note === "string"
        ? payload.note.trim()
        : "";
  const documents = normalizeDocumentList(payload.documents);
  const image = typeof payload.image === "string" ? payload.image.trim() : "";
  const geohash = typeof payload.geohash === "string" ? payload.geohash.trim() : "";
  const location = typeof payload.location === "string" ? payload.location.trim() : "";
  const locations = normalizeImportedStringList(payload.locations) ?? (location ? [location] : undefined);
  const hashtags = normalizeImportedStringList(payload.hashtags);
  const references = normalizeImportedStringList(payload.references);
  const participants = normalizeImportedParticipants(payload.participants);
  const reminders = sanitizeReminderList(payload.reminders);
  const reminderTime = normalizeReminderTime(payload.reminderTime);
  const recurrence = normalizeImportedRecurrence(payload.recurrence);
  const createdBy =
    normalizeAgentPubkey(payload.createdBy)
    ?? normalizeAgentPubkey(context.actorPubkey)
    ?? undefined;
  const lastEditedBy =
    normalizeAgentPubkey(payload.lastEditedBy)
    ?? createdBy;

  const base: CalendarEventBase = {
    id,
    boardId: options.boardId,
    ...(createdBy ? { createdBy } : {}),
    ...(lastEditedBy ? { lastEditedBy } : {}),
    ...(options.columnId ? { columnId: options.columnId } : {}),
    order,
    title,
    ...(summary ? { summary } : {}),
    ...(descriptionRaw ? { description: descriptionRaw } : {}),
    ...(documents ? { documents: documents.map(ensureDocumentPreview) } : {}),
    ...(image ? { image } : {}),
    ...(locations ? { locations } : {}),
    ...(geohash ? { geohash } : {}),
    ...(participants ? { participants } : {}),
    ...(hashtags ? { hashtags } : {}),
    ...(references ? { references } : {}),
    ...(reminders ? { reminders } : {}),
    ...(reminderTime ? { reminderTime } : {}),
    ...(recurrence ? { recurrence, seriesId: id } : {}),
  };

  const rawKind = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : "";
  const inferredKind: "date" | "time" =
    rawKind === "time" || rawKind === "date"
      ? (rawKind as "date" | "time")
      : (
          typeof payload.startISO === "string"
          || typeof payload.endISO === "string"
          || typeof payload.startTime === "string"
          || typeof payload.endTime === "string"
          || typeof payload.time === "string"
          || payload.dueTimeEnabled === true
        )
        ? "time"
        : (
            typeof payload.startDate === "string"
            || typeof payload.endDate === "string"
            || typeof payload.start === "string"
            || typeof payload.end === "string"
          )
          ? "date"
          : "date";

  if (inferredKind === "time") {
    const startTzid = normalizeTimeZone(
      typeof payload.startTzid === "string"
        ? payload.startTzid
        : typeof payload.timeZone === "string"
          ? payload.timeZone
          : typeof payload.dueTimeZone === "string"
            ? payload.dueTimeZone
            : undefined,
    ) ?? undefined;
    const endTzid = normalizeTimeZone(
      typeof payload.endTzid === "string" ? payload.endTzid : startTzid,
    ) ?? startTzid;

    let startISO =
      normalizeIsoTimestamp(payload.startISO)
      ?? normalizeIsoTimestamp(payload.start)
      ?? normalizeIsoTimestamp(payload.dueISO);
    if (!startISO) {
      const startDate =
        normalizeImportedDateKey(payload.startDate)
        ?? normalizeImportedDateKey(payload.start)
        ?? normalizeImportedDateKey(payload.date)
        ?? options.fallbackDateKey;
      const startTime =
        normalizeReminderTime(payload.startTime)
        ?? normalizeReminderTime(payload.time)
        ?? "09:00";
      startISO = isoFromDateTime(startDate, startTime, startTzid);
    }
    const startMs = Date.parse(startISO);
    if (Number.isNaN(startMs)) return null;

    let endISO = normalizeIsoTimestamp(payload.endISO) ?? normalizeIsoTimestamp(payload.end);
    if (!endISO) {
      const endDate =
        normalizeImportedDateKey(payload.endDate)
        ?? normalizeImportedDateKey(payload.end);
      if (endDate) {
        const endTime =
          normalizeReminderTime(payload.endTime)
          ?? normalizeReminderTime(payload.time)
          ?? "10:00";
        endISO = isoFromDateTime(endDate, endTime, endTzid ?? startTzid);
      }
    }
    const endMs = endISO ? Date.parse(endISO) : Number.NaN;
    const normalizedEvent: CalendarEvent = applyHiddenForCalendarEvent(
      {
        ...base,
        kind: "time",
        startISO,
        ...(!Number.isNaN(endMs) && endMs > startMs ? { endISO } : {}),
        ...(startTzid ? { startTzid } : {}),
        ...(endTzid ? { endTzid } : {}),
      },
      context.weekStart,
      options.boardKind,
    );
    return normalizedEvent;
  }

  const startDate =
    normalizeImportedDateKey(payload.startDate)
    ?? normalizeImportedDateKey(payload.start)
    ?? normalizeImportedDateKey(payload.date)
    ?? (() => {
      const startISO =
        normalizeIsoTimestamp(payload.startISO)
        ?? normalizeIsoTimestamp(payload.start)
        ?? normalizeIsoTimestamp(payload.dueISO);
      return startISO ? isoDatePart(startISO) : undefined;
    })()
    ?? options.fallbackDateKey;
  const endDateRaw =
    normalizeImportedDateKey(payload.endDate)
    ?? normalizeImportedDateKey(payload.end)
    ?? (() => {
      const endISO = normalizeIsoTimestamp(payload.endISO) ?? normalizeIsoTimestamp(payload.end);
      return endISO ? isoDatePart(endISO) : undefined;
    })();
  const normalizedEvent: CalendarEvent = applyHiddenForCalendarEvent(
    {
      ...base,
      kind: "date",
      startDate,
      ...(endDateRaw && endDateRaw >= startDate ? { endDate: endDateRaw } : {}),
    },
    context.weekStart,
    options.boardKind,
  );
  return normalizedEvent;
}
