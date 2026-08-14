import Foundation

/// A memorized (or memorizing) passage, ported from the PWA's `ScriptureMemoryEntry`
/// (`domains/scripture/scriptureTypes.ts`).
public struct ScriptureMemoryEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var bookID: String
    public var chapter: Int
    public var startVerse: Int?
    public var endVerse: Int?
    public var addedAtISO: String
    public var lastReviewISO: String?
    public var scheduledAtISO: String?
    public var stage: Int
    public var totalReviews: Int

    public init(
        id: String = UUID().uuidString,
        bookID: String,
        chapter: Int,
        startVerse: Int?,
        endVerse: Int?,
        addedAtISO: String,
        lastReviewISO: String? = nil,
        scheduledAtISO: String? = nil,
        stage: Int = 0,
        totalReviews: Int = 0
    ) {
        self.id = id
        self.bookID = bookID
        self.chapter = chapter
        self.startVerse = startVerse
        self.endVerse = endVerse
        self.addedAtISO = addedAtISO
        self.lastReviewISO = lastReviewISO
        self.scheduledAtISO = scheduledAtISO
        self.stage = stage
        self.totalReviews = totalReviews
    }
}

public struct ScriptureMemoryState: Codable, Equatable, Sendable {
    public var entries: [ScriptureMemoryEntry]
    public var lastReviewISO: String?

    public init(entries: [ScriptureMemoryEntry] = [], lastReviewISO: String? = nil) {
        self.entries = entries
        self.lastReviewISO = lastReviewISO
    }
}

/// How often a review task is scheduled, ported from `SCRIPTURE_MEMORY_FREQUENCIES`.
public enum ScriptureMemoryFrequency: String, Codable, CaseIterable, Sendable {
    case daily
    case every2d
    case twiceWeek
    case weekly

    public var days: Int {
        switch self {
        case .daily: 1
        case .every2d: 2
        case .twiceWeek: 3
        case .weekly: 7
        }
    }

    public var label: String {
        switch self {
        case .daily: "Daily"
        case .every2d: "Every 2 days"
        case .twiceWeek: "Twice per week"
        case .weekly: "Weekly"
        }
    }
}

/// How the review list is ordered, ported from the PWA's `ScriptureMemorySort` /
/// `SCRIPTURE_MEMORY_SORTS`.
public enum ScriptureMemorySort: String, Codable, CaseIterable, Sendable {
    case canonical
    case oldest
    case newest
    case needsReview

    public var label: String {
        switch self {
        case .canonical: "Canonical order"
        case .oldest: "Oldest added"
        case .newest: "Newest added"
        case .needsReview: "Needs review"
        }
    }
}

/// Spaced-repetition scoring, ported from `domains/scripture/scriptureUtils.ts`. The interval
/// between reviews grows exponentially with `stage` (capped at 180 days) and shrinks as more
/// entries compete for review slots.
public enum ScriptureMemoryAlgorithm {
    /// Shared with the PWA's `SCRIPTURE_MEMORY_SERIES_ID`. Older native builds used
    /// `scripture-memory-series`; callers should recognize that value while migrating tasks.
    public static let seriesID = "scripture-memory"
    public static let legacySeriesID = "scripture-memory-series"
    public static let maxStage = 8
    public static let stageGrowth = 1.8
    public static let intervalCapDays: Double = 180

    public struct Stats {
        public let intervalDays: Double
        public let daysSinceReview: Double
        public let score: Double
        public let dueInDays: Double
        public let dueNow: Bool
    }

    public static func recurrence(for frequency: ScriptureMemoryFrequency) -> TaskRecurrence {
        frequency.days == 1
            ? .daily()
            : .every(frequency.days, .day)
    }

    public static func isSeriesID(_ value: String?) -> Bool {
        value == seriesID || value == legacySeriesID
    }

    public static func intervalDays(stage: Int, baseDays: Double, totalEntries: Int) -> Double {
        let entryCountFactor = max(1.0, log2(Double(totalEntries) + 1))
        let normalizedBase = max(0.5, baseDays / entryCountFactor)
        let stageFactor = pow(stageGrowth, Double(max(0, stage)))
        return min(normalizedBase * stageFactor, intervalCapDays)
    }

