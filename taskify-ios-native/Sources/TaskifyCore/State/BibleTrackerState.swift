import Foundation

/// A single completed-book marker, ported from the PWA's `BibleTrackerCompletedBooks`.
public struct BibleTrackerCompletedBook: Codable, Equatable, Sendable {
    public var completedAtISO: String

    public init(completedAtISO: String) {
        self.completedAtISO = completedAtISO
    }
}

/// A progress snapshot captured on reset, ported from the PWA's `BibleTrackerArchiveEntry`.
public struct BibleTrackerArchiveEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var savedAtISO: String
    public var lastResetISO: String
    /// bookID -> chapters read
    public var progress: [String: [Int]]
    /// bookID -> chapter (as string, matching JSON's stringified numeric keys) -> verses read
    public var verses: [String: [String: [Int]]]
    /// bookID -> chapter -> verse count recorded at selection time
    public var verseCounts: [String: [String: Int]]
    public var completedBooks: [String: BibleTrackerCompletedBook]

    public init(
        id: String,
        savedAtISO: String,
        lastResetISO: String,
        progress: [String: [Int]],
        verses: [String: [String: [Int]]],
        verseCounts: [String: [String: Int]],
        completedBooks: [String: BibleTrackerCompletedBook]
    ) {
        self.id = id
        self.savedAtISO = savedAtISO
        self.lastResetISO = lastResetISO
        self.progress = progress
        self.verses = verses
        self.verseCounts = verseCounts
        self.completedBooks = completedBooks
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        savedAtISO = try container.decodeIfPresent(String.self, forKey: .savedAtISO) ?? ""
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        lastResetISO = try container.decodeIfPresent(String.self, forKey: .lastResetISO) ?? savedAtISO
        progress = try container.decodeIfPresent([String: [Int]].self, forKey: .progress) ?? [:]
        verses = try container.decodeIfPresent([String: [String: [Int]]].self, forKey: .verses) ?? [:]
        verseCounts = try container.decodeIfPresent([String: [String: Int]].self, forKey: .verseCounts) ?? [:]
        completedBooks = try container.decodeIfPresent(
            [String: BibleTrackerCompletedBook].self,
            forKey: .completedBooks
        ) ?? [:]
    }
}

/// Bible reading progress, ported from the PWA's `BibleTrackerState` (`components/BibleTracker.tsx`).
/// The same JSON shape is synced between devices by `AppStateSyncContract`; the PWA's
/// device-only `expandedBooks` field is ignored on decode.
public struct BibleTrackerState: Codable, Equatable, Sendable {
    public var lastResetISO: String
    public var progress: [String: [Int]] = [:]
    public var archive: [BibleTrackerArchiveEntry] = []
    public var verses: [String: [String: [Int]]] = [:]
    public var verseCounts: [String: [String: Int]] = [:]
    public var completedBooks: [String: BibleTrackerCompletedBook] = [:]

    public init(
        lastResetISO: String,
        progress: [String: [Int]] = [:],
        archive: [BibleTrackerArchiveEntry] = [],
        verses: [String: [String: [Int]]] = [:],
        verseCounts: [String: [String: Int]] = [:],
        completedBooks: [String: BibleTrackerCompletedBook] = [:]
    ) {
        self.lastResetISO = lastResetISO
        self.progress = progress
        self.archive = archive
        self.verses = verses
        self.verseCounts = verseCounts
        self.completedBooks = completedBooks
    }

    public static func initial(now: Date = Date()) -> BibleTrackerState {
        BibleTrackerState(lastResetISO: ISO8601DateFormatter().string(from: now))
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        lastResetISO = try container.decodeIfPresent(String.self, forKey: .lastResetISO)
            ?? ISO8601DateFormatter().string(from: Date())
        progress = try container.decodeIfPresent([String: [Int]].self, forKey: .progress) ?? [:]
        archive = try container.decodeIfPresent([BibleTrackerArchiveEntry].self, forKey: .archive) ?? []
        verses = try container.decodeIfPresent([String: [String: [Int]]].self, forKey: .verses) ?? [:]
        verseCounts = try container.decodeIfPresent([String: [String: Int]].self, forKey: .verseCounts) ?? [:]
        completedBooks = try container.decodeIfPresent(
            [String: BibleTrackerCompletedBook].self,
            forKey: .completedBooks
        ) ?? [:]
    }
}
