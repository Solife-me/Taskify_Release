import { verifyEvent, type NostrEvent } from 'nostr-tools';
import { normalizeRelayUrls } from './relayUrls.js';

/** Include historical default relays as well as the account's current signed inbox. */
export function inboxReadRelays(events: NostrEvent[], pubkey: string, fallback: string[]): string[] {
  const latest = events.filter(event => {
    if (event.kind !== 10050 || event.pubkey !== pubkey) return false;
    try { return verifyEvent(event); } catch { return false; }
  }).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const advertised = (latest?.tags ?? []).filter(tag => tag[0] === 'relay').map(tag => tag[1])
    .filter((url): url is string => typeof url === 'string' && /^wss?:\/\//i.test(url));
  return normalizeRelayUrls([...advertised, ...fallback]);
}
