import { useEffect, type MutableRefObject } from "react";
import type { CalendarEvent } from "taskify-core";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import {
  TASKIFY_CALENDAR_VIEW_KIND,
  calendarAddress,
  parseCalendarAddress,
} from "../lib/privateCalendar";
import type { NostrEvent } from "../domains/nostr/nostrPool";

type SubscribeManyResult = { close: (...args: unknown[]) => void };

const EMPTY_CALENDAR_EVENTS: CalendarEvent[] = [];
const EMPTY_RELAYS: string[] = [];

export type SubscribeManyPool = {
  subscribeMany: (
    relays: string[],
    filter: unknown,
    opts?: { onevent?: (ev: NostrEvent) => void; oneose?: (relay?: string) => void; closeOnEose?: boolean },
  ) => SubscribeManyResult;
  list?: (relays: string[], filters: unknown[]) => Promise<NostrEvent[]>;
};

type ReplaceableSubscriptionPool = {
  setRelays: (relays: string[]) => void;
  subscribe: (
    relays: string[],
    filters: Array<Record<string, unknown>>,
    onEvent: (ev: NostrEvent, from?: string) => void,
  ) => () => void;
};

export type CalendarViewSubscriptionTarget = {
  eventId: string;
  eventKey: string;
  viewAddress: string;
};

type SharedInboxSubscriptionConfig = {
  enabled?: boolean;
  ensurePool: () => SubscribeManyPool;
  handleEvent: (event: NostrEvent) => void | Promise<void>;
  lookbackSeconds: number;
  nostrPK?: string | null;
  nostrSkHex?: string | null;
  relays: string[];
};

type CalendarViewSubscriptionConfig = {
  enabled?: boolean;
  clockRef: MutableRefObject<Map<string, number>>;
  defaultRelays: string[];
  events: CalendarEvent[];
  handleEvent: (event: NostrEvent, target: CalendarViewSubscriptionTarget) => void | Promise<void>;
  inboxRelays: string[];
  pool: SubscribeManyPool;
};

type ReplaceableSubscriptionConfig = {
  author?: string | null;
  blocked?: boolean;
  defaultRelays: string[];
  dTag: string;
  enabled?: boolean;
  errorLogPrefix?: string;
  kind: number;
  normalizeRelayList: (relays: string[] | null | undefined) => string[];
  onEvent: (event: NostrEvent) => void | Promise<void>;
  pool: ReplaceableSubscriptionPool;
  stateRef: MutableRefObject<{ lastTimestamp?: number }>;
};

type UseNostrSubscriptionsParams = {
  appBackup?: ReplaceableSubscriptionConfig;
  bibleTracker?: ReplaceableSubscriptionConfig;
  calendarViews?: CalendarViewSubscriptionConfig;
  scriptureMemory?: ReplaceableSubscriptionConfig;
  sharedInbox?: SharedInboxSubscriptionConfig;
};

function eventTagValue(event: NostrEvent, name: string): string | undefined {
  const tag = event.tags.find((entry) => entry[0] === name);
  return tag?.[1];
}

function uniqueRelayList(relays: string[]): string[] {
  return Array.from(new Set(relays.map((relay) => relay.trim()).filter(Boolean)));
}

function useSharedInboxSubscription(config?: SharedInboxSubscriptionConfig) {
  const enabled = config?.enabled ?? true;
  const ensurePool = config?.ensurePool;
  const handleEvent = config?.handleEvent;
  const lookbackSeconds = config?.lookbackSeconds ?? 0;
  const nostrPK = config?.nostrPK;
  const nostrSkHex = config?.nostrSkHex;
  const relays = config?.relays ?? EMPTY_RELAYS;

  useEffect(() => {
    if (!enabled || !ensurePool || !handleEvent) return;
    if (!nostrPK || !nostrSkHex) return;
    if (!relays.length) return;

    const pool = ensurePool();
    const since = Math.max(0, Math.floor(Date.now() / 1000) - lookbackSeconds);
    let cancelled = false;
    const filter = { kinds: [4, 1059], "#p": [nostrPK], since };
    const subscription = pool.subscribeMany(relays, filter, {
      onevent: (event) => {
        if (cancelled) return;
        void handleEvent(event);
      },
    });

    void (async () => {
      try {
        if (typeof pool.list === "function") {
          const events = await pool.list(relays, [filter]);
          if (!cancelled && Array.isArray(events)) {
            events.forEach((event) => {
              void handleEvent(event);
            });
          }
        }
      } catch (err) {
        console.warn("Shared inbox fetch failed", err);
      }
    })();

    return () => {
      cancelled = true;
      try {
        subscription.close("taskify-shares");
      } catch {
        // ignore subscription close errors
      }
    };
  }, [enabled, ensurePool, handleEvent, lookbackSeconds, nostrPK, nostrSkHex, relays]);
}

