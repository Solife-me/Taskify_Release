import Foundation

/// Which of two versions of a replaceable item is current (C7-3), matching taskify-core's
/// `compareEventVersions`. Relays keep, per address, the event with the latest `created_at` and,
/// at the same `created_at`, the lowest id (NIP-01). Clients use the same order, so two devices
/// that publish in the same second converge on the version relays keep.
public struct EventVersion: Codable, Hashable, Sendable {
    public var createdAt: Int
    /// The event id, when known. Unknown for versions stored before ids were kept, and for a
    /// publish stamped but not yet signed.
    public var id: String?

    public init(createdAt: Int, id: String?) {
        self.createdAt = createdAt
        self.id = id
    }

    public init(_ event: NostrEvent) {
        self.init(createdAt: event.createdAt, id: event.id)
    }

    /// Positive when `a` wins, negative when `b` wins, 0 for the same version. At the same
    /// `created_at` the lower id wins, and a known id wins over an unknown one: an unknown id may
    /// be the very same event, and taking the known copy then changes nothing.
    public static func compare(_ a: EventVersion, _ b: EventVersion) -> Int {
        if a.createdAt != b.createdAt { return a.createdAt > b.createdAt ? 1 : -1 }
        let idA = a.id.flatMap { $0.isEmpty ? nil : $0.lowercased() }
        let idB = b.id.flatMap { $0.isEmpty ? nil : $0.lowercased() }
        if idA == idB { return 0 }
        guard let idA else { return -1 }
        guard let idB else { return 1 }
        return idA < idB ? 1 : -1
    }

    /// The `created_at` for a new version: now, but always after the newest version known (taskify-core
    /// `nextEventCreatedAt`). Otherwise two changes in the same second, or a clock that is behind,
    /// would publish a version relays may keep the older of.
    public static func nextCreatedAt(now: Int, previous: Int?) -> Int {
        guard let previous else { return now }
        return max(now, previous + 1)
    }

    /// Whether this version wins over `other`.
    public func wins(over other: EventVersion) -> Bool {
        Self.compare(self, other) > 0
    }
}
