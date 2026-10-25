/**
 * profileMeta.ts — kind:0 profile metadata publish/fetch for Taskify CLI.
 * Ported from taskify-pwa/src/nostr/ProfilePublisher.ts
 */

import { nip19, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { normalizeRelayUrls, withStandaloneSession, type StandaloneNostrSession } from "taskify-runtime-nostr";
import type { NostrEvent } from "nostr-tools";
import type { WithStandaloneSession } from "./shared/botCommands.js";
import { sanitizeRemote } from "./shared/displaySafe.js";

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

/** The latest signed kind:0 event for a pubkey, read through an open session. */
async function latestProfile(
  session: StandaloneNostrSession,
  pubkeyHex: string,
  timeoutMs: number,
): Promise<{ event: NostrEvent | null; metadata: ProfileMetadata }> {
  // Only signed copies count (`fetchVerified`): `profile` merges this into what it republishes
  // under the user's key.
  const events = (await session.fetchVerified({ kinds: [0], authors: [pubkeyHex], limit: 1 }, { timeoutMs }))
    .filter((event) => event.kind === 0 && event.pubkey === pubkeyHex);
  let raw: NostrEvent | null = null;
  for (const event of events) {
    if (!raw || (event.created_at ?? 0) > (raw.created_at ?? 0)) raw = event;
  }
  if (!raw) return { event: null, metadata: {} };
  let metadata: ProfileMetadata = {};
  try {
    metadata = sanitizeRemote(JSON.parse(raw.content ?? "{}"));
  } catch {
    // ignore
  }
  return { event: raw, metadata };
}

/** Fetch the latest kind:0 event for a pubkey from relays. */
export async function fetchLatestProfileEvent(
  pubkeyHex: string,
  relays: string[],
  options: { timeoutMs?: number; withSession?: WithStandaloneSession } = {},
): Promise<{ event: NostrEvent | null; metadata: ProfileMetadata }> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) return { event: null, metadata: {} };
  return (options.withSession ?? withStandaloneSession)({ relays: relayList }, (session) =>
    latestProfile(session, pubkeyHex, options.timeoutMs ?? 8_000));
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
  opts?: { timeoutMs?: number; reason?: string; withSession?: WithStandaloneSession },
): Promise<PublishProfileResult> {
  const relayList = normalizeRelayUrls(relays);
  if (!relayList.length) throw new Error("No relays configured.");

  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec.");
  const sk = decoded.data as Uint8Array;
  const pubkeyHex = getPublicKey(sk);

  return (opts?.withSession ?? withStandaloneSession)({ relays: relayList, secretKeyHex: bytesToHex(sk) }, async (session) => {
    // Merge with the current kind:0, so fields this draft leaves out are kept.
    const { event: previous, metadata: existingMeta } = await latestProfile(session, pubkeyHex, opts?.timeoutMs ?? 8_000);
    const content = buildProfileContent(existingMeta as Record<string, unknown>, draft);
    const { event: raw } = await session.publish({ kind: 0, content: JSON.stringify(content), tags: [] });
    if (!raw?.id) throw new Error("Failed to publish profile — no event id returned.");

    // Delete the previous event (NIP-09 kind:5); best-effort.
    const deletedIds: string[] = [];
    if (previous?.id && previous.id !== raw.id) {
      try {
        await session.publish({
          kind: 5,
          content: opts?.reason ?? "superseded profile metadata",
          tags: [["e", previous.id], ["k", "0"]],
        });
        deletedIds.push(previous.id);
      } catch {
        // Non-fatal — deletion is best-effort
      }
    }
    return { event: raw, previous: previous ?? null, deletedIds };
  });
}
