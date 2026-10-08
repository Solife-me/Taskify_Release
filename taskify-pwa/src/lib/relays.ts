import { DEFAULT_NOSTR_RELAYS } from "taskify-core";

export { DEFAULT_NOSTR_RELAYS } from "taskify-core";
export type { DefaultRelay } from "taskify-core";

/**
 * The union of the given relay lists, falling back to the built-in relays only when all are
 * empty. Appending the built-ins to lists that are already configured sent traffic to relays the
 * user never chose.
 */
export function relaysOrDefaults(...lists: Array<readonly (string | null | undefined)[] | null | undefined>): string[] {
  const relays = Array.from(new Set(
    lists.flatMap((list) => list ?? [])
      .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
      .filter(Boolean),
  ));
  return relays.length ? relays : Array.from(DEFAULT_NOSTR_RELAYS);
}

/** Taskify's own relay, which every board also syncs on (see `boardSyncRelays`). */
export const TASKIFY_SYNC_RELAY = "wss://relay.solife.me";

/**
 * A board's relays plus Taskify's own. Each device keeps its own relay list for a board (board
 * events don't carry one), so devices drift apart until they share no relay that still answers,
 * and changes stop crossing between them. Every client also reads and writes every board on
 * Taskify's relay, so there is always one they share. The native clients do the same
 * (`Board.syncRelayURLs`).
 */
export function boardSyncRelays(relays: readonly string[]): string[] {
  const normalize = (relay: string) => relay.trim().toLowerCase().replace(/\/+$/, "");
  return relays.some((relay) => normalize(relay) === TASKIFY_SYNC_RELAY)
    ? [...relays]
    : [...relays, TASKIFY_SYNC_RELAY];
}
