import { normalizeRelayUrls } from "./relayUrls.js";
/**
 * Builds the transport catalog used by non-browser clients. Account relays are
 * discovery relays; board relays are authoritative task-data relays. A runtime
 * must know both before connecting so a board never becomes invisible merely
 * because its relays differ from the profile defaults.
 */
export function collectRuntimeRelayUrls(accountRelays, boards) {
    return normalizeRelayUrls([
        ...accountRelays,
        ...boards.flatMap((board) => board.relays ?? []),
    ]);
}
