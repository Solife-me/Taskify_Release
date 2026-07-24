import Foundation
import TaskifyCore

/// A single completed-book marker, ported from the PWA's `BibleTrackerCompletedBooks`.
struct BibleTrackerCompletedBook: Codable, Equatable {
    var completedAtISO: String
}

/// A progress snapshot captured on reset, ported from the PWA's `BibleTrackerArchiveEntry`.
struct BibleTrackerArchiveEntry: Codable, Equatable, Identifiable {
    var id: String
    var savedAtISO: String
    var lastResetISO: String
    /// bookID -> chapters read
    var progress: [String: [Int]]
    /// bookID -> chapter (as string, matching JSON's stringified numeric keys) -> verses read
    var verses: [String: [String: [Int]]]
    /// bookID -> chapter -> verse count recorded at selection time
    var verseCounts: [String: [String: Int]]
    var completedBooks: [String: BibleTrackerCompletedBook]
}

/// Local-only Bible reading progress state, ported from the PWA's `BibleTrackerState`
/// (`components/BibleTracker.tsx`). Unlike boards/tasks, this never syncs via Nostr.
struct BibleTrackerState: Codable, Equatable {
    var lastResetISO: String
    var progress: [String: [Int]] = [:]
    var archive: [BibleTrackerArchiveEntry] = []
    var verses: [String: [String: [Int]]] = [:]
    var verseCounts: [String: [String: Int]] = [:]
    var completedBooks: [String: BibleTrackerCompletedBook] = [:]

    static func initial(now: Date = Date()) -> BibleTrackerState {
        BibleTrackerState(lastResetISO: ISO8601DateFormatter().string(from: now))
    }
}

/// Persists and mutates `BibleTrackerState` locally (UserDefaults), matching the PWA's
/// `useBibleTracker()` hook which stores the same shape under a single local kvStorage key.
@MainActor
final class BibleTrackerStore: ObservableObject {
    @Published private(set) var state: BibleTrackerState {
        didSet { persist() }
    }

    private let defaults: UserDefaults
    private static let storageKey = "taskify.bible.tracker.state.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode(BibleTrackerState.self, from: data) {
            state = decoded
        } else {
            state = .initial()
        }
    }

    static func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    var totalChaptersRead: Int {
        state.progress.values.reduce(0) { $0 + $1.count }
    }

    func chaptersRead(bookID: String) -> Set<Int> {
        Set(state.progress[bookID] ?? [])
    }

    func isBookCompleted(_ bookID: String) -> Bool {
        state.completedBooks[bookID] != nil
    }

    func completedAt(_ bookID: String) -> Date? {
        guard let iso = state.completedBooks[bookID]?.completedAtISO else { return nil }
        return ISO8601DateFormatter().date(from: iso)
    }

    func verses(bookID: String, chapter: Int) -> Set<Int> {
        Set(state.verses[bookID]?[String(chapter)] ?? [])
    }

    func verseCount(bookID: String, chapter: Int) -> Int? {
        state.verseCounts[bookID]?[String(chapter)]
    }

    /// Toggles a chapter read/unread. Clears any partial verse selection for that chapter,
    /// and un-completes the book if it drops below full completion — matches
    /// `handleToggleBibleChapter` in the PWA exactly.
    func toggleChapter(bookID: String, chapter: Int) {
        var chapters = Set(state.progress[bookID] ?? [])
        if chapters.contains(chapter) {
            chapters.remove(chapter)
        } else {
            chapters.insert(chapter)
        }

        if chapters.isEmpty {
            state.progress.removeValue(forKey: bookID)
        } else {
            state.progress[bookID] = chapters.sorted()
        }

        if state.verses[bookID]?[String(chapter)] != nil {
            state.verses[bookID]?.removeValue(forKey: String(chapter))
            if state.verses[bookID]?.isEmpty == true {
                state.verses.removeValue(forKey: bookID)
            }
        }

        if let totalChapters = BibleCatalog.book(withID: bookID)?.chapterCount,
           chapters.count < totalChapters {
            state.completedBooks.removeValue(forKey: bookID)
        }
    }

    /// Records a partial verse selection for a chapter (does not mark the chapter fully read).
    func setVerses(bookID: String, chapter: Int, verses: Set<Int>) {
        let chapterLimit = min(
            max(BibleCatalog.book(withID: bookID)?.verseCount(forChapter: chapter) ?? BibleCatalog.maxVersesInAnyChapter, 1),
            BibleCatalog.maxVersesInAnyChapter
        )
        let filtered = verses.filter { $0 > 0 && $0 <= chapterLimit }
        let key = String(chapter)

        if filtered.isEmpty {
            state.verses[bookID]?.removeValue(forKey: key)
            if state.verses[bookID]?.isEmpty == true {
                state.verses.removeValue(forKey: bookID)
            }
            state.verseCounts[bookID]?.removeValue(forKey: key)
            if state.verseCounts[bookID]?.isEmpty == true {
                state.verseCounts.removeValue(forKey: bookID)
            }
        } else {
            state.verses[bookID, default: [:]][key] = filtered.sorted()
            state.verseCounts[bookID, default: [:]][key] = chapterLimit
        }
    }

    /// Marks a book complete, moving it out of the active reading list. Only succeeds when every
    /// chapter is read and the book isn't already completed — matches `handleCompleteBibleBook`.
    @discardableResult
    func completeBook(bookID: String) -> Bool {
        guard let totalChapters = BibleCatalog.book(withID: bookID)?.chapterCount, totalChapters > 0,
              (state.progress[bookID] ?? []).count >= totalChapters,
              state.completedBooks[bookID] == nil else { return false }
        state.completedBooks[bookID] = BibleTrackerCompletedBook(completedAtISO: Self.isoString(Date()))
        return true
    }

    /// Moves a completed book back to the active reading list, keeping its chapter progress intact.
    func restoreCompletedBook(bookID: String) {
        state.completedBooks.removeValue(forKey: bookID)
    }

    /// Archives the current progress and clears the active tracker — matches `handleResetBibleTracker`.
    func resetProgress() {
        let entry = BibleTrackerArchiveEntry(
            id: UUID().uuidString,
            savedAtISO: Self.isoString(Date()),
            lastResetISO: state.lastResetISO,
            progress: state.progress,
            verses: state.verses,
            verseCounts: state.verseCounts,
            completedBooks: state.completedBooks
        )
        state.archive.insert(entry, at: 0)
        state.lastResetISO = Self.isoString(Date())
        state.progress = [:]
        state.verses = [:]
        state.verseCounts = [:]
        state.completedBooks = [:]
    }

    func deleteArchiveEntry(_ id: String) {
        state.archive.removeAll { $0.id == id }
    }

    /// Replaces the active state with an archived snapshot — matches `handleRestoreBibleArchive`.
    func restoreArchiveEntry(_ id: String) {
        guard let entry = state.archive.first(where: { $0.id == id }) else { return }
        state.lastResetISO = entry.lastResetISO
        state.progress = entry.progress
        state.verses = entry.verses
        state.verseCounts = entry.verseCounts
        state.completedBooks = entry.completedBooks
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}
