import Foundation
import TaskifyCore
import WidgetKit

/// Reads the app's store from the shared App Group container and turns it into widget data.
///
/// The widget is a separate process and never writes here directly except through
/// `CompleteTaskIntent`, which goes through the same `JSONTaskStore` the app uses so the two can't
/// disagree about the file's shape.
enum TaskifyWidgetStore {
    static func loadSnapshot() async -> TaskifySnapshot? {
        guard TaskifySharedContainer.isAvailable() else { return nil }
        return try? await JSONTaskStore().load()
    }

    /// Returns empty data rather than failing when the App Group isn't reachable or the store
    /// can't be read: a widget has nowhere to report an error, so the honest thing it can show is
    /// nothing.
    static func load(now: Date = Date()) async -> TaskifyWidgetData {
        guard let snapshot = await loadSnapshot() else {
            return TaskifyWidgetData(generatedAt: now)
        }
        return snapshot.widgetData(now: now)
    }

    /// Widgets refresh on the system's schedule, so the timeline is rebuilt at the next boundary
    /// that could change what's shown -- the top of the hour, or midnight, whichever comes first.
    /// Midnight matters because it moves everything from "today" into "overdue".
    static func nextReloadDate(after date: Date, calendar: Calendar = .current) -> Date {
        let nextHour = calendar.date(byAdding: .hour, value: 1, to: date) ?? date.addingTimeInterval(3600)
        let topOfNextHour = calendar.dateInterval(of: .hour, for: nextHour)?.start ?? nextHour
        let midnight = calendar.startOfDay(for: calendar.date(byAdding: .day, value: 1, to: date) ?? date)
        return min(topOfNextHour, midnight)
    }
}
