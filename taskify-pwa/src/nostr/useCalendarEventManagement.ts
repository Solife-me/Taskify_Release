import { useCallback, useEffect, useRef, useState } from "react";
import type { NostrEvent } from "nostr-tools";
import type { Board, CalendarEvent, EditingState } from "../domains/tasks/taskTypes";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import {
  calendarAddress,
  decryptCalendarRsvpPayload,
  decryptCalendarRsvpPayloadForAttendee,
  deriveBoardRsvpToken,
  parseCalendarRsvpPayload,
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_RSVP_KIND,
  type CalendarRsvpFb,
  type CalendarRsvpStatus,
} from "../lib/privateCalendar";

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((prev: T) => T)) => void;
type BoardNostrKeys = { pk: string; skHex: string };
type CalendarNostrPool = {
  subscribeMany: (
    relays: string[],
    filter: Record<string, unknown>,
    opts?: { onevent?: (ev: NostrEvent) => void; oneose?: (relay?: string) => void; closeOnEose?: boolean },
  ) => { close: (...args: unknown[]) => void };
  list?: (relays: string[], filters: Array<Record<string, unknown>>) => Promise<NostrEvent[]>;
};

export type CalendarRsvpEnvelope = {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  status: CalendarRsvpStatus;
  fb?: CalendarRsvpFb;
  inviteToken?: string;
};

type UseCalendarEventManagementParams = {
  boards: Board[];
  calendarEvents: CalendarEvent[];
  calendarEventsRef: MutableRef<CalendarEvent[]>;
  defaultRelays: string[];
  editing: EditingState | null;
  inboxRelays: string[];
  nostrPK: string;
  nostrSkHex: string;
  pool: CalendarNostrPool;
  setCalendarEvents: StateSetter<CalendarEvent[]>;
  tagValue: (ev: NostrEvent, name: string) => string | undefined;
  deriveBoardNostrKeys: (boardId: string) => Promise<BoardNostrKeys>;
};

function inviteTokenVersion(inviteTokens: Record<string, string> | null | undefined): string {
  return inviteTokens
    ? JSON.stringify(Object.keys(inviteTokens).sort().map((key) => [key, inviteTokens[key]]))
    : "";
}