function useCalendarViewSubscription(config?: CalendarViewSubscriptionConfig) {
  const enabled = config?.enabled ?? true;
  const clockRef = config?.clockRef;
  const defaultRelays = config?.defaultRelays ?? EMPTY_RELAYS;
  const events = config?.events ?? EMPTY_CALENDAR_EVENTS;
  const handleEvent = config?.handleEvent;
  const inboxRelays = config?.inboxRelays ?? EMPTY_RELAYS;
  const pool = config?.pool;

  useEffect(() => {
    if (!enabled || !clockRef || !handleEvent || !pool) return;

    const targets = events.filter(
      (event) => !!event.readOnly && !!event.viewAddress && !!event.eventKey,
    );
    if (!targets.length) return;

    const viewLookup = new Map<string, CalendarViewSubscriptionTarget>();
    const authors = new Set<string>();
    const dTags = new Set<string>();
    const relaySet = new Set<string>();
    targets.forEach((event) => {
      const addr = parseCalendarAddress(event.viewAddress || "");
      if (!addr || addr.kind !== TASKIFY_CALENDAR_VIEW_KIND) return;
      const viewAddress = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, addr.pubkey, addr.d);
      viewLookup.set(viewAddress, { eventId: event.id, eventKey: event.eventKey!, viewAddress });
      authors.add(addr.pubkey);
      dTags.add(addr.d);
      (event.inviteRelays ?? []).forEach((relay) => relaySet.add(relay));
    });
    if (!viewLookup.size || !authors.size || !dTags.size) return;

    const relays = uniqueRelayList([
      ...Array.from(relaySet),
      ...defaultRelays,
      ...inboxRelays,
      ...Array.from(DEFAULT_NOSTR_RELAYS),
    ]);
    if (!relays.length) return;

    let cancelled = false;
    const filter = {
      kinds: [TASKIFY_CALENDAR_VIEW_KIND],
      authors: Array.from(authors),
      "#d": Array.from(dTags),
    };

    const applyViewEvent = async (event: NostrEvent) => {
      if (cancelled || event.kind !== TASKIFY_CALENDAR_VIEW_KIND) return;
      const dTag = eventTagValue(event, "d");
      if (!dTag) return;
      const viewAddress = calendarAddress(TASKIFY_CALENDAR_VIEW_KIND, event.pubkey, dTag);
      const target = viewLookup.get(viewAddress);
      if (!target) return;
      const createdAt = typeof event.created_at === "number" ? event.created_at : 0;
      const last = clockRef.current.get(viewAddress) || 0;
      if (createdAt < last) return;
      clockRef.current.set(viewAddress, createdAt);
      await handleEvent(event, target);
    };

    const subscription = pool.subscribeMany(relays, filter, {
      onevent: (event) => {
        if (cancelled) return;
        void applyViewEvent(event);
      },
    });

    void (async () => {
      try {
        if (typeof pool.list === "function") {
          const eventsFromRelays = await pool.list(relays, [filter]);
          if (!cancelled && Array.isArray(eventsFromRelays)) {
            eventsFromRelays.forEach((event) => {
              void applyViewEvent(event);
            });
          }
        }
      } catch (err) {
        console.warn("Event view fetch failed", err);
      }
    })();

    return () => {
      cancelled = true;
      try {
        subscription.close("taskify-calendar-views");
      } catch {
        // ignore subscription close errors
      }
    };
  }, [clockRef, defaultRelays, enabled, events, handleEvent, inboxRelays, pool]);
}

function useReplaceableSubscription(config?: ReplaceableSubscriptionConfig) {
  const author = config?.author;
  const blocked = config?.blocked ?? false;
  const defaultRelays = config?.defaultRelays ?? EMPTY_RELAYS;
  const dTag = config?.dTag;
  const enabled = config?.enabled ?? true;
  const errorLogPrefix = config?.errorLogPrefix;
  const kind = config?.kind;
  const normalizeRelayList = config?.normalizeRelayList;
  const onEvent = config?.onEvent;
  const pool = config?.pool;
  const stateRef = config?.stateRef;

  useEffect(() => {
    if (!enabled || blocked) return;
    if (!author || !dTag || typeof kind !== "number") return;
    if (!normalizeRelayList || !onEvent || !pool || !stateRef) return;

    const relays = normalizeRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    pool.setRelays(relays);

    const since = stateRef.current.lastTimestamp || undefined;
    const filters = [
      {
        kinds: [kind],
        authors: [author],
        "#d": [dTag],
        ...(since ? { since } : {}),
        limit: 5,
      },
    ];
    const unsub = pool.subscribe(relays, filters, (event) => {
      Promise.resolve(onEvent(event)).catch((err) => {
        if (errorLogPrefix && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
          console.warn(errorLogPrefix, err);
        }
      });
    });
    return () => {
      try {
        unsub();
      } catch {
        // ignore subscription close errors
      }
    };
  }, [
    author,
    blocked,
    defaultRelays,
    dTag,
    enabled,
    errorLogPrefix,
    kind,
    normalizeRelayList,
    onEvent,
    pool,
    stateRef,
  ]);
}

export function useNostrSubscriptions({
  appBackup,
  bibleTracker,
  calendarViews,
  scriptureMemory,
  sharedInbox,
}: UseNostrSubscriptionsParams) {
  useSharedInboxSubscription(sharedInbox);
  useCalendarViewSubscription(calendarViews);
  useReplaceableSubscription(appBackup);
  useReplaceableSubscription(bibleTracker);
  useReplaceableSubscription(scriptureMemory);
}
