/**
 * NIP-17 private messages: an unsigned rumor (kind 14 chat, 15 file, 7 reaction, ...) sealed by
 * its author (kind 13) and gift-wrapped (kind 1059) once per recipient, plus once for the
 * author's own inbox, each wrap under a one-time key.
 *
 * Every Taskify client builds and opens these the same way; the rules here match iOS
 * (`NIP17GiftWrap`) and are checked against shared vectors (`fixtures/nip17-vectors.json`).
 * Crypto is injected: the account half comes from a signer (a local key now, NIP-07 or NIP-46
 * later), so nothing here touches a secret key.
 */

export const NIP17_WRAP_KIND = 1059;
export const NIP17_SEAL_KIND = 13;
export const NIP17_CHAT_KIND = 14;
export const NIP17_FILE_KIND = 15;

/** NIP-59: seal and wrap timestamps are randomized up to two days into the past. */
export const NIP17_TIMESTAMP_JITTER_SECONDS = 2 * 24 * 60 * 60;

export type Nip17EventTemplate = { kind: number; content: string; tags: string[][]; created_at: number };
export type Nip17SignedEvent = Nip17EventTemplate & { id: string; pubkey: string; sig: string };
/** An unsigned event with its id: the message itself, identical in every recipient's wrap. */
export type Nip17Rumor = Nip17EventTemplate & { id: string; pubkey: string };

/** The account sending or receiving (a signer). */
export interface Nip17Account {
  readonly pubkey: string;
  sign(template: Nip17EventTemplate): Promise<Nip17SignedEvent>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}

/** A one-time wrap key. The caller signs the wrap with it (mining proof of work if needed). */
export interface Nip17WrapKey {
  readonly pubkey: string;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
}

export interface Nip17Crypto {
  /** NIP-01 event id (sha256 of the serialized event), hex. */
  eventId(event: Nip17EventTemplate & { pubkey: string }): string;
  /** Checks id and signature. */
  verifyEvent(event: Nip17SignedEvent): boolean;
}

const HEX_64 = /^[0-9a-f]{64}$/;

function normalizePubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return HEX_64.test(lower) ? lower : null;
}

function pTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "p") continue;
    const pubkey = normalizePubkey(tag[1]);
    if (pubkey && !out.includes(pubkey)) out.push(pubkey);
  }
  return out;
}

function isStringTags(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"));
}

function isSignedEvent(value: unknown): value is Nip17SignedEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.kind === "number" &&
    typeof event.content === "string" &&
    typeof event.created_at === "number" &&
    isStringTags(event.tags)
  );
}

/** A seal or wrap timestamp: now, or (the NIP-59 default) a random moment up to two days ago. */
export function nip17Timestamp(nowSeconds: number, random: (() => number) | null = Math.random): number {
  const now = Math.floor(nowSeconds);
  if (!random) return now;
  return now - Math.floor(random() * NIP17_TIMESTAMP_JITTER_SECONDS);
}

/**
 * The message. Direct messages tag their recipient; group messages tag every member, the
 * sender first (0xchat counts `p` tags to tell groups from direct messages).
 */
export function createNip17Rumor(
  input: {
    sender: string;
    recipients: string[];
    content: string;
    createdAt: number;
    kind?: number;
    group?: boolean;
    extraTags?: string[][];
  },
  crypto: Pick<Nip17Crypto, "eventId">,
): Nip17Rumor {
  const sender = normalizePubkey(input.sender);
  if (!sender) throw new Error("NIP-17 sender must be a hex public key.");
  const recipients = [...new Set(input.recipients.map(normalizePubkey).filter((key): key is string => !!key))]
    .filter((key) => !input.group || key !== sender);
  if (!recipients.length) throw new Error("NIP-17 message needs a recipient.");
  const tags = [
    ...(input.group ? [["p", sender]] : []),
    ...recipients.map((key) => ["p", key]),
    ...(input.extraTags ?? []).filter((tag) => Array.isArray(tag) && tag.length > 0),
  ];
  const unsigned = {
    kind: input.kind ?? NIP17_CHAT_KIND,
    content: input.content,
    tags,
    created_at: Math.floor(input.createdAt),
    pubkey: sender,
  };
  return { ...unsigned, id: crypto.eventId(unsigned) };
}

/** Who gets a wrap: everyone the rumor tags, and the sender (for their other devices). */
export function nip17WrapRecipients(rumor: Nip17Rumor): string[] {
  const sender = normalizePubkey(rumor.pubkey);
  return [...new Set([...pTags(rumor.tags), ...(sender ? [sender] : [])])];
}

/** The author seals the rumor to one recipient. */
export async function sealNip17Rumor(
  rumor: Nip17Rumor,
  recipient: string,
  account: Nip17Account,
  createdAt: number,
): Promise<Nip17SignedEvent> {
  if (normalizePubkey(account.pubkey) !== normalizePubkey(rumor.pubkey)) {
    throw new Error("Only the rumor's author can seal it.");
  }
  const content = await account.nip44Encrypt(recipient, JSON.stringify(rumor));
  return account.sign({ kind: NIP17_SEAL_KIND, content, tags: [], created_at: Math.floor(createdAt) });
}

