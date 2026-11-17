import { hexToBytes } from "@noble/hashes/utils.js";
import { SimplePool, finalizeEvent, type Event } from "nostr-tools";
import {
  createNip17Rumor,
  nip17Timestamp,
  nip17WrapRecipients,
  openNip17GiftWrap,
  parseShareEnvelope,
  sealNip17Rumor,
  wrapNip17Seal,
  type ShareEnvelope,
} from "taskify-core";
import { sanitizeRemote } from "./displaySafe.js";
import {
  classifyRelayRejection,
  inboxReadRelays,
  newNip17WrapKey,
  nip17Crypto,
  nip17KeyParty,
  publishWithRelayProofOfWork,
  takeWhenPublishSlotIsAvailable,
  type RelayPublishBudget,
} from "taskify-runtime-nostr";
import { cliProofOfWorkSettings } from "./relaySettings.js";
import { createCliRelayPublishBudget } from "./nodeRuntimeSession.js";

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

// NIP-42 is answered lazily through `onauth`, when a relay refuses with `auth-required:`.
// nostr-tools' `automaticallyAuth` answers every challenge eagerly, but rethrows a refused AUTH
// as an unhandled rejection, which ends the process.
function authSigner(secretKey: Uint8Array) {
  return async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secretKey);
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : String(reason);
}

function miningOptions() {
  const settings = cliProofOfWorkSettings();
  return { hashFactory: settings.hashFactory, timeoutMs: settings.timeoutMs };
}

/**
 * Publishes one gift wrap. A relay that refuses it for too little NIP-13 work and names a target
 * gets the same wrap mined again to that target. Resolves once any relay accepted it.
 */
async function publishWrap(
  pool: SimplePool,
  relays: string[],
  template: Parameters<typeof finalizeEvent>[0],
  wrapKey: Uint8Array,
  onauth: ReturnType<typeof authSigner>,
  publishBudget: RelayPublishBudget,
): Promise<void> {
  const original = finalizeEvent(template, wrapKey);
  const sign = async (candidate: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(candidate, wrapKey);
  const attempted = new Set<string>();
  const errors: string[] = [];
  try {
    await publishWithRelayProofOfWork(original, relays, { pubkey: original.pubkey, sign }, async (event, urls) => {
      const selection = urls.some(relay => attempted.has(relay))
        ? await takeWhenPublishSlotIsAvailable(publishBudget, urls)
        : publishBudget.take(urls, Date.now());
      const targets = selection.ready;
      if (!targets.length) {
        const wait = selection.deferredUntil == null ? "later" : new Date(selection.deferredUntil).toISOString();
        throw new Error(`All target relays are being paced; the next publish slot is ${wait}.`);
      }
      targets.forEach(relay => attempted.add(relay));
      try {
        const results = await Promise.allSettled(pool.publish(targets, event, { onauth, maxWait: 10_000 }));
        const accepted: string[] = [];
        const rejections = new Map<string, string>();
        results.forEach((result, index) => {
          const relay = targets[index];
          if (result.status === "fulfilled") {
            accepted.push(relay);
            publishBudget.recordAccepted(relay, Date.now());
            return;
          }
          const reason = reasonText(result.reason);
          rejections.set(relay, reason);
          errors.push(`${relay}: ${reason}`);
          const kind = classifyRelayRejection(reason);
          if (kind === "rate-limited") publishBudget.recordRateLimited(relay, Date.now());
          else if (kind === "banned") publishBudget.recordBanned(relay, Date.now());
        });
        return { accepted, rejections };
      } finally {
        const releasedAt = Date.now();
        for (const relay of targets) publishBudget.release(relay, releasedAt);
      }
    }, { ...cliProofOfWorkSettings(), ...miningOptions() });
  } catch (error) {
    if (!errors.length) throw error;
    throw new Error(`No relay accepted the message. ${errors.join("; ")}`, { cause: error });
  }
}

/** `fallback` plus the relays in the recipient's newest signed inbox list (kind 10050). */
async function recipientInboxRelays(recipient: string, fallback: string[]): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(fallback, { kinds: [10050], authors: [recipient] }, { maxWait: 5_000 });
    return inboxReadRelays(events, recipient, fallback);
  } catch {
    return fallback;
  } finally {
    pool.close(fallback);
  }
}

export async function sendShareEnvelopeNip17(input: {
  envelope: ShareEnvelope;
  senderSecretHex: string;
  recipientPubkeyHex: string;
  relays: string[];
}): Promise<void> {
  const ownRelays = normalizeRelays(input.relays);
  if (!ownRelays.length) throw new Error("No relays configured.");
  const senderSecret = hexToBytes(input.senderSecretHex);
  const account = nip17KeyParty(senderSecret);
  const recipient = input.recipientPubkeyHex.toLowerCase();
  // NIP-17: deliver to the recipient's signed inbox relays as well as our own.
  const relays = await recipientInboxRelays(recipient, ownRelays);
  const now = Date.now() / 1000;
  // taskify-core's NIP-17 rules, shared with the apps (fixtures/nip17-vectors.json).
  const rumor = createNip17Rumor(
    { sender: account.pubkey, recipients: [recipient], content: JSON.stringify(input.envelope), createdAt: now },
    nip17Crypto,
  );
  const wrapped: Array<{ template: Parameters<typeof finalizeEvent>[0]; wrapKey: Uint8Array }> = [];
  for (const wrapRecipient of nip17WrapRecipients(rumor)) {
    const seal = await sealNip17Rumor(rumor, wrapRecipient, account, nip17Timestamp(now));
    const wrapKey = newNip17WrapKey();
    const template = await wrapNip17Seal(seal, wrapRecipient, wrapKey, nip17Timestamp(now));
    wrapped.push({ template, wrapKey: wrapKey.secretKey });
  }

  const pool = new SimplePool();
  const publishBudget = createCliRelayPublishBudget();
  try {
    for (const { template, wrapKey } of wrapped) {
      await publishWrap(pool, relays, template, wrapKey, authSigner(senderSecret), publishBudget);
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
  const receiver = nip17KeyParty(secret);
  const pubkey = receiver.pubkey;
  const pool = new SimplePool();
  try {
    const wraps = await new Promise<Event[]>(resolve => {
      const events = new Map<string, Event>();
      pool.subscribeEose(relays, {
        kinds: [1059], "#p": [pubkey], limit: Math.max(1, Math.min(200, input.limit ?? 50)),
      }, {
        maxWait: 5_000,
        onauth: authSigner(secret),
        onevent: event => events.set(event.id, event),
        onclose: () => resolve([...events.values()]),
      });
    });
    const out: InboxShareItem[] = [];
    for (const wrap of wraps) {
      try {
        const opened = await openNip17GiftWrap(wrap, receiver, nip17Crypto);
        if (!opened || opened.rumor.kind !== 14) continue;
        const { rumor } = opened;
        const envelope = parseShareEnvelope(rumor.content);
        if (!envelope) continue;
        out.push({
          wrapId: wrap.id,
          rumorId: rumor.id,
          senderPubkey: opened.senderPubkey,
          createdAt: rumor.created_at,
          raw: rumor.content,
          // Anyone can send a share; its text is shown in the terminal.
          envelope: sanitizeRemote(envelope),
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
