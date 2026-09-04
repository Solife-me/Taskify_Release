function normalizeStrings(values) {
    if (!Array.isArray(values))
        return [];
    const seen = new Set();
    values.forEach((v) => {
        if (typeof v === "string" && v.trim())
            seen.add(v.trim());
    });
    return Array.from(seen).sort();
}
function normalizeNumbers(values) {
    if (!Array.isArray(values))
        return [];
    const seen = new Set();
    values.forEach((v) => {
        if (typeof v === "number" && Number.isFinite(v))
            seen.add(v);
    });
    return Array.from(seen).sort((a, b) => a - b);
}
function extractKeyParts(filter) {
    const kinds = normalizeNumbers(filter.kinds);
    const authors = normalizeStrings(filter.authors);
    const tagKeys = Object.entries(filter)
        .filter(([key]) => key.startsWith("#"))
        .map(([key, value]) => ({ key, values: normalizeStrings(value) }))
        .filter((entry) => entry.values.length > 0)
        .sort((a, b) => a.key.localeCompare(b.key));
    return { kinds, authors, ids: normalizeStrings(filter.ids), tagKeys };
}
export class CursorStore {
    lastSeen = new Map();
    keyForParts(parts) {
        const kinds = parts.kinds?.length ? parts.kinds.join(",") : "*";
        const authors = parts.authors?.length ? parts.authors.join(",") : "*";
        const tags = parts.tagKeys.map((entry) => `${entry.key}:${entry.values.join(",")}`).join("|");
        return `k:${kinds}|a:${authors}|i:${parts.ids?.join(",") || "*"}|t:${tags}`;
    }
    keyFor(filter) {
        return this.keyForParts(extractKeyParts(filter));
    }
    scopedKey(filter, relayUrls = []) {
        return `${JSON.stringify([...new Set(relayUrls)].sort())}|${this.keyFor(filter)}`;
    }
    getSince(filter, relayUrls = []) {
        const newest = this.lastSeen.get(this.scopedKey(filter, relayUrls));
        if (newest === undefined)
            return undefined;
        const overlap = filter.kinds?.includes(1059) ? 2 * 24 * 60 * 60 + 60 : 60;
        return Math.max(0, Math.min(newest, Math.floor(Date.now() / 1000)) - overlap);
    }
    update(filter, createdAt, relayUrls = []) {
        if (!createdAt || !Number.isFinite(createdAt))
            return;
        const key = this.scopedKey(filter, relayUrls);
        const prev = this.lastSeen.get(key) || 0;
        if (createdAt > prev)
            this.lastSeen.set(key, createdAt);
    }
    updateMany(filters, createdAt, relayUrls = []) {
        filters.forEach((filter) => this.update(filter, createdAt, relayUrls));
    }
}
