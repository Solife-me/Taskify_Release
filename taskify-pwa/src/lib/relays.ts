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
