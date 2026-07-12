import { TASKIFY_CALENDAR_EVENT_KIND, TASKIFY_CALENDAR_VIEW_KIND, parseCalendarAddress } from "./calendarProtocol.js";

export type SharedBoardPayload = {
  type: "board";
  boardId: string;
  boardName?: string;
  relays?: string[];
};

export type SharedContactPayload = {
  type: "contact";
  npub: string;
  name?: string;
  displayName?: string;
  username?: string;
  nip05?: string;
  lud16?: string;
  relays?: string[];
  about?: string;
  picture?: string;
  sender?: { npub?: string; name?: string };
};

export type SharedTaskPayload = {
  type: "task";
  title: string;
  note?: string;
  priority?: number;
  dueISO?: string;
  dueDateEnabled?: boolean;
  dueTimeEnabled?: boolean;
  dueTimeZone?: string;
  reminders?: Array<string | number>;
  subtasks?: { title: string; completed?: boolean }[];
  recurrence?: { type: string; [key: string]: unknown };
  documents?: Array<Record<string, unknown>>;
  assignees?: Array<{ 
    pubkey: string;
    relay?: string;
    status?: "pending" | "accepted" | "declined" | "tentative";
    respondedAt?: number;
  }>;
  sourceTaskId?: string;
  assignment?: boolean;
  relays?: string[];
};

export type SharedCalendarEventInvitePayload = {
  type: "event";
  eventId: string;
  canonical: string;
  view: string;
  eventKey: string;
  inviteToken: string;
  title?: string;
  start?: string;
  end?: string;
  relays?: string[];
};

export type SharedTaskAssignmentResponsePayload = {
  type: "task-assignment-response";
  taskId: string;
  status: "accepted" | "declined" | "tentative";
  respondedAt?: string;
};

export type SharedEventRsvpResponsePayload = {
  type: "event-rsvp-response";
  eventId: string;
  status: "accepted" | "declined" | "tentative";
  respondedAt?: string;
};

export type ShareEnvelope = {
  v: 1;
  kind: "taskify-share";
  item:
    | SharedBoardPayload
    | SharedContactPayload
    | SharedTaskPayload
    | SharedCalendarEventInvitePayload
    | SharedTaskAssignmentResponsePayload
    | SharedEventRsvpResponsePayload;
  sender?: { npub?: string; name?: string };
};

const SHARE_ENVELOPE_EMBED_REGEX = /(?:^|\n)Taskify-Share:\s*([A-Za-z0-9_-]+)\s*(?:\n|$)/m;

function decodeBase64UrlUtf8(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function normalizeRelayList(list?: string[] | null): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const relays = list.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return relays.length ? Array.from(new Set(relays)) : undefined;
}

export function normalizeTaskDueISO(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function normalizeTaskTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format();
    return trimmed;
  } catch {
    return undefined;
  }
}

export function normalizeTaskPriority(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    if (rounded >= 1 && rounded <= 3) return rounded;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "!" || trimmed === "!!" || trimmed === "!!!") return trimmed.length;
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed >= 1 && parsed <= 3) return parsed;
  }
  return undefined;
}

export function normalizeTaskReminders(value: unknown): Array<string | number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const reminders: Array<string | number> = [];
  value.forEach((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) reminders.push(trimmed);
      return;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) reminders.push(entry);
  });
  return reminders.length ? reminders : undefined;
}

export function normalizeTaskSubtasks(value: unknown): SharedTaskPayload["subtasks"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const subtasks = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const title = typeof (entry as any).title === "string" ? (entry as any).title.trim() : "";
      if (!title) return null;
      const completed = typeof (entry as any).completed === "boolean" ? (entry as any).completed : undefined;
      return completed === undefined ? { title } : { title, completed };
    })
    .filter((entry): entry is { title: string; completed?: boolean } => !!entry);
  return subtasks.length ? subtasks : undefined;
}

export function normalizeTaskDocuments(value: unknown): SharedTaskPayload["documents"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const docs = value.filter((entry) => !!entry && typeof entry === "object") as Array<Record<string, unknown>>;
  return docs.length ? docs : undefined;
}

