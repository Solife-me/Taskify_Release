function normalizedId(id) {
    return typeof id === "string" && id ? id.toLowerCase() : null;
}
/**
 * Positive when `a` wins, negative when `b` wins, 0 for the same version. At the same
 * `created_at` the lower id wins, and a known id wins over an unknown one: an unknown id may be
 * the very same event, and taking the known copy then changes nothing.
 */
export function compareEventVersions(a, b) {
    if (a.createdAt !== b.createdAt)
        return a.createdAt > b.createdAt ? 1 : -1;
    const idA = normalizedId(a.id);
    const idB = normalizedId(b.id);
    if (idA === idB)
        return 0;
    if (idA === null)
        return -1;
    if (idB === null)
        return 1;
    return idA < idB ? 1 : -1;
}
/** The winning version of the two (`a` when they are the same). */
export function latestEventVersion(a, b) {
    return compareEventVersions(a, b) >= 0 ? a : b;
}
/**
 * The `created_at` for a new version of a replaceable item: now, but always after the newest
 * version this client knows (its own last publish or one it received). Otherwise two changes in
 * the same second, or a device whose clock is behind, would publish a version relays may keep the
 * older of (fixtures/event-version-vectors.json, `nextCreatedAt`).
 */
export function nextEventCreatedAt(nowSeconds, previousCreatedAt) {
    const now = Number.isFinite(nowSeconds) ? Math.floor(nowSeconds) : 0;
    if (typeof previousCreatedAt !== "number" || !Number.isFinite(previousCreatedAt))
        return now;
    return Math.max(now, Math.floor(previousCreatedAt) + 1);
}
