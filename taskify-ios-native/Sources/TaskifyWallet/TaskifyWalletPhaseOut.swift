import Foundation
import TaskifyCore

/// When the Taskify wallet ends, shared by every Apple client (C9-1, C9-2). Matches the PWA's
/// `WALLET_REMOVAL_DATE_ISO`: from local midnight on December 1, 2026 the full wallet is off and
/// devices that had it show a recovery view instead.
public enum TaskifyWalletPhaseOut {
    public static let removalDay = DateComponents(year: 2026, month: 12, day: 1)
    public static let removalDateText = "December 1, 2026"

    /// Local midnight starting the removal day.
    public static func removalDate(calendar: Calendar = .current) -> Date {
        calendar.date(from: removalDay) ?? .distantFuture
    }

    /// Whether the full wallet has ended at `now` (local time).
    public static func isWalletRemoved(now: Date = Date(), calendar: Calendar = .current) -> Bool {
        now >= removalDate(calendar: calendar)
    }
}