export function normalizeTaskRecurrence(value: unknown): SharedTaskPayload["recurrence"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  const untilISO = typeof raw.untilISO === "string" && raw.untilISO.trim()
    ? raw.untilISO.trim()
    : undefined;
  const withUntil = <T extends Record<string, unknown>>(rule: T): T & { untilISO?: string } => (
    untilISO ? { ...rule, untilISO } : rule
  );
  if (type === "none" || type === "daily") return withUntil({ type });
  if (type === "weekly") {
    if (!Array.isArray(raw.days)) return undefined;
    const days = Array.from(new Set(raw.days.filter(
      (day): day is number => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6,
    ).map(Number)));
    return days.length ? withUntil({ type, days }) : undefined;
  }
  if (type === "every") {
    const n = Number(raw.n);
    const unit = raw.unit;
    if (!Number.isSafeInteger(n) || n <= 0) return undefined;
    if (unit !== "hour" && unit !== "day" && unit !== "week") return undefined;
    return withUntil({ type, n, unit });
  }
  if (type === "monthlyDay") {
    const day = Number(raw.day);
    const interval = raw.interval === undefined ? undefined : Number(raw.interval);
    if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
    if (interval !== undefined && (!Number.isSafeInteger(interval) || interval <= 0)) return undefined;
    return withUntil({ type, day, ...(interval === undefined ? {} : { interval }) });
  }
  return undefined;
}

export function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeTaskAssignmentStatus(value: unknown): "pending" | "accepted" | "declined" | "tentative" | undefined {
  if (value === "pending" || value === "accepted" || value === "declined" || value === "tentative") return value;
  if (value === "maybe") return "tentative";
  return undefined;
}

function toRawHexPubkey(value: string): string | null {
  const trimmed = (value || "").trim().toLowerCase();
  if (!trimmed) return null;
  if (/^(02|03)[0-9a-f]{64}$/.test(trimmed)) return trimmed.slice(-64);
  if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
  return null;
}

export function normalizeTaskAssignees(value: unknown): SharedTaskPayload["assignees"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assignees: NonNullable<SharedTaskPayload["assignees"]> = [];
  const seen = new Set<string>();
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const pubkey = toRawHexPubkey(typeof (entry as any).pubkey === "string" ? (entry as any).pubkey : "");
    if (!pubkey || seen.has(pubkey)) return;
    seen.add(pubkey);
    const relay = typeof (entry as any).relay === "string" ? (entry as any).relay.trim() : "";
    const status = normalizeTaskAssignmentStatus((entry as any).status);
    const respondedAtRaw = Number((entry as any).respondedAt);
    const respondedAt = Number.isFinite(respondedAtRaw) && respondedAtRaw > 0 ? Math.round(respondedAtRaw) : undefined;
    assignees.push({ pubkey, ...(relay ? { relay } : {}), ...(status ? { status } : {}), ...(respondedAt ? { respondedAt } : {}) });
  });
  return assignees.length ? assignees : undefined;
}

export function normalizeTaskAssignmentFlag(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") return undefined;
  return value;
}

export function normalizeTaskAssignmentResponseStatus(value: unknown): SharedTaskAssignmentResponsePayload["status"] | undefined {
  if (value === "accepted" || value === "declined" || value === "tentative") return value;
  if (value === "maybe") return "tentative";
  return undefined;
}

export function normalizeTaskAssignmentResponseTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function sanitizeSender(sender: any): ShareEnvelope["sender"] {
  if (!sender || typeof sender !== "object") return undefined;
  const npub = typeof sender.npub === "string" && sender.npub.trim() ? sender.npub.trim() : undefined;
  const name = typeof sender.name === "string" && sender.name.trim() ? sender.name.trim() : undefined;
  if (!npub && !name) return undefined;
  return { npub, name };
}

function normalizeContactNpub(value: string): string | null {
  const trimmed = (value || "").trim();
  return trimmed.startsWith("npub") ? trimmed : null;
}

function normalizeCalendarAddress(value: unknown, allowedKinds: number[]): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseCalendarAddress(value);
  if (!parsed) return null;
  if (!allowedKinds.includes(parsed.kind)) return null;
  return `${parsed.kind}:${parsed.pubkey}:${parsed.d}`;
}

export function buildBoardShareEnvelope(boardId: string, boardName?: string, relays?: string[], sender?: { npub?: string; name?: string }): ShareEnvelope {
  return { v: 1, kind: "taskify-share", sender: sender?.npub || sender?.name ? sender : undefined, item: { type: "board", boardId: boardId.trim(), boardName: boardName?.trim() || undefined, relays: normalizeRelayList(relays) } };
}

export function buildContactShareEnvelope(payload: SharedContactPayload): ShareEnvelope {
  const npub = payload.npub.trim();
  return {
    v: 1,
    kind: "taskify-share",
    sender: payload.sender?.npub || payload.sender?.name ? payload.sender : undefined,
    item: { type: "contact", npub, relays: normalizeRelayList(payload.relays), name: payload.name?.trim() || undefined, displayName: payload.displayName?.trim() || undefined, username: payload.username?.trim() || undefined, nip05: payload.nip05?.trim() || undefined, lud16: payload.lud16?.trim() || undefined },
  };
}

