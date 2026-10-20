/**
 * Which of two versions of a replaceable item is current (C7-3). Relays keep, per address, the
 * event with the latest `created_at` and, at the same `created_at`, the lowest id (NIP-01).
 * Clients use the same order, so two devices that publish in the same second converge on the
 * version relays keep instead of each keeping its own.
 */
export type EventVersion = {
    createdAt: number;
    /** The event id, when known. Unknown for versions stored before ids were kept, and for a
     * publish reserved but not yet signed. */
    id?: string | null;
};
/**
 * Positive when `a` wins, negative when `b` wins, 0 for the same version. At the same
 * `created_at` the lower id wins, and a known id wins over an unknown one: an unknown id may be
 * the very same event, and taking the known copy then changes nothing.
 */
export declare function compareEventVersions(a: EventVersion, b: EventVersion): number;
/** The winning version of the two (`a` when they are the same). */
export declare function latestEventVersion(a: EventVersion, b: EventVersion): EventVersion;
