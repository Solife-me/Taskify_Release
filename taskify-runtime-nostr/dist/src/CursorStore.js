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
    return { kinds, authors, tagKeys };
}
export class CursorStore {
    lastSeen = new Map();
    keyForParts(parts) {
        const kinds = parts.kinds?.length ? parts.kinds.join(",") : "*";
        const authors = parts.authors?.length ? parts.authors.join(",") : "*";
        const tags = parts.tagKeys.map((entry) => `${entry.key}:${entry.values.join(",")}`).join("|");
        return `k:${kinds}|a:${authors}|t:${tags}`;
    }
    keyFor(filter) {
        return this.keyForParts(extractKeyParts(filter));
    }
    getSince(filter) {
        return this.lastSeen.get(this.keyFor(filter));
    }
    update(filter, createdAt) {
        if (!createdAt || !Number.isFinite(createdAt))
            return;
        const key = this.keyFor(filter);
        const prev = this.lastSeen.get(key) || 0;
        if (createdAt > prev)
            this.lastSeen.set(key, createdAt);
    }
    updateMany(filters, createdAt) {
        filters.forEach((filter) => this.update(filter, createdAt));
    }
}
