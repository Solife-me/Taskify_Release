import { normalizeNostrPubkeyHex } from "./contactContracts.js";
import { b64decode } from "./nostrPrimitives.js";
export function isValidEventKey(value) {
    if (typeof value !== "string" || !value.trim())
        return false;
    try {
        return b64decode(value.trim()).length === 32;
    }
    catch {
        return false;
    }
}
export function planEventInvitations(input, generators) {
    const normalize = generators.normalizePubkey ?? ((value) => normalizeNostrPubkeyHex(value));
    const sender = input.senderPubkey ? normalize(input.senderPubkey) : null;
    const inviteePubkeys = [];
    for (const candidate of input.participantPubkeys) {
        const pubkey = normalize(candidate);
        if (!pubkey || pubkey === sender || inviteePubkeys.includes(pubkey))
            continue;
        inviteePubkeys.push(pubkey);
    }
    // Two spellings of one key normalize to the same key. Object order isn't portable, so the token
    // stored under the canonical spelling wins, then the smallest token.
    const existing = new Map();
    for (const [key, token] of Object.entries(input.inviteTokens ?? {})) {
        const pubkey = normalize(key);
        const trimmed = typeof token === "string" ? token.trim() : "";
        if (!pubkey || !trimmed)
            continue;
        const candidate = { token: trimmed, canonical: key === pubkey };
        const current = existing.get(pubkey);
        if (!current
            || (candidate.canonical && !current.canonical)
            || (candidate.canonical === current.canonical && candidate.token < current.token)) {
            existing.set(pubkey, candidate);
        }
    }
    const inviteTokens = {};
    for (const pubkey of inviteePubkeys)
        inviteTokens[pubkey] = existing.get(pubkey)?.token ?? generators.inviteToken();
    const eventKey = isValidEventKey(input.eventKey) ? input.eventKey.trim() : generators.eventKey();
    const previous = new Set((input.previousPubkeys ?? []).map((value) => normalize(value)).filter(Boolean));
    const before = input.inviteTokens ?? {};
    const changed = eventKey !== input.eventKey ||
        Object.keys(before).length !== inviteePubkeys.length ||
        inviteePubkeys.some((pubkey) => before[pubkey] !== inviteTokens[pubkey]);
    return {
        eventKey,
        inviteTokens: inviteePubkeys.length ? inviteTokens : undefined,
        inviteePubkeys,
        addedPubkeys: inviteePubkeys.filter((pubkey) => !previous.has(pubkey)),
        changed,
    };
}
