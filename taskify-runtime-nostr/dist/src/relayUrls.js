export function normalizeRelayUrls(relays) {
    const set = new Set(relays
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter(Boolean));
    return Array.from(set).sort();
}
