import type { NostrEvent } from "nostr-tools";
import { normalizeRelayUrls } from "./relayUrls.js";

export type NostrOutboxMutationKind = "nostr.publish";

export type NostrOutboxPublishPayload = {
  event: NostrEvent;
  relayUrls: string[];
  replaceableKey?: string | null;
};

/** When a relay that refused an event outright may be offered it again. */
export type OutboxRelayRejection = { count: number; retryAfter: number };

export type NostrOutboxMutation = {
  id: string;
  kind: NostrOutboxMutationKind;
  payload: NostrOutboxPublishPayload;
  intentAt: number;
  attempts: number;
  lastError: string | null;
  ackedRelays: string[];
  pendingRelays: string[];
  nextAttemptAt: number | null;
  updatedAt: number;
  /**
   * Relays that refused this event outright (blocked/restricted/invalid). The event stays queued
   * for them, since it may be the only copy, but each is held back until its retry time instead
   * of being resent on every attempt. Matches native `RelayRejectionBackoff`.
   */
  relayRejections?: Record<string, OutboxRelayRejection>;
};

const REJECTION_FIRST_BACKOFF_MS = 60 * 60_000;
const REJECTION_MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;

/** Records outright refusals: 1 hour after the first, doubling each time, capped at a week. */
export function recordOutboxRelayRejections(
  mutation: NostrOutboxMutation,
  relayUrls: string[],
  nowMs = Date.now(),
): NostrOutboxMutation {
  const relays = normalizeRelayUrls(relayUrls);
  if (!relays.length) return mutation;
  const rejections = { ...(mutation.relayRejections ?? {}) };
  for (const relay of relays) {
    const count = (rejections[relay]?.count ?? 0) + 1;
    const delay = Math.min(REJECTION_MAX_BACKOFF_MS, REJECTION_FIRST_BACKOFF_MS * 2 ** (count - 1));
    rejections[relay] = { count, retryAfter: nowMs + delay };
  }
  return { ...mutation, relayRejections: rejections };
}

/** When the earliest held-back relay may be retried, or null when none are held back. */
export function earliestRejectionRelease(mutation: NostrOutboxMutation, nowMs = Date.now()): number | null {
  let earliest: number | null = null;
  for (const relay of normalizeRelayUrls(mutation.pendingRelays)) {
    const retryAfter = mutation.relayRejections?.[relay]?.retryAfter;
    if (!retryAfter || retryAfter <= nowMs) continue;
    earliest = earliest == null ? retryAfter : Math.min(earliest, retryAfter);
  }
  return earliest;
}

export type NostrOutboxStore = {
  get(id: string): Promise<NostrOutboxMutation | undefined>;
  put(mutation: NostrOutboxMutation): Promise<void>;
  delete(id: string): Promise<void>;
  listPending(): Promise<NostrOutboxMutation[]>;
};

export function cloneNostrEvent(event: NostrEvent): NostrEvent {
  return {
    ...event,
    tags: Array.isArray(event.tags) ? event.tags.map((tag) => [...tag]) : [],
  };
}

export function createNostrOutboxMutation(args: {
  id: string;
  event: NostrEvent;
  relayUrls: string[];
  replaceableKey?: string | null;
  nowMs?: number;
  existing?: NostrOutboxMutation;
  nextAttemptAt?: number | null;
}): NostrOutboxMutation {
  const nowMs = args.nowMs ?? Date.now();
  const relayUrls = normalizeRelayUrls(args.relayUrls);
  const existing = args.existing;
  const sameEvent = existing?.payload.event.id === args.event.id;
  const ackedRelays = sameEvent
    ? normalizeRelayUrls(existing.ackedRelays).filter((relay) => relayUrls.includes(relay))
    : [];
  const pendingRelays = relayUrls.filter((relay) => !ackedRelays.includes(relay));

  return {
    id: args.id,
    kind: "nostr.publish",
    payload: {
      event: cloneNostrEvent(args.event),
      relayUrls,
      replaceableKey: args.replaceableKey ?? null,
    },
    intentAt: sameEvent && existing ? existing.intentAt : nowMs,
    attempts: sameEvent && existing ? existing.attempts : 0,
    lastError: sameEvent && existing ? existing.lastError : null,
    ackedRelays,
    pendingRelays,
    nextAttemptAt: args.nextAttemptAt ?? null,
    updatedAt: nowMs,
    ...(sameEvent && existing?.relayRejections ? { relayRejections: existing.relayRejections } : {}),
  };
}

/** The relays to send to now: still pending, and not held back after refusing the event. */
export function pendingRelayUrlsForMutation(mutation: NostrOutboxMutation, nowMs = Date.now()): string[] {
  const pending = normalizeRelayUrls(mutation.pendingRelays);
  const relays = pending.length ? pending : normalizeRelayUrls(mutation.payload.relayUrls);
  return relays.filter((relay) => !((mutation.relayRejections?.[relay]?.retryAfter ?? 0) > nowMs));
}

export function mergeOutboxRelayAcks(mutation: NostrOutboxMutation, ackedRelays: string[], nowMs = Date.now()): NostrOutboxMutation | null {
  const intendedRelays = normalizeRelayUrls(mutation.payload.relayUrls);
  const nextAcked = normalizeRelayUrls([...mutation.ackedRelays, ...ackedRelays]).filter(
    (relay) => !intendedRelays.length || intendedRelays.includes(relay),
  );

  if (!intendedRelays.length || intendedRelays.every((relay) => nextAcked.includes(relay))) {
    return null;
  }

  return {
    ...mutation,
    attempts: mutation.attempts + 1,
    lastError: null,
    ackedRelays: nextAcked,
    pendingRelays: intendedRelays.filter((relay) => !nextAcked.includes(relay)),
    nextAttemptAt: null,
    updatedAt: nowMs,
  };
}

export function markOutboxPublishFailure(args: {
  mutation: NostrOutboxMutation;
  ackedRelays?: string[];
  error: unknown;
  nextAttemptAt: number;
  nowMs?: number;
}): NostrOutboxMutation | null {
  const nowMs = args.nowMs ?? Date.now();
  const intendedRelays = normalizeRelayUrls(args.mutation.payload.relayUrls);
  const nextAcked = normalizeRelayUrls([
    ...args.mutation.ackedRelays,
    ...(args.ackedRelays ?? []),
  ]).filter((relay) => !intendedRelays.length || intendedRelays.includes(relay));

  if (intendedRelays.length && intendedRelays.every((relay) => nextAcked.includes(relay))) {
    return null;
  }

  return {
    ...args.mutation,
    attempts: args.mutation.attempts + 1,
    lastError: errorToMessage(args.error),
    ackedRelays: nextAcked,
    pendingRelays: intendedRelays.length ? intendedRelays.filter((relay) => !nextAcked.includes(relay)) : [],
    nextAttemptAt: args.nextAttemptAt,
    updatedAt: nowMs,
  };
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Publish failed";
  }
}
