import Foundation

/// Keeps long Mac conversations cheap to open while retaining the complete timeline for
/// conversation search and for loading earlier pages on demand.
public enum MacChatTimelineWindow {
    public static let initialPageSize = 100
    public static let olderPageSize = 100

    public static func visibleRange(totalCount: Int, loadedCount: Int) -> Range<Int> {
        let total = max(0, totalCount)
        guard total > 0 else { return 0..<0 }
        let loaded = min(total, max(0, loadedCount))
        return (total - loaded)..<total
    }

    public static func nextLoadedCount(current: Int, totalCount: Int) -> Int {
        let total = max(0, totalCount)
        return min(total, max(0, current) + olderPageSize)
    }

    public static func loadedCount(including index: Int, totalCount: Int, minimum: Int) -> Int {
        let total = max(0, totalCount)
        guard total > 0, index >= 0, index < total else {
            return min(total, max(0, minimum))
        }
        return min(total, max(max(0, minimum), total - index))
    }
}
