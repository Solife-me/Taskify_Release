/**
 * profileMeta.ts — kind:0 profile metadata publish/fetch for Taskify CLI.
 * Ported from taskify-pwa/src/nostr/ProfilePublisher.ts
 */

import NDK, { NDKPrivateKeySigner, NDKEvent } from "@nostr-dev-kit/ndk";
import { nip19, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizeRelayUrls } from "taskify-runtime-nostr";
import type { NostrEvent } from "nostr-tools";

export type ProfileMetadataDraft = {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
};

export type ProfileMetadata = ProfileMetadataDraft & {
  [key: string]: string | undefined;
};

function buildProfileContent(
  existing: Record<string, unknown>,
  draft: ProfileMetadataDraft,
): Record<string, string> {
  // Start from existing fields so we never wipe fields we didn't touch
  const content: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (typeof v === "string") content[k] = v;
  }

  const set = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed === "") {
      delete content[key];
    } else {
      content[key] = trimmed;
    }
  };

  set("name", draft.name);
  set("display_name", draft.displayName);
  set("about", draft.about);
  set("picture", draft.picture);
  set("banner", draft.banner);
  set("website", draft.website);
  set("nip05", draft.nip05);
  set("lud16", draft.lud16);

  return content;
}

/** Fetch the latest kind:0 event for a pubkey from relays. */
export async function fetchLatestProfileEvent(
  pubkeyHex: string,
  relays: string[],
  timeoutMs = 8_000,
): Promise<{ event: NostrEvent | null; metadata: ProfileMetadata }> {
  const relayList = normalizeRelayUrls(relays);
  const ndk = new NDK({ explicitRelayUrls: relayList });
  await Promise.race([ndk.connect(), new Promise<void>((r) => setTimeout(r, 3_000))]);

  const events = await Promise.race<Set<NDKEvent>>([
    ndk.fetchEvents({ kinds: [0], authors: [pubkeyHex], limit: 1 } as any),
    new Promise<Set<NDKEvent>>((r) => setTimeout(() => r(new Set()), timeoutMs)),
  ]).catch(() => new Set<NDKEvent>());

  if (!events.size) return { event: null, metadata: {} };

  // Pick highest created_at
  let latest: NDKEvent | null = null;
  for (const ev of events) {
    if (!latest || (ev.created_at ?? 0) > (latest.created_at ?? 0)) latest = ev;
  }
  if (!latest) return { event: null, metadata: {} };

  const raw = latest.rawEvent?.() as NostrEvent ?? (latest as unknown as NostrEvent);
  let metadata: ProfileMetadata = {};
  try {
    metadata = JSON.parse(raw.content ?? "{}");
  } catch {
    // ignore
  }
  return { event: raw, metadata };
}

export type PublishProfileResult = {
  event: NostrEvent;
  previous: NostrEvent | null;
  deletedIds: string[];
};

/** Publish a kind:0 profile metadata event. Deletes the previous event (kind:5). */
export async function publishProfile(
  nsec: string,
  draft: ProfileMetadataDraft,
  relays: string[],
  opts?: { timeoutMs?: number; reason?: string },
): Promise<PublishProfileResult> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) throw new Error("No relays configured.");

  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec.");
  const sk = decoded.data as Uint8Array;
  const pubkeyHex = getPublicKey(sk);
  const skHex = bytesToHex(sk);

  const ndk = new NDK({
    explicitRelayUrls: relayList,
    signer: new NDKPrivateKeySigner(skHex),
  });
  await Promise.race([ndk.connect(), new Promise<void>((r) => setTimeout(r, 3_000))]);

  // Fetch current kind:0 to merge with
  const { event: previous, metadata: existingMeta } = await fetchLatestProfileEvent(
    pubkeyHex,
    relayList,
    opts?.timeoutMs ?? 8_000,
  );

  const content = buildProfileContent(existingMeta as Record<string, unknown>, draft);

  const profileEvent = new NDKEvent(ndk);
  profileEvent.kind = 0;
  profileEvent.content = JSON.stringify(content);
  profileEvent.tags = [];
  profileEvent.created_at = Math.floor(Date.now() / 1000);
  await profileEvent.sign();
  await profileEvent.publish();

  const raw = profileEvent.rawEvent?.() as NostrEvent ?? (profileEvent as unknown as NostrEvent);
  if (!raw?.id) throw new Error("Failed to publish profile — no event id returned.");

  // Delete the previous event (NIP-09 kind:5)
  const deletedIds: string[] = [];
  if (previous?.id && previous.id !== raw.id) {
    try {
      const deleteEvent = new NDKEvent(ndk);
      deleteEvent.kind = 5;
      deleteEvent.content = opts?.reason ?? "superseded profile metadata";
      deleteEvent.tags = [["e", previous.id], ["k", "0"]];
      deleteEvent.created_at = Math.floor(Date.now() / 1000);
      await deleteEvent.sign();
      await deleteEvent.publish();
      deletedIds.push(previous.id);
    } catch {
      // Non-fatal — deletion is best-effort
    }
  }

  return { event: raw, previous: previous ?? null, deletedIds };
}
