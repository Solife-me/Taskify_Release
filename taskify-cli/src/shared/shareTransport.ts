import { hexToBytes } from "@noble/hashes/utils.js";
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  nip59,
  type Event,
} from "nostr-tools";
import { parseShareEnvelope, type ShareEnvelope } from "taskify-core";
import { mineEventTemplate, relayProofOfWorkDifficulty } from "taskify-runtime-nostr";

export type InboxShareItem = {
  wrapId: string;
  rumorId: string;
  senderPubkey: string;
  createdAt: number;
  raw: string;
  envelope: ShareEnvelope;
};

function normalizeRelays(relays: string[]): string[] {
  return Array.from(
    new Set(
      (relays || [])
        .map((relay) => (typeof relay === "string" ? relay.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function configureSimplePoolAuth(pool: SimplePool, secretKey: Uint8Array): void {
  pool.automaticallyAuth =
    () => async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, secretKey);
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
  const senderPublicKey = getPublicKey(senderSecret);
  const recipient = input.recipientPubkeyHex;
  const difficulty = await relayProofOfWorkDifficulty(relays);
  const rumor = nip59.createRumor(
    {
      kind: 14,
      content: JSON.stringify(input.envelope),
      tags: [["p", recipient]],
      created_at: Math.floor(Date.now() / 1000),
    },
    senderSecret,
  );
  const wrapped: Event[] = [];
  for (const wrapRecipient of Array.from(new Set([senderPublicKey, recipient]))) {
    const seal = nip59.createSeal(rumor, senderSecret, wrapRecipient);
    const wrapKey = generateSecretKey();
    const conversationKey = nip44.v2.utils.getConversationKey(wrapKey, wrapRecipient);
    const wrapContent = await nip44.v2.encrypt(JSON.stringify(seal), conversationKey);
    const wrapTemplate = {
      kind: 1059,
      content: wrapContent,
      tags: [["p", wrapRecipient]],
      created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
    };
    const minedTemplate = await mineEventTemplate(wrapTemplate, wrapKey, difficulty);
    wrapped.push(finalizeEvent(minedTemplate, wrapKey));
  }

  const pool = new SimplePool();
  configureSimplePoolAuth(pool, senderSecret);
  try {
    for (const event of wrapped) {
      await Promise.any(pool.publish(relays, event, {
        onauth: async template => finalizeEvent(template, senderSecret), maxWait: 10_000,
      }));
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
  configureSimplePoolAuth(pool, secret);
  try {
    const wraps = await new Promise<Event[]>(resolve => {
      const events = new Map<string, Event>();
      pool.subscribeEose(relays, {
        kinds: [1059], "#p": [pubkey], limit: Math.max(1, Math.min(200, input.limit ?? 50)),
      }, {
        maxWait: 5_000,
        onauth: async template => finalizeEvent(template, secret),
        onevent: event => events.set(event.id, event),
        onclose: () => resolve([...events.values()]),
      });
    });
    const out: InboxShareItem[] = [];
    for (const wrap of wraps) {
      try {
        const rumor = nip59.unwrapEvent(wrap as Event, secret) as {
          id: string;
          content: string;
          pubkey: string;
          created_at: number;
        };
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