    public static func stats(
        for entry: ScriptureMemoryEntry,
        baseDays: Double,
        totalEntries: Int,
        now: Date
    ) -> Stats {
        let interval = intervalDays(stage: entry.stage, baseDays: baseDays, totalEntries: totalEntries)
        let lastReview = entry.lastReviewISO.flatMap { ISO8601DateFormatter().date(from: $0) }
        var daysSinceReview = lastReview.map { now.timeIntervalSince($0) / 86400 } ?? .infinity
        if !daysSinceReview.isFinite { daysSinceReview = .infinity }
        let score = lastReview == nil ? Double.infinity : daysSinceReview / max(interval, 0.5)
        let dueInDays = lastReview == nil ? 0 : interval - daysSinceReview
        let dueNow = lastReview == nil || daysSinceReview >= interval * 0.95
        return Stats(intervalDays: interval, daysSinceReview: daysSinceReview, score: score, dueInDays: dueInDays, dueNow: dueNow)
    }

    /// Picks the entry most overdue for review (never-reviewed entries win immediately),
    /// matching `chooseNextScriptureEntry`.
    public static func chooseNext(
        entries: [ScriptureMemoryEntry],
        baseDays: Double,
        now: Date
    ) -> (entry: ScriptureMemoryEntry, stats: Stats)? {
        guard !entries.isEmpty else { return nil }
        var best: (entry: ScriptureMemoryEntry, stats: Stats)?
        for entry in entries {
            let entryStats = stats(for: entry, baseDays: baseDays, totalEntries: entries.count, now: now)
            if entry.lastReviewISO == nil {
                return (entry, entryStats)
            }
            if best == nil || entryStats.score > best!.stats.score {
                best = (entry, entryStats)
            }
        }
        return best
    }

    /// Orders entries per the user's chosen sort, matching `scriptureMemoryItems`'s `decorated.sort`
    /// switch (including its tie-breakers) in the PWA.
    public static func sortedEntries(
        _ entries: [ScriptureMemoryEntry],
        sort: ScriptureMemorySort,
        baseDays: Double,
        now: Date
    ) -> [(entry: ScriptureMemoryEntry, stats: Stats)] {
        let total = entries.count
        let decorated = entries.map { ($0, stats(for: $0, baseDays: baseDays, totalEntries: total, now: now)) }
        switch sort {
        case .canonical:
            return decorated.sorted { lhs, rhs in
                let orderA = BibleCatalog.books.firstIndex { $0.id == lhs.0.bookID } ?? 0
                let orderB = BibleCatalog.books.firstIndex { $0.id == rhs.0.bookID } ?? 0
                if orderA != orderB { return orderA < orderB }
                if lhs.0.chapter != rhs.0.chapter { return lhs.0.chapter < rhs.0.chapter }
                let startA = lhs.0.startVerse ?? 0
                let startB = rhs.0.startVerse ?? 0
                if startA != startB { return startA < startB }
                return (lhs.0.endVerse ?? 0) < (rhs.0.endVerse ?? 0)
            }
        case .oldest:
            return decorated.sorted {
                addedAtTime($0.0) < addedAtTime($1.0)
            }
        case .newest:
            return decorated.sorted {
                addedAtTime($0.0) > addedAtTime($1.0)
            }
        case .needsReview:
            return decorated.sorted { lhs, rhs in
                if lhs.1.score == rhs.1.score { return lhs.1.dueInDays < rhs.1.dueInDays }
                return lhs.1.score > rhs.1.score
            }
        }
    }

    private static func addedAtTime(_ entry: ScriptureMemoryEntry) -> TimeInterval {
        ISO8601DateFormatter().date(from: entry.addedAtISO)?.timeIntervalSince1970 ?? 0
    }

    public static func formatDueInLabel(_ dueInDays: Double) -> String {
        guard dueInDays.isFinite else { return "Due now" }
        if abs(dueInDays) < 0.5 { return "Due now" }
        let rounded = dueInDays.rounded()
        if rounded == 0 { return "Due now" }
        let magnitude = Int(abs(rounded))
        let unit = magnitude == 1 ? "day" : "days"
        return rounded > 0 ? "Due in \(magnitude) \(unit)" : "Overdue by \(magnitude) \(unit)"
    }

    /// e.g. "Genesis 1:1-3" or "Genesis 1", matching `formatScriptureReference`.
    public static func reference(for entry: ScriptureMemoryEntry) -> String {
        guard let book = BibleCatalog.book(withID: entry.bookID) else { return entry.bookID }
        if let start = entry.startVerse, let end = entry.endVerse, start != end {
            return "\(book.name) \(entry.chapter):\(start)-\(end)"
        }
        if let start = entry.startVerse {
            return "\(book.name) \(entry.chapter):\(start)"
        }
        return "\(book.name) \(entry.chapter)"
    }
}
