export type RuntimeRelayBoard = {
    relays?: string[] | null;
};
/**
 * Builds the transport catalog used by non-browser clients. Account relays are
 * discovery relays; board relays are authoritative task-data relays. A runtime
 * must know both before connecting so a board never becomes invisible merely
 * because its relays differ from the profile defaults.
 */
export declare function collectRuntimeRelayUrls(accountRelays: string[], boards: RuntimeRelayBoard[]): string[];
