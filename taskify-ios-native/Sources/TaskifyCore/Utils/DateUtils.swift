import Foundation

public enum DateUtils {
    public static let isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
    public static let msPerDay = 86_400_000

    public static func startOfDay(_ date: Date) -> Date {
        Calendar(identifier: .gregorian).startOfDay(for: date)
    }

    public static func normalizeTimeZone(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, TimeZone(identifier: trimmed) != nil else { return nil }
        return trimmed
    }

    public static func formatDateKeyFromParts(year: Int, month: Int, day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    public static func formatDateKeyLocal(_ date: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
        return formatDateKeyFromParts(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
    }

    public static func parseDateKey(_ value: String) -> (year: Int, month: Int, day: Int)? {
        guard value.wholeMatch(of: isoDatePattern) != nil else { return nil }
        let parts = value.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]) else { return nil }
        return (year, month, day)
    }

    public static func isoDatePart(_ iso: String, timeZone: String? = nil) -> String {
        if iso.wholeMatch(of: isoDatePattern) != nil { return iso }
        guard let date = ISO8601DateFormatter.taskify.date(from: iso) ?? ISO8601DateFormatter.taskifyFractional.date(from: iso) else {
            return formatDateKeyLocal(Date())
        }
        if let timeZone = normalizeTimeZone(timeZone) {
            return formatDateKeyInTimeZone(date, timeZone: timeZone)
        }
        return formatDateKeyLocal(date)
    }

    public static func isoTimePart(_ iso: String, timeZone: String? = nil) -> String {
        guard let date = ISO8601DateFormatter.taskify.date(from: iso) ?? ISO8601DateFormatter.taskifyFractional.date(from: iso) else {
            return ""
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        if let timeZone = normalizeTimeZone(timeZone) {
            formatter.timeZone = TimeZone(identifier: timeZone)
        }
        return formatter.string(from: date)
    }

    public static func isoTimePartUtc(_ iso: String) -> String {
        if iso.count >= 16 {
            let start = iso.index(iso.startIndex, offsetBy: 11)
            let end = iso.index(start, offsetBy: 5, limitedBy: iso.endIndex) ?? iso.endIndex
            return String(iso[start..<end])
        }
        return ""
    }

    public static func isoFromDateTime(_ dateKey: String, time: String? = nil, timeZone: String? = nil) -> String {
        guard let parsed = parseDateKey(dateKey) else { return dateKey }
        let hhmm = parseTimeValue(time ?? "00:00") ?? (0, 0)
        var components = DateComponents()
        components.calendar = Calendar(identifier: .gregorian)
        components.year = parsed.year
        components.month = parsed.month
        components.day = parsed.day
        components.hour = hhmm.hour
        components.minute = hhmm.minute
        components.second = 0
        components.timeZone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        return (components.date ?? Date()).ISO8601Format()
    }

    public static func parseTimeValue(_ value: String) -> (hour: Int, minute: Int)? {
        let parts = value.split(separator: ":")
        guard parts.count >= 2, let hour = Int(parts[0]), let minute = Int(parts[1]) else { return nil }
        return (min(max(hour, 0), 23), min(max(minute, 0), 59))
    }

    public static func formatDateKeyInTimeZone(_ date: Date, timeZone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: timeZone)
        return formatter.string(from: date)
    }
}

private extension ISO8601DateFormatter {
    static let taskify: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let taskifyFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
