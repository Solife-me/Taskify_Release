import { hexToBytes } from "@noble/hashes/utils.js";
import { SimplePool, getPublicKey, nip59, type Event } from "nostr-tools";
import { parseShareEnvelope, type ShareEnvelope } from "taskify-core";

export type InboxShareItem = {
  wrapId: string;
  rumorId: string;
  senderPubkey: string;
  createdAt: number;
  raw: string;
  envelope: ShareEnvelope;
};

function normalizeRelays(relays: string[]): string[] {
  return Array.from(new Set((relays || []).map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean)));
}

export async function sendShareEnvelopeNip17(input: {
  envelope: ShareEnvelope;
  senderSecretHex: string;
  recipientPubkeyHex: string;
  relays: string[];
}): Promise<void> {
  const relays = normalizeRelays(input.relays);
  if (!relays.length) throw new Error("No relays configured.");
  const senderSecret = hexToBytes(input.senderSecretHex);
  const wrapped = nip59.wrapManyEvents(
    {
      kind: 14,
      content: JSON.stringify(input.envelope),
      tags: [["p", input.recipientPubkeyHex]],
      created_at: Math.floor(Date.now() / 1000),
    },
    senderSecret,
    [input.recipientPubkeyHex],
  );
  const pool = new SimplePool();
  try {
    for (const evt of wrapped) {
      await Promise.allSettled(pool.publish(relays, evt));
    }
  } finally {
    pool.close(relays);
  }
}

export async function fetchShareInboxNip17(input: {
  recipientSecretHex: string;
  relays: string[];
  limit?: number;
}): Promise<InboxShareItem[]> {
  const relays = normalizeRelays(input.relays);
  if (!relays.length) return [];
  const secret = hexToBytes(input.recipientSecretHex);
  const pubkey = getPublicKey(secret);
  const pool = new SimplePool();
  try {
    const wraps = await pool.querySync(relays, {
      kinds: [1059],
      "#p": [pubkey],
      limit: Math.max(1, Math.min(200, input.limit ?? 50)),
    });
    const out: InboxShareItem[] = [];
    for (const wrap of wraps) {
      try {
        const rumor = nip59.unwrapEvent(wrap as Event, secret) as { id: string; content: string; pubkey: string; created_at: number };
        const envelope = parseShareEnvelope(rumor.content);
        if (!envelope) continue;
        out.push({
          wrapId: wrap.id,
          rumorId: rumor.id,
          senderPubkey: rumor.pubkey,
          createdAt: rumor.created_at,
          raw: rumor.content,
          envelope,
        });
      } catch {
        // ignore invalid wraps
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  } finally {
    pool.close(relays);
  }
}
