import { type NostrEvent } from 'nostr-tools';
/** Include historical default relays as well as the account's current signed inbox. */
export declare function inboxReadRelays(events: NostrEvent[], pubkey: string, fallback: string[]): string[];