export function buildTaskShareEnvelope(payload: SharedTaskPayload, sender?: { npub?: string; name?: string }): ShareEnvelope {
  return {
    v: 1,
    kind: "taskify-share",
    sender: sender?.npub || sender?.name ? sender : undefined,
    item: {
      type: "task",
      title: payload.title.trim(),
      note: payload.note?.trim() || undefined,
      priority: normalizeTaskPriority(payload.priority),
      dueISO: normalizeTaskDueISO(payload.dueISO),
      dueDateEnabled: typeof payload.dueDateEnabled === "boolean" ? payload.dueDateEnabled : undefined,
      dueTimeEnabled: typeof payload.dueTimeEnabled === "boolean" ? payload.dueTimeEnabled : undefined,
      dueTimeZone: normalizeTaskTimeZone(payload.dueTimeZone),
      reminders: normalizeTaskReminders(payload.reminders),
      subtasks: normalizeTaskSubtasks(payload.subtasks),
      recurrence: normalizeTaskRecurrence(payload.recurrence),
      documents: normalizeTaskDocuments(payload.documents),
      sourceTaskId: normalizeTaskId(payload.sourceTaskId),
      assignment: normalizeTaskAssignmentFlag(payload.assignment),
      assignees: normalizeTaskAssignees(payload.assignees),
      relays: normalizeRelayList(payload.relays),
    },
  };
}

export function buildTaskAssignmentResponseEnvelope(payload: Omit<SharedTaskAssignmentResponsePayload, "type">, sender?: { npub?: string; name?: string }): ShareEnvelope {
  const taskId = normalizeTaskId(payload.taskId);
  if (!taskId) throw new Error("Missing task id for assignment response.");
  const status = normalizeTaskAssignmentResponseStatus(payload.status);
  if (!status) throw new Error("Invalid assignment response status.");
  return { v: 1, kind: "taskify-share", sender: sender?.npub || sender?.name ? sender : undefined, item: { type: "task-assignment-response", taskId, status, respondedAt: normalizeTaskAssignmentResponseTime(payload.respondedAt) } };
}

export function buildEventRsvpResponseEnvelope(payload: Omit<SharedEventRsvpResponsePayload, "type">, sender?: { npub?: string; name?: string }): ShareEnvelope {
  const eventId = normalizeTaskId(payload.eventId);
  if (!eventId) throw new Error("Missing event id for RSVP response.");
  const status = normalizeTaskAssignmentResponseStatus(payload.status);
  if (!status) throw new Error("Invalid RSVP response status.");
  return {
    v: 1,
    kind: "taskify-share",
    sender: sender?.npub || sender?.name ? sender : undefined,
    item: { type: "event-rsvp-response", eventId, status, respondedAt: normalizeTaskAssignmentResponseTime(payload.respondedAt) },
  };
}

export function buildCalendarEventInviteEnvelope(payload: Omit<SharedCalendarEventInvitePayload, "type">, sender?: { npub?: string; name?: string }): ShareEnvelope {
  const eventId = typeof payload.eventId === "string" ? payload.eventId.trim() : "";
  if (!eventId) throw new Error("Invalid calendar event id.");
  const canonical = normalizeCalendarAddress(payload.canonical, [TASKIFY_CALENDAR_EVENT_KIND]);
  const view = normalizeCalendarAddress(payload.view, [TASKIFY_CALENDAR_VIEW_KIND]);
  if (!canonical || !view) throw new Error("Invalid calendar event address.");
  const cp = parseCalendarAddress(canonical);
  const vp = parseCalendarAddress(view);
  if (!cp || !vp || cp.d !== eventId || vp.d !== eventId) throw new Error("Calendar event address mismatch.");
  if (cp.pubkey !== vp.pubkey) throw new Error("Calendar event author mismatch.");
  const eventKey = typeof payload.eventKey === "string" && payload.eventKey.trim() ? payload.eventKey.trim() : "";
  if (!eventKey) throw new Error("Missing calendar event key.");
  const inviteToken = typeof payload.inviteToken === "string" && payload.inviteToken.trim() ? payload.inviteToken.trim() : "";
  if (!inviteToken) throw new Error("Missing calendar invite token.");
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : undefined;
  const start = typeof payload.start === "string" && payload.start.trim() ? payload.start.trim() : undefined;
  const end = typeof payload.end === "string" && payload.end.trim() ? payload.end.trim() : undefined;
  return { v: 1, kind: "taskify-share", sender: sender?.npub || sender?.name ? sender : undefined, item: { type: "event", eventId, canonical, view, eventKey, inviteToken, ...(title ? { title } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}), relays: normalizeRelayList(payload.relays) } };
}