export function useCalendarEventManagement({
  boards,
  calendarEvents,
  calendarEventsRef,
  defaultRelays,
  editing,
  inboxRelays,
  nostrPK,
  nostrSkHex,
  pool,
  setCalendarEvents,
  tagValue,
  deriveBoardNostrKeys,
}: UseCalendarEventManagementParams) {
  const [activeEventRsvpCoord, setActiveEventRsvpCoord] = useState<string | null>(null);
  const [activeEventRsvpRelays, setActiveEventRsvpRelays] = useState<string[]>([]);
  const [activeEventRsvps, setActiveEventRsvps] = useState<CalendarRsvpEnvelope[]>([]);
  const activeEventRsvpMapRef = useRef<Map<string, CalendarRsvpEnvelope>>(new Map());
  const activeEventInviteTokensRef = useRef<Record<string, string> | null>(null);
  const activeEventInviteTokensVersionRef = useRef("");
  const activeEventRsvpContextRef = useRef<{ eventId: string; boardNostrId: string; boardSkHex: string } | null>(null);

  const setActiveRsvp = useCallback((next: CalendarRsvpEnvelope) => {
    const existing = activeEventRsvpMapRef.current.get(next.authorPubkey);
    if (existing && existing.createdAt > next.createdAt) return;
    activeEventRsvpMapRef.current.set(next.authorPubkey, next);
    setActiveEventRsvps(
      Array.from(activeEventRsvpMapRef.current.values()).sort((a, b) => b.createdAt - a.createdAt),
    );
  }, []);

  const recordActiveEventRsvp = useCallback(
    (canonicalAddress: string, next: CalendarRsvpEnvelope) => {
      if (activeEventRsvpCoord !== canonicalAddress) return;
      setActiveRsvp(next);
    },
    [activeEventRsvpCoord, setActiveRsvp],
  );

  const applyCalendarRsvpEvent = useCallback(
    async (ev: NostrEvent) => {
      if (!ev?.content || ev.kind !== TASKIFY_CALENDAR_RSVP_KIND) return;
      const ctx = activeEventRsvpContextRef.current;
      if (!ctx) return;
      const tokenMap = activeEventInviteTokensRef.current ?? {};
      const attendeePubkey = (ev.pubkey || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(attendeePubkey)) return;
      try {
        const raw = await decryptCalendarRsvpPayload(ev.content, ctx.boardSkHex, ev.pubkey);
        const payload = parseCalendarRsvpPayload(raw);
        if (!payload || payload.eventId !== ctx.eventId) return;
        const expectedToken = tokenMap[attendeePubkey];
        const boardToken = deriveBoardRsvpToken(ctx.boardNostrId, attendeePubkey);
        const tokenValues = Object.values(tokenMap);
        const tokenMatches =
          payload.inviteToken === boardToken ||
          (!!expectedToken && payload.inviteToken === expectedToken) ||
          (tokenValues.length > 0 && tokenValues.includes(payload.inviteToken));
        if (!tokenMatches) return;
        const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
        setActiveRsvp({
          eventId: payload.eventId,
          authorPubkey: attendeePubkey,
          createdAt,
          status: payload.status,
          ...(payload.fb ? { fb: payload.fb } : {}),
          inviteToken: payload.inviteToken,
        });
      } catch (err) {
        console.warn("Failed to decrypt RSVP", err);
      }
    },
    [setActiveRsvp],
  );

  const applyExternalCalendarRsvpEvent = useCallback(
    async (ev: NostrEvent) => {
      if (!ev?.content || ev.kind !== TASKIFY_CALENDAR_RSVP_KIND) return;
      if (!nostrSkHex || !nostrPK) return;
      const attendeePubkey = (ev.pubkey || "").toLowerCase();
      if (attendeePubkey !== nostrPK) return;
      const canonicalAddr = tagValue(ev, "a");
      if (!canonicalAddr) return;
      const target = calendarEventsRef.current.find(
        (event) => event.external && event.canonicalAddress === canonicalAddr,
      );
      if (!target || !target.boardPubkey) return;
      try {
        const raw = await decryptCalendarRsvpPayloadForAttendee(ev.content, nostrSkHex, target.boardPubkey);
        const payload = parseCalendarRsvpPayload(raw);
        if (!payload || payload.eventId !== target.id) return;
        const createdAt = typeof ev.created_at === "number" ? ev.created_at : 0;
        setCalendarEvents((prev) => {
          const idx = prev.findIndex((event) => event.external && event.canonicalAddress === canonicalAddr);
          if (idx < 0) return prev;
          const existing = prev[idx];
          if (existing.rsvpCreatedAt && existing.rsvpCreatedAt > createdAt) return prev;
          const updated: CalendarEvent = {
            ...existing,
            rsvpStatus: payload.status,
            rsvpCreatedAt: createdAt,
            ...(payload.fb ? { rsvpFb: payload.fb } : { rsvpFb: undefined }),
            ...(payload.inviteToken && !existing.inviteToken ? { inviteToken: payload.inviteToken } : {}),
          };
          const copy = prev.slice();
          copy[idx] = updated;
          return copy;
        });
      } catch (err) {
        console.warn("Failed to decrypt external RSVP", err);
      }
    },
    [calendarEventsRef, nostrPK, nostrSkHex, setCalendarEvents, tagValue],
  );

  useEffect(() => {
    activeEventRsvpMapRef.current = new Map();
    activeEventInviteTokensRef.current = null;
    activeEventInviteTokensVersionRef.current = "";
    activeEventRsvpContextRef.current = null;
    setActiveEventRsvps([]);
    setActiveEventRsvpCoord(null);
    setActiveEventRsvpRelays([]);

    if (!editing || editing.type !== "event") return;
    const event = editing.event;
    const board = boards.find((candidate) => candidate.id === event.boardId);
    const relayCandidates = [
      ...(board?.nostr?.relays?.length ? board.nostr.relays : []),
      ...defaultRelays,
      ...inboxRelays,
      ...Array.from(DEFAULT_NOSTR_RELAYS),
    ];
    const relays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));

    if (board?.nostr?.boardId && relays.length) {
      let cancelled = false;
      let subscription: { close: (...args: unknown[]) => void } | null = null;
      const boardNostrId = board.nostr.boardId;

      (async () => {
        try {
          const boardKeys = await deriveBoardNostrKeys(board.nostr!.boardId);
          const coord = calendarAddress(TASKIFY_CALENDAR_EVENT_KIND, boardKeys.pk, event.id);
          if (cancelled) return;
          activeEventRsvpContextRef.current = { eventId: event.id, boardNostrId, boardSkHex: boardKeys.skHex };
          setActiveEventRsvpCoord(coord);
          setActiveEventRsvpRelays(relays);
          activeEventInviteTokensRef.current = event.inviteTokens ?? null;
          activeEventInviteTokensVersionRef.current = inviteTokenVersion(event.inviteTokens);

          subscription = pool.subscribeMany(
            relays,
            { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": [coord] },
            {
              onevent: (incoming) => {
                if (cancelled) return;
                void applyCalendarRsvpEvent(incoming);
              },
            },
          );

          try {
            if (typeof pool.list === "function") {
              const events = await pool.list(relays, [
                { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": [coord] },
              ]);
              if (!cancelled && Array.isArray(events)) {
                events.forEach((incoming) => void applyCalendarRsvpEvent(incoming));
              }
            }
          } catch (err) {
            console.warn("RSVP fetch failed", err);
          }
        } catch (err) {
          console.warn("RSVP subscription failed", err);
        }
      })();

      return () => {
        cancelled = true;
        try {
          subscription?.close("taskify-rsvps");
        } catch {}
      };
    }

    if (event.canonicalAddress && event.inviteToken) {
      setActiveEventRsvpCoord(event.canonicalAddress);
      setActiveEventRsvpRelays(event.inviteRelays ?? []);
      if (event.external && nostrPK && event.rsvpStatus) {
        const createdAt = event.rsvpCreatedAt ?? 0;
        const next: CalendarRsvpEnvelope = {
          eventId: event.id,
          authorPubkey: nostrPK,
          createdAt,
          status: event.rsvpStatus,
          ...(event.rsvpFb ? { fb: event.rsvpFb } : {}),
          ...(event.inviteToken ? { inviteToken: event.inviteToken } : {}),
        };
        activeEventRsvpMapRef.current = new Map([[nostrPK, next]]);
        setActiveEventRsvps([next]);
      }
    }
  }, [applyCalendarRsvpEvent, boards, defaultRelays, deriveBoardNostrKeys, editing, inboxRelays, nostrPK, pool]);

  useEffect(() => {
    if (!nostrSkHex || !nostrPK) return;

    const targets = calendarEvents.filter(
      (event) => event.external && !!event.canonicalAddress && !!event.boardPubkey,
    );
    if (!targets.length) return;

    const canonicalAddrs = new Set<string>();
    const relaySet = new Set<string>();
    targets.forEach((event) => {
      if (event.canonicalAddress) canonicalAddrs.add(event.canonicalAddress);
      (event.inviteRelays ?? []).forEach((relay) => relaySet.add(relay));
    });
    if (!canonicalAddrs.size) return;

    const relayCandidates = [
      ...Array.from(relaySet),
      ...defaultRelays,
      ...inboxRelays,
      ...Array.from(DEFAULT_NOSTR_RELAYS),
    ];
    const relays = Array.from(new Set(relayCandidates.map((relay) => relay.trim()).filter(Boolean)));
    if (!relays.length) return;

    let cancelled = false;
    const filter: Record<string, unknown> = { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": Array.from(canonicalAddrs) };
    if (nostrPK) filter.authors = [nostrPK];

    const subscription = pool.subscribeMany(relays, filter, {
      onevent: (incoming) => {
        if (cancelled) return;
        void applyExternalCalendarRsvpEvent(incoming);
      },
    });

    (async () => {
      try {
        if (typeof pool.list === "function") {
          const events = await pool.list(relays, [filter]);
          if (!cancelled && Array.isArray(events)) {
            events.forEach((incoming) => void applyExternalCalendarRsvpEvent(incoming));
          }
        }
      } catch (err) {
        console.warn("External RSVP fetch failed", err);
      }
    })();

    return () => {
      cancelled = true;
      try {
        subscription.close("taskify-external-rsvps");
      } catch {}
    };
  }, [
    applyExternalCalendarRsvpEvent,
    calendarEvents,
    defaultRelays,
    inboxRelays,
    nostrPK,
    nostrSkHex,
    pool,
  ]);

  useEffect(() => {
    if (!editing || editing.type !== "event") return;
    if (!editing.event.external) return;
    if (!nostrPK) return;
    const latest = calendarEventsRef.current.find(
      (event) =>
        event.external &&
        event.id === editing.event.id &&
        event.canonicalAddress === editing.event.canonicalAddress,
    );
    if (!latest?.rsvpStatus) {
      activeEventRsvpMapRef.current = new Map();
      setActiveEventRsvps([]);
      return;
    }
    const createdAt = latest.rsvpCreatedAt ?? 0;
    const next: CalendarRsvpEnvelope = {
      eventId: latest.id,
      authorPubkey: nostrPK,
      createdAt,
      status: latest.rsvpStatus,
      ...(latest.rsvpFb ? { fb: latest.rsvpFb } : {}),
      ...(latest.inviteToken ? { inviteToken: latest.inviteToken } : {}),
    };
    activeEventRsvpMapRef.current = new Map([[nostrPK, next]]);
    setActiveEventRsvps([next]);
  }, [calendarEvents, calendarEventsRef, editing, nostrPK]);

  useEffect(() => {
    if (!editing || editing.type !== "event") return;
    const eventId = editing.event.id;
    const latest = calendarEventsRef.current.find((event) => event.id === eventId) ?? null;
    const inviteTokens = latest?.inviteTokens ?? editing.event.inviteTokens ?? null;
    const tokenVersion = inviteTokenVersion(inviteTokens);
    if (tokenVersion === activeEventInviteTokensVersionRef.current) return;
    activeEventInviteTokensVersionRef.current = tokenVersion;
    activeEventInviteTokensRef.current = inviteTokens;
    if (!activeEventRsvpCoord || !activeEventRsvpRelays.length) return;
    (async () => {
      try {
        if (typeof pool.list === "function") {
          const events = await pool.list(activeEventRsvpRelays, [
            { kinds: [TASKIFY_CALENDAR_RSVP_KIND], "#a": [activeEventRsvpCoord] },
          ]);
          if (Array.isArray(events)) {
            events.forEach((incoming) => void applyCalendarRsvpEvent(incoming));
          }
        }
      } catch (err) {
        console.warn("RSVP refresh failed", err);
      }
    })();
  }, [activeEventRsvpCoord, activeEventRsvpRelays, applyCalendarRsvpEvent, calendarEvents, calendarEventsRef, editing, pool]);

  return {
    activeEventRsvpCoord,
    activeEventRsvpRelays,
    activeEventRsvps,
    recordActiveEventRsvp,
  };
}
