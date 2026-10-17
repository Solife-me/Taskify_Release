import type { NDKEvent, NDKSigner } from "@nostr-dev-kit/ndk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getEventHash, getPublicKey, type EventTemplate } from "nostr-tools";

export class NostrProofOfWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NostrProofOfWorkError";
  }
}

/**
 * Builds a hasher for one mining run. The serialized event is split around the nonce, so the
 * prefix is hashed once and each attempt only hashes the nonce and the rest of the event.
 * Platforms with a native SHA-256 (Node's `crypto`) can supply a faster factory.
 */
export type ProofOfWorkHashFactory = (prefix: string, suffix: string) => (nonce: string) => Uint8Array;

export type ProofOfWorkOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  hashFactory?: ProofOfWorkHashFactory;
};

/** NIP-13 difficulties above this would take hours on a client; relays asking for more are refused. */
export const MAX_PROOF_OF_WORK_DIFFICULTY = 32;

const DEFAULT_TIMEOUT_MS = 30_000;

export function countLeadingZeroBits(hex: string): number {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return 0;
  let count = 0;
  for (const character of hex) {
    const value = Number.parseInt(character, 16);
    if (value === 0) { count += 4; continue; }
    return count + Math.clz32(value) - 28;
  }
  return count;
}

function countLeadingZeroBitsOfBytes(bytes: Uint8Array): number {
  let count = 0;
  for (const value of bytes) {
    if (value === 0) { count += 8; continue; }
    return count + Math.clz32(value) - 24;
  }
  return count;
}

/** The difficulty an event's nonce tag commits to (NIP-13), or 0 without one. */
export function committedProofOfWorkDifficulty(tags: string[][]): number {
  const target = Number(tags.find(tag => tag[0] === "nonce")?.[2]);
  return Number.isInteger(target) && target > 0 ? target : 0;
}

/**
 * Reads the difficulty a relay asked for from its `OK false "pow: …"` message, e.g. khatru's
 * "pow: difficulty 8 is less than 20". Returns null when the message names no target.
 */
export function parseProofOfWorkRejection(message: string | null | undefined): number | null {
  const text = (message || "").trim().toLowerCase();
  if (!text.startsWith("pow:")) return null;
  const numbers = (text.match(/\d+/g) || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!numbers.length) return null;
  return Math.max(...numbers);
}

const defaultHashFactory: ProofOfWorkHashFactory = (prefix, suffix) => {
  const encoder = new TextEncoder();
  const head = sha256.create().update(encoder.encode(prefix));
  const tail = encoder.encode(suffix);
  return nonce => head.clone().update(encoder.encode(nonce)).update(tail).digest();
};

function placeholderToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `pow${bytesToHex(bytes)}`;
}

async function mine(
  template: EventTemplate,
  pubkey: string,
  difficulty: number,
  options: ProofOfWorkOptions = {},
): Promise<EventTemplate> {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_PROOF_OF_WORK_DIFFICULTY) {
    throw new NostrProofOfWorkError("Unsupported relay proof-of-work difficulty.");
  }
  if (options.signal?.aborted) throw new NostrProofOfWorkError("Proof-of-work mining aborted.");
  if (difficulty === 0) return template;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const baseTags = template.tags.filter(t => t[0] !== "nonce");

  // Serialize exactly as NIP-01 hashes the event, with a unique token where the nonce goes.
  let token = placeholderToken();
  let serialized = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    serialized = JSON.stringify([0, pubkey, template.created_at, template.kind, [...baseTags, ["nonce", token, String(difficulty)]], template.content]);
    if (serialized.indexOf(token) === serialized.lastIndexOf(token)) break;
    token = placeholderToken();
  }
  const split = serialized.indexOf(token);
  if (split < 0 || serialized.indexOf(token, split + 1) >= 0) throw new NostrProofOfWorkError("Could not prepare the event for mining.");
  const hashNonce = (options.hashFactory ?? defaultHashFactory)(serialized.slice(0, split), serialized.slice(split + token.length));

  let nonce = 0;
  while (true) {
    // Yield before each short slice so timers, cancellation and UI remain responsive.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (options.signal?.aborted) throw new NostrProofOfWorkError("Proof-of-work mining aborted.");
    if (Date.now() >= deadline) {
      throw new NostrProofOfWorkError(`Proof-of-work mining timed out before reaching difficulty ${difficulty}.`);
    }
    const sliceEnd = Math.min(deadline, Date.now() + 8);
    do {
      // Check the clock every few hundred attempts rather than on each hash.
      for (let i = 0; i < 256; i += 1) {
        const candidate = String(nonce++);
        if (countLeadingZeroBitsOfBytes(hashNonce(candidate)) >= difficulty) {
          const tags = [...baseTags, ["nonce", candidate, String(difficulty)]];
          // Guard against any divergence between the split serialization and NIP-01's.
          if (countLeadingZeroBits(getEventHash({ ...template, tags, pubkey })) < difficulty) {
            throw new NostrProofOfWorkError("Mined event hash did not verify.");
          }
          return { ...template, tags };
        }
      }
    } while (Date.now() < sliceEnd && nonce < Number.MAX_SAFE_INTEGER);
    if (nonce >= Number.MAX_SAFE_INTEGER) throw new NostrProofOfWorkError("Proof-of-work nonce space exhausted.");
  }
}

/** Mine before finalizeEvent, and before retaining any references to the event ID. */
export async function mineEventTemplate(
  template: EventTemplate,
  secretKey: Uint8Array,
  difficulty: number,
  options?: ProofOfWorkOptions,
): Promise<EventTemplate> {
  return mine(template, getPublicKey(secretKey), difficulty, options);
}

/** Mines for a public key whose secret is held elsewhere (an extension or a remote signer). */
export async function mineEventTemplateFor(
  template: EventTemplate,
  pubkey: string,
  difficulty: number,
  options?: ProofOfWorkOptions,
): Promise<EventTemplate> {
  return mine(template, pubkey, difficulty, options);
}

/** Signed events are immutable: callers must prepare proof of work before signing. */
export async function applyProofOfWork(event: NDKEvent, signer: NDKSigner | undefined, difficulty: number, options?: ProofOfWorkOptions): Promise<void> {
  if (difficulty === 0) return;
  if (event.sig) {
    const commitment = committedProofOfWorkDifficulty(event.tags);
    if (event.id === getEventHash(event.rawEvent()) && countLeadingZeroBits(event.id) >= difficulty && commitment >= difficulty) return;
    throw new NostrProofOfWorkError("Cannot add proof of work to an already-signed event; mine before signing to preserve its ID.");
  }
  if (!signer) throw new NostrProofOfWorkError("A signer is required to prepare proof of work.");
  event.pubkey = (await signer.user()).pubkey;
  const raw = await event.toNostrEvent();
  if (raw.kind === undefined || raw.created_at === undefined) throw new NostrProofOfWorkError("Event metadata is missing.");
  const mined = await mine({ ...raw, kind: raw.kind, created_at: raw.created_at }, event.pubkey, difficulty, options);
  event.tags = mined.tags;
  event.id = getEventHash({ ...mined, pubkey: event.pubkey });
  event.sig = await signer.sign({ ...mined, pubkey: event.pubkey, id: event.id });
}
