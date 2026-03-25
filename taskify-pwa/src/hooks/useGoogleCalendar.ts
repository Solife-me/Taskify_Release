import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  gcalFetch,
  gcalEventToCalendarEvent,
  SPECIAL_GCAL_CALENDAR_PREFIX,
  type GcalConnectionStatus,
  type GcalCalendar,
  type GcalExternalEvent,
  type GcalCalendarEvent,
} from "../lib/gcalApi";
import { kvStorage } from "../storage/kvStorage";

// ─── Storage keys ─────────────────────────────────────────────────────────────

const LS_GCAL_EVENTS = "taskify_gcal_events_v1";
const LS_GCAL_CALENDARS = "taskify_gcal_calendars_v1";
const LS_GCAL_STATUS = "taskify_gcal_status_v1";

// ─── Types ────────────────────────────────────────────────────────────────────

function normalizeConnectionStatus(input: unknown): GcalConnectionStatus {
  if (!input || typeof input !== "object") return { connected: false };
  const raw = input as Record<string, unknown>;
  if (raw.connected !== true) return { connected: false };
  return {
    connected: true,
    status:
      raw.status === "active" ||
      raw.status === "token_expired" ||
      raw.status === "needs_reauth" ||
      raw.status === "sync_failed" ||
      raw.status === "disconnected"
        ? raw.status
        : "active",
    googleEmail: typeof raw.googleEmail === "string" ? raw.googleEmail : "",
    lastSyncAt: typeof raw.lastSyncAt === "number" ? raw.lastSyncAt : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
  };
}

function normalizeCalendars(input: unknown): GcalCalendar[] {
  if (!Array.isArray(input)) return [];
  const out: GcalCalendar[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!id || !name) continue;
    out.push({
      id,
      name,
      primary_cal: raw.primary_cal === 1 ? 1 : 0,
      selected: raw.selected === 1 ? 1 : 0,
      color: typeof raw.color === "string" ? raw.color : null,
      timezone: typeof raw.timezone === "string" ? raw.timezone : null,
    });
  }
  return out;
}

function normalizeExternalEvents(input: unknown): GcalExternalEvent[] {
  if (!Array.isArray(input)) return [];
  const out: GcalExternalEvent[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "";
    const calendarId = typeof raw.calendarId === "string" ? raw.calendarId : "";
    const title = typeof raw.title === "string" ? raw.title : "";
    const startISO = typeof raw.startISO === "string"
      ? raw.startISO
      : (typeof raw.startIso === "string" ? raw.startIso : "");
    const endISO = typeof raw.endISO === "string"
      ? raw.endISO
      : (typeof raw.endIso === "string" ? raw.endIso : undefined);
    if (!id || !calendarId || !title || !startISO) continue;

    out.push({
      id,
      calendarId,
      providerEventId: typeof raw.providerEventId === "string" ? raw.providerEventId : id,
      calendarName:
        typeof raw.calendarName === "string" && raw.calendarName.trim().length > 0
          ? raw.calendarName
          : calendarId,
      calendarColor: typeof raw.calendarColor === "string" ? raw.calendarColor : undefined,
      title,
      description: typeof raw.description === "string" ? raw.description : undefined,
      location: typeof raw.location === "string" ? raw.location : undefined,
      startISO,
      endISO,
      allDay: typeof raw.allDay === "boolean" ? raw.allDay : false,
      status: raw.status === "tentative" || raw.status === "cancelled" ? raw.status : "confirmed",
      htmlLink: typeof raw.htmlLink === "string" ? raw.htmlLink : undefined,
      isRecurring: Boolean(raw.isRecurring),
      readonly: true,
      source: "google",
      kind: "calendar_event",
    });
  }
  return out;
}

export type { GcalCalendar, GcalConnectionStatus };

