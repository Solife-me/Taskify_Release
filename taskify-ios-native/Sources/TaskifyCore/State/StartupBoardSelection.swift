import Foundation

/// Resolves the board Taskify should open at launch using the same Sunday-based weekday keys as
/// the PWA's `startBoardByDay` setting (`0 = Sunday ... 6 = Saturday`).
public enum StartupBoardSelection {
    public static func boardID(
        boards: [Board],
        preferredBoardIDsByWeekday: [Int: String],
        date: Date = Date(),
        calendar: Calendar = .current
    ) -> String? {
        let visibleBoards = boards.filter(\.isVisible)
        guard !visibleBoards.isEmpty else { return nil }

        let weekday = calendar.component(.weekday, from: date) - 1
        if let preferredID = preferredBoardIDsByWeekday[weekday],
           visibleBoards.contains(where: { $0.id == preferredID }) {
            return preferredID
        }
        return visibleBoards.first?.id
    }

    /// Removes malformed weekday keys and references to boards that can no longer be opened.
    /// Keeping this cleanup beside resolution prevents an archived/deleted board from leaving a
    /// Picker with an invalid selection or becoming a dead startup destination.
    public static func sanitizedPreferences(
        _ preferences: [Int: String],
        boards: [Board]
    ) -> [Int: String] {
        let visibleBoardIDs = Set(boards.lazy.filter(\.isVisible).map(\.id))
        return preferences.reduce(into: [:]) { result, entry in
            guard (0...6).contains(entry.key),
                  !entry.value.isEmpty,
                  visibleBoardIDs.contains(entry.value) else {
                return
            }
            result[entry.key] = entry.value
        }
    }
}
