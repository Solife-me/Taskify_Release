export function normalizeNip05(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return null;
    const atIndex = trimmed.indexOf("@");
    if (atIndex <= 0 || atIndex === trimmed.length - 1)
        return null;
    const name = trimmed.slice(0, atIndex).trim().toLowerCase();
    const domain = trimmed.slice(atIndex + 1).trim().toLowerCase();
    if (!name || !domain)
        return null;
    return `${name}@${domain}`;
}
export function compressedToRawHex(value) {
    if (typeof value !== "string")
        return value;
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(value))
        return value.slice(-64);
    if (/^0x[0-9a-fA-F]{64}$/.test(value))
        return value.slice(-64);
    if (/^[0-9a-fA-F]{64}$/.test(value))
        return value.toLowerCase();
    return value;
}
export function normalizeNostrPubkeyHex(value) {
    const trimmed = (value || "").trim().toLowerCase();
    if (!trimmed)
        return null;
    const raw = compressedToRawHex(trimmed).toLowerCase();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}
export function contactVerifiedNip05(contact, cache) {
    if (!contact?.id)
        return null;
    const nip05 = contact.nip05?.trim();
    const npub = contact.npub?.trim();
    if (!nip05 || !npub)
        return null;
    const normalizedNip05 = normalizeNip05(nip05);
    const contactHex = normalizeNostrPubkeyHex(npub);
    if (!normalizedNip05 || !contactHex)
        return null;
    const entry = cache[contact.id];
    if (!entry || entry.status !== "valid")
        return null;
    const cachedNip05 = normalizeNip05(entry.nip05);
    const cachedHex = normalizeNostrPubkeyHex(entry.npub);
    if (!cachedNip05 || cachedNip05 !== normalizedNip05)
        return null;
    if (!cachedHex || cachedHex !== contactHex)
        return null;
    return nip05 || entry.nip05;
}
const GRAPHEME_SEGMENTER = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const STARTS_WITH_EMOJI = /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
/** User-perceived characters, so a family emoji or a flag stays one glyph. */
function graphemes(value) {
    if (GRAPHEME_SEGMENTER)
        return Array.from(GRAPHEME_SEGMENTER.segment(value), (part) => part.segment);
    return [...value];
}
/** Avatar initials: a leading emoji on its own, else first and last initials (or two letters of one word). */
export function contactInitials(value) {
    const parts = (value || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0)
        return "?";
    const first = graphemes(parts[0]);
    if (STARTS_WITH_EMOJI.test(parts[0]))
        return first[0] ?? "?";
    if (parts.length === 1)
        return first.slice(0, 2).join("").toUpperCase();
    return `${first[0] ?? ""}${graphemes(parts[parts.length - 1])[0] ?? ""}`.toUpperCase();
}