export function parseShareEnvelope(raw: string): ShareEnvelope | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const embeddedMatch = trimmed.match(SHARE_ENVELOPE_EMBED_REGEX);
    const embeddedJson = embeddedMatch?.[1] ? decodeBase64UrlUtf8(embeddedMatch[1]) : null;
    if (!embeddedJson) return null;
    try {
      parsed = JSON.parse(embeddedJson);
    } catch {
      return null;
    }
  }
  if (parsed.v !== 1 || parsed.kind !== "taskify-share") return null;
  const item = parsed.item;
  if (!item || typeof item !== "object") return null;

  if (item.type === "board") {
    const boardId = typeof item.boardId === "string" ? item.boardId.trim() : "";
    if (!boardId) return null;
    return { v: 1, kind: "taskify-share", item: { type: "board", boardId, boardName: typeof item.boardName === "string" ? item.boardName.trim() : undefined, relays: normalizeRelayList(item.relays) }, sender: sanitizeSender(parsed.sender) };
  }

  if (item.type === "contact") {
    const npub = normalizeContactNpub(typeof item.npub === "string" ? item.npub.trim() : "");
    if (!npub) return null;
    const contact: SharedContactPayload = { type: "contact", npub, relays: normalizeRelayList(item.relays) };
    ["name", "displayName", "username", "nip05", "lud16", "about", "picture"].forEach((key) => {
      const value = (item as any)[key];
      if (typeof value === "string" && value.trim()) (contact as any)[key] = value.trim();
    });
    return { v: 1, kind: "taskify-share", item: contact, sender: sanitizeSender(parsed.sender) };
  }

  if (item.type === "task") {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return null;
    return { v: 1, kind: "taskify-share", item: { type: "task", title, note: typeof item.note === "string" ? item.note.trim() : undefined, priority: normalizeTaskPriority(item.priority), dueISO: normalizeTaskDueISO(item.dueISO), dueDateEnabled: typeof item.dueDateEnabled === "boolean" ? item.dueDateEnabled : undefined, dueTimeEnabled: typeof item.dueTimeEnabled === "boolean" ? item.dueTimeEnabled : undefined, dueTimeZone: normalizeTaskTimeZone(item.dueTimeZone), reminders: normalizeTaskReminders(item.reminders), subtasks: normalizeTaskSubtasks(item.subtasks), recurrence: normalizeTaskRecurrence(item.recurrence), documents: normalizeTaskDocuments(item.documents), sourceTaskId: normalizeTaskId(item.sourceTaskId), assignment: normalizeTaskAssignmentFlag(item.assignment), assignees: normalizeTaskAssignees(item.assignees), relays: normalizeRelayList(item.relays) }, sender: sanitizeSender(parsed.sender) };
  }

  if (item.type === "task-assignment-response") {
    const taskId = normalizeTaskId(item.taskId);
    const status = normalizeTaskAssignmentResponseStatus(item.status);
    if (!taskId || !status) return null;
    return { v: 1, kind: "taskify-share", item: { type: "task-assignment-response", taskId, status, respondedAt: normalizeTaskAssignmentResponseTime(item.respondedAt) }, sender: sanitizeSender(parsed.sender) };
  }

  if (item.type === "event-rsvp-response") {
    const eventId = normalizeTaskId(item.eventId);
    const status = normalizeTaskAssignmentResponseStatus(item.status);
    if (!eventId || !status) return null;
    return { v: 1, kind: "taskify-share", item: { type: "event-rsvp-response", eventId, status, respondedAt: normalizeTaskAssignmentResponseTime(item.respondedAt) }, sender: sanitizeSender(parsed.sender) };
  }

  if (item.type === "event") {
    const eventId = typeof item.eventId === "string" ? item.eventId.trim() : "";
    if (!eventId) return null;
    const canonical = normalizeCalendarAddress(item.canonical, [TASKIFY_CALENDAR_EVENT_KIND]);
    const view = normalizeCalendarAddress(item.view, [TASKIFY_CALENDAR_VIEW_KIND]);
    if (!canonical || !view) return null;
    const cp = parseCalendarAddress(canonical); const vp = parseCalendarAddress(view);
    if (!cp || !vp || cp.d !== eventId || vp.d !== eventId || cp.pubkey !== vp.pubkey) return null;
    const eventKey = typeof item.eventKey === "string" && item.eventKey.trim() ? item.eventKey.trim() : "";
    const inviteToken = typeof item.inviteToken === "string" && item.inviteToken.trim() ? item.inviteToken.trim() : "";
    if (!eventKey || !inviteToken) return null;
    return { v: 1, kind: "taskify-share", item: { type: "event", eventId, canonical, view, eventKey, inviteToken, ...(typeof item.title === "string" && item.title.trim() ? { title: item.title.trim() } : {}), ...(typeof item.start === "string" && item.start.trim() ? { start: item.start.trim() } : {}), ...(typeof item.end === "string" && item.end.trim() ? { end: item.end.trim() } : {}), relays: normalizeRelayList(item.relays) }, sender: sanitizeSender(parsed.sender) };
  }

  return null;
}
