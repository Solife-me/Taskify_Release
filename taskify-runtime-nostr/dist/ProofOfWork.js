import { getEventHash, getPublicKey } from "nostr-tools";
export class NostrProofOfWorkError extends Error {
    constructor(message) {
        super(message);
        this.name = "NostrProofOfWorkError";
    }
}
export function countLeadingZeroBits(hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex))
        return 0;
    let count = 0;
    for (const character of hex) {
        const value = Number.parseInt(character, 16);
        if (value === 0) {
            count += 4;
            continue;
        }
        return count + Math.clz32(value) - 28;
    }
    return count;
}
async function mine(template, pubkey, difficulty, options = {}) {
    if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 32) {
        throw new NostrProofOfWorkError("Unsupported relay proof-of-work difficulty.");
    }
    if (options.signal?.aborted)
        throw new NostrProofOfWorkError("Proof-of-work mining aborted.");
    if (difficulty === 0)
        return template;
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const nonceTag = ["nonce", "0", String(difficulty)];
    const candidate = { ...template, pubkey, tags: [...template.tags.filter(t => t[0] !== "nonce"), nonceTag] };
    let nonce = 0;
    while (true) {
        // Yield before each short slice so timers, cancellation and UI remain responsive.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (options.signal?.aborted)
            throw new NostrProofOfWorkError("Proof-of-work mining aborted.");
        if (Date.now() >= deadline)
            throw new NostrProofOfWorkError("Proof-of-work mining timed out.");
        const sliceEnd = Math.min(deadline, Date.now() + 8);
        do {
            nonceTag[1] = String(nonce++);
            if (countLeadingZeroBits(getEventHash(candidate)) >= difficulty) {
                return { ...template, tags: candidate.tags };
            }
        } while (Date.now() < sliceEnd && nonce < Number.MAX_SAFE_INTEGER);
        if (nonce >= Number.MAX_SAFE_INTEGER)
            throw new NostrProofOfWorkError("Proof-of-work nonce space exhausted.");
    }
}
/** Mine before finalizeEvent, and before retaining any references to the event ID. */
export async function mineEventTemplate(template, secretKey, difficulty, options) {
    return mine(template, getPublicKey(secretKey), difficulty, options);
}
/** Signed events are immutable: callers must prepare proof of work before signing. */
export async function applyProofOfWork(event, signer, difficulty, options) {
    if (difficulty === 0)
        return;
    if (event.sig) {
        const commitment = event.tags.find(t => t[0] === "nonce")?.[2];
        if (event.id === getEventHash(event.rawEvent()) && countLeadingZeroBits(event.id) >= difficulty && Number(commitment) >= difficulty)
            return;
        throw new NostrProofOfWorkError("Cannot add proof of work to an already-signed event; mine before signing to preserve its ID.");
    }
    if (!signer)
        throw new NostrProofOfWorkError("A signer is required to prepare proof of work.");
    event.pubkey = (await signer.user()).pubkey;
    const raw = await event.toNostrEvent();
    if (raw.kind === undefined || raw.created_at === undefined)
        throw new NostrProofOfWorkError("Event metadata is missing.");
    const mined = await mine({ ...raw, kind: raw.kind, created_at: raw.created_at }, event.pubkey, difficulty, options);
    event.tags = mined.tags;
    event.id = getEventHash({ ...mined, pubkey: event.pubkey });
    event.sig = await signer.sign({ ...mined, pubkey: event.pubkey, id: event.id });
}
