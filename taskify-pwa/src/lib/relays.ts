export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
] as const;

export type DefaultRelay = typeof DEFAULT_NOSTR_RELAYS[number];
