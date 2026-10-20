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