export type UseGoogleCalendarResult = {
  /** Connection status from the Worker */
  connectionStatus: GcalConnectionStatus;
  /** Calendar list for the connected account */
  calendars: GcalCalendar[];
  /** Converted CalendarEvent items ready for Upcoming merge */
  gcalEvents: GcalCalendarEvent[];
  /** Whether a fetch is in progress */
  loading: boolean;
  /** Start OAuth connect flow */
  connect: () => Promise<void>;
  /** Disconnect from Google Calendar */
  disconnect: () => Promise<void>;
  /** Toggle a calendar on/off */
  toggleCalendar: (id: string, selected: boolean) => Promise<void>;
  /** Manually trigger incremental sync */
  sync: () => Promise<void>;
  /** Refresh status + events from Worker (called on mount and after OAuth redirect) */
  refresh: () => Promise<void>;
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGoogleCalendar(
  workerBaseUrl: string,
  privkeyHex: string | null,
): UseGoogleCalendarResult {
  const [connectionStatus, setConnectionStatus] = useState<GcalConnectionStatus>(() => {
    try {
      const raw = kvStorage.getItem(LS_GCAL_STATUS);
      if (raw) return normalizeConnectionStatus(JSON.parse(raw));
    } catch {}
    return { connected: false };
  });

  const [calendars, setCalendars] = useState<GcalCalendar[]>(() => {
    try {
      const raw = kvStorage.getItem(LS_GCAL_CALENDARS);
      if (raw) return normalizeCalendars(JSON.parse(raw));
    } catch {}
    return [];
  });

  const [rawEvents, setRawEvents] = useState<GcalExternalEvent[]>(() => {
    try {
      const raw = kvStorage.getItem(LS_GCAL_EVENTS);
      if (raw) return normalizeExternalEvents(JSON.parse(raw));
    } catch {}
    return [];
  });

  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Derived: converted CalendarEvent items ────────────────────────────────

  const gcalEvents: GcalCalendarEvent[] = useMemo(() => {
    const converted: GcalCalendarEvent[] = [];
    for (const ev of rawEvents) {
      try {
        converted.push(gcalEventToCalendarEvent(ev));
      } catch (err) {
        console.warn("Skipping invalid Google Calendar event payload", err, ev);
      }
    }
    return converted;
  }, [rawEvents]);

  // ── Persist to IDB/localStorage on change ────────────────────────────────

  useEffect(() => {
    try { kvStorage.setItem(LS_GCAL_STATUS, JSON.stringify(connectionStatus)); } catch {}
  }, [connectionStatus]);

  useEffect(() => {
    try { kvStorage.setItem(LS_GCAL_CALENDARS, JSON.stringify(calendars)); } catch {}
  }, [calendars]);

  useEffect(() => {
    try { kvStorage.setItem(LS_GCAL_EVENTS, JSON.stringify(rawEvents)); } catch {}
  }, [rawEvents]);

  // ── Fetch helpers ─────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    try {
      const res = await gcalFetch(workerBaseUrl, "/api/gcal/status", privkeyHex);
      if (!mountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        setConnectionStatus(normalizeConnectionStatus(data));
      }
    } catch {
      // network error — keep cached status
    }
  }, [workerBaseUrl, privkeyHex]);

  const fetchCalendars = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    try {
      const res = await gcalFetch(workerBaseUrl, "/api/gcal/calendars", privkeyHex);
      if (!mountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        setCalendars(normalizeCalendars(data));
      }
    } catch {}
  }, [workerBaseUrl, privkeyHex]);

  const fetchEvents = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
      const res = await gcalFetch(
        workerBaseUrl,
        `/api/gcal/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        privkeyHex,
      );
      if (!mountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        setRawEvents(normalizeExternalEvents(data));
      }
    } catch {}
  }, [workerBaseUrl, privkeyHex]);

  // ── refresh: status + calendars + events ─────────────────────────────────

  const refresh = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    setLoading(true);
    try {
      await fetchStatus();
      if (!mountedRef.current) return;
      await fetchCalendars();
      if (!mountedRef.current) return;
      await fetchEvents();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [fetchStatus, fetchCalendars, fetchEvents, workerBaseUrl, privkeyHex]);

  // ── On mount: load from Worker (cached data already shown from IDB) ───────

  useEffect(() => {
    if (!workerBaseUrl || !privkeyHex) return;
    // Check for OAuth redirect result
    const params = new URLSearchParams(window.location.search);
    if (params.get("gcal") === "connected" || params.get("gcal") === "error") {
      // Clean up URL param
      const url = new URL(window.location.href);
      url.searchParams.delete("gcal");
      window.history.replaceState({}, "", url.toString());
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerBaseUrl, privkeyHex]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    const res = await gcalFetch(workerBaseUrl, "/api/gcal/auth/url", privkeyHex);
    if (res.ok) {
      const { url } = await res.json() as { url: string };
      window.location.href = url;
    }
  }, [workerBaseUrl, privkeyHex]);

  const disconnect = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    setLoading(true);
    try {
      const res = await gcalFetch(workerBaseUrl, "/api/gcal/connection", privkeyHex, { method: "DELETE" });
      if (res.ok && mountedRef.current) {
        setConnectionStatus({ connected: false });
        setCalendars([]);
        setRawEvents([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [workerBaseUrl, privkeyHex]);

  const toggleCalendar = useCallback(async (id: string, selected: boolean) => {
    if (!workerBaseUrl || !privkeyHex) return;
    // Optimistic update
    setCalendars((prev) =>
      prev.map((c) => (c.id === id ? { ...c, selected: selected ? 1 : 0 } : c)),
    );
    try {
      await gcalFetch(
        workerBaseUrl,
        `/api/gcal/calendars/${encodeURIComponent(id)}`,
        privkeyHex,
        { method: "PATCH", body: JSON.stringify({ selected }) },
      );
      // Re-fetch events since calendar selection changed
      await fetchEvents();
    } catch {
      // Revert optimistic update on error
      await fetchCalendars();
    }
  }, [workerBaseUrl, privkeyHex, fetchCalendars, fetchEvents]);

  const sync = useCallback(async () => {
    if (!workerBaseUrl || !privkeyHex) return;
    setLoading(true);
    try {
      await gcalFetch(workerBaseUrl, "/api/gcal/sync", privkeyHex, { method: "POST" });
      await fetchEvents();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [workerBaseUrl, privkeyHex, fetchEvents]);

  return {
    connectionStatus,
    calendars,
    gcalEvents,
    loading,
    connect,
    disconnect,
    toggleCalendar,
    sync,
    refresh,
  };
}

// ─── Filter panel helpers ─────────────────────────────────────────────────────

/** Returns true if a boardId belongs to a Google Calendar calendar */
export function isGcalBoardId(boardId: string): boolean {
  return boardId.startsWith(SPECIAL_GCAL_CALENDAR_PREFIX);
}

/** Extract calendarId from a synthetic gcal boardId */
export function gcalIdFromBoardId(boardId: string): string {
  return boardId.slice(SPECIAL_GCAL_CALENDAR_PREFIX.length);
}
