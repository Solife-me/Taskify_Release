import Foundation

/// A date-only wire value is a calendar day in the device's zone, not midnight UTC.
public enum VoiceTaskDate {
    public static func hasExplicitTime(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.contains("T") && parse(value) != nil
    }

    public static func parse(_ value: String, timeZone: TimeZone = .current) -> Date? {
        if value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil {
            let parts = value.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
            guard let date = calendar.date(from: components),
                  calendar.dateComponents([.year, .month, .day], from: date) == components else { return nil }
            return date
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

public extension TaskifyWatchVoiceDraft {
    /// One placement model for the Watch approval row and independent task creation.
    func taskPreview(board: TaskifyWatchBoard, now: Date = Date(), calendar: Calendar = .current) -> TaskifyWatchTask {
        let parsed = dueISO.flatMap { VoiceTaskDate.parse($0, timeZone: calendar.timeZone) }
        let date = board.kind == "week" ? (parsed ?? now) : parsed
        let weekday = calendar.component(.weekday, from: date ?? now) - 1
        let weekdayIDs = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        let column = board.kind == "week" ? weekdayIDs[weekday]
            : (board.columns ?? []).first(where: { $0.id == columnId })?.id ?? board.defaultColumnID
        return TaskifyWatchTask(
            id: id, title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            boardID: board.id, boardName: board.name,
            columnName: board.kind == "week" ? weekdayNames[weekday] : nil,
            dueDate: date, dueTimeEnabled: VoiceTaskDate.hasExplicitTime(dueISO),
            priority: priority, order: 0, columnID: column
        )
    }
}
