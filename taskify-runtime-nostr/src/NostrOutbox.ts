import type { NostrEvent } from "nostr-tools";
import { normalizeRelayUrls } from "./relayUrls.js";

export type NostrOutboxMutationKind = "nostr.publish";

export type NostrOutboxPublishPayload = {
  event: NostrEvent;
  relayUrls: string[];
  replaceableKey?: string | null;
};

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
};

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
  };
}

export function pendingRelayUrlsForMutation(mutation: NostrOutboxMutation): string[] {
  const pending = normalizeRelayUrls(mutation.pendingRelays);
  if (pending.length) return pending;
  return normalizeRelayUrls(mutation.payload.relayUrls);
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