/** The wrap template for one recipient; sign it with the same one-time key. */
export async function wrapNip17Seal(
  seal: Nip17SignedEvent,
  recipient: string,
  wrapKey: Nip17WrapKey,
  createdAt: number,
): Promise<Nip17EventTemplate> {
  const target = normalizePubkey(recipient);
  if (!target) throw new Error("NIP-17 recipient must be a hex public key.");
  const content = await wrapKey.nip44Encrypt(target, JSON.stringify(seal));
  return { kind: NIP17_WRAP_KIND, content, tags: [["p", target]], created_at: Math.floor(createdAt) };
}

export type OpenedNip17Message = {
  /** The outer event's id: differs per recipient. */
  wrapId: string;
  rumor: Nip17Rumor;
  /** The seal's author, which the rumor must name: who really sent it. */
  senderPubkey: string;
};

/**
 * Opens a gift wrap addressed to `receiver`, or returns null. Rules (as iOS):
 * the wrap is signed and tags the receiver; the seal is a signed kind 13 with no tags; the
 * rumor is unsigned, names the seal's author, and has a correct id. Decryption with the seal
 * author's key already proves who wrote it, and the checks keep every client agreeing on what
 * opens.
 */
export async function openNip17GiftWrap(
  wrap: Nip17SignedEvent,
  receiver: Pick<Nip17Account, "pubkey" | "nip44Decrypt">,
  crypto: Nip17Crypto,
): Promise<OpenedNip17Message | null> {
  const me = normalizePubkey(receiver.pubkey);
  if (!me || !isSignedEvent(wrap) || wrap.kind !== NIP17_WRAP_KIND) return null;
  if (!pTags(wrap.tags).includes(me)) return null;
  if (!crypto.verifyEvent(wrap)) return null;
  let seal: unknown;
  try {
    seal = JSON.parse(await receiver.nip44Decrypt(wrap.pubkey, wrap.content));
  } catch {
    return null;
  }
  if (!isSignedEvent(seal) || seal.kind !== NIP17_SEAL_KIND || seal.tags.length > 0) return null;
  if (!crypto.verifyEvent(seal)) return null;
  const sender = normalizePubkey(seal.pubkey);
  if (!sender) return null;
  let rumor: unknown;
  try {
    rumor = JSON.parse(await receiver.nip44Decrypt(sender, seal.content));
  } catch {
    return null;
  }
  if (!rumor || typeof rumor !== "object" || "sig" in rumor) return null;
  const candidate = rumor as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.kind !== "number" ||
    typeof candidate.content !== "string" ||
    typeof candidate.created_at !== "number" ||
    !isStringTags(candidate.tags) ||
    normalizePubkey(candidate.pubkey) !== sender
  ) {
    return null;
  }
  const opened: Nip17Rumor = {
    id: candidate.id.toLowerCase(),
    pubkey: sender,
    kind: candidate.kind,
    content: candidate.content,
    tags: candidate.tags,
    created_at: candidate.created_at,
  };
  const { id, ...unsigned } = opened;
  if (crypto.eventId({ ...unsigned, pubkey: candidate.pubkey as string }) !== id) return null;
  return { wrapId: wrap.id, rumor: opened, senderPubkey: sender };
}

/**
 * Who a message is addressed to, for chat. NUT-18 payment senders built on CDK leave the
 * rumor's `p` tags out; the wrap opened with this key, so it was meant for this account. A copy
 * the account sent itself without tags names no one and yields null.
 */
export function nip17MessageRecipients(message: OpenedNip17Message, receiver: string): string[] | null {
  const tagged = pTags(message.rumor.tags);
  if (tagged.length) return tagged;
  const me = normalizePubkey(receiver);
  if (!me || message.senderPubkey === me) return null;
  return [me];
}

/**
 * Builds a message's gift wraps: one per recipient and one for the sender, each under a fresh
 * one-time key. `signWrap` signs the template with that key (and mines proof of work if the
 * relays want it).
 */
export async function buildNip17GiftWraps<K extends Nip17WrapKey>(
  rumor: Nip17Rumor,
  account: Nip17Account,
  options: {
    newWrapKey: () => K | Promise<K>;
    signWrap: (template: Nip17EventTemplate, key: K) => Promise<Nip17SignedEvent>;
    timestamp: () => number;
  },
): Promise<Array<{ recipient: string; wrap: Nip17SignedEvent }>> {
  const wraps: Array<{ recipient: string; wrap: Nip17SignedEvent }> = [];
  for (const recipient of nip17WrapRecipients(rumor)) {
    const seal = await sealNip17Rumor(rumor, recipient, account, options.timestamp());
    const key = await options.newWrapKey();
    const template = await wrapNip17Seal(seal, recipient, key, options.timestamp());
    wraps.push({ recipient, wrap: await options.signWrap(template, key) });
  }
  return wraps;
}
