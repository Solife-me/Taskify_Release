import Foundation

/// What someone asked Siri to remind them of: "take out the trash tomorrow at 1pm" becomes the
/// title "Take out the trash", due tomorrow at 1:00 PM.
public struct TaskifyReminderPhrase: Equatable, Sendable {
    public var title: String
    /// When to remind: the exact moment if `hasTime`, otherwise the start of the day.
    public var dueDate: Date?
    public var hasTime: Bool

    public init(title: String, dueDate: Date? = nil, hasTime: Bool = false) {
        self.title = title
        self.dueDate = dueDate
        self.hasTime = hasTime
    }

    /// The reminder a spoken request implies: at the due time, or on the day (at the task's
    /// reminder time, 9:00 AM unless changed) when no time was said. None without a date.
    public var reminderRawValues: [String] {
        guard dueDate != nil else { return [] }
        return [TaskifyReminderOffset.rawValue(minutesBefore: 0, dateOnly: !hasTime)]
    }

    /// The hour a new task with no due time is reminded at (its default `reminderTime`, 09:00).
    public static let defaultReminderHour = 9

    /// When the reminder goes off for a new task: the due time, or the default reminder hour on
    /// the day.
    public func fireDate(calendar: Calendar = .current) -> Date? {
        guard let dueDate else { return nil }
        if hasTime { return dueDate }
        return calendar.date(bySettingHour: Self.defaultReminderHour, minute: 0, second: 0, of: dueDate)
    }
}

public extension TaskifyReminderPhrase {
    /// A date picked in a Shortcuts "When" field wins over one in the text. Midnight there means
    /// a day with no time, as Siri gives for "tomorrow".
    func applying(explicitDate: Date?, calendar: Calendar = .current) -> TaskifyReminderPhrase {
        guard let explicitDate else { return self }
        let isMidnight = calendar.startOfDay(for: explicitDate) == explicitDate
        return TaskifyReminderPhrase(
            title: title,
            dueDate: isMidnight ? explicitDate : calendar.dateInterval(of: .minute, for: explicitDate)?.start,
            hasTime: !isMidnight
        )
    }

    /// What Siri says once the reminder is saved: "OK, I'll remind you to take out the trash
    /// tomorrow at 1:00 PM. It's on Home."
    static func confirmation(title: String, fireDate: Date, boardName: String, now: Date = Date()) -> String {
        // "Take out the trash" reads as "remind you to take out the trash"; "NASA form" and
        // "Bob's party" keep their capitals.
        var spokenTitle = title
        if let first = title.first, title.dropFirst().first.map({ !$0.isUppercase }) ?? true,
           !title.hasPrefix("I ") {
            spokenTitle = first.lowercased() + title.dropFirst()
        }
        return "OK, I'll remind you to \(spokenTitle) \(spokenTime(of: fireDate, now: now)). It's on \(boardName)."
    }

    /// When the reminder goes off, for Siri to say back: "today at 5:00 PM", "tomorrow at
    /// 1:00 PM", "Friday at 9:00 AM", "December 5 at 9:00 AM". `fireDate` is the moment the
    /// task's reminder fires, which for a day with no time is its reminder time.
    static func spokenTime(of fireDate: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let time = DateFormatter()
        time.calendar = calendar
        time.timeZone = calendar.timeZone
        time.timeStyle = .short
        time.dateStyle = .none
        let clock = time.string(from: fireDate)

        let today = calendar.startOfDay(for: now)
        let day = calendar.startOfDay(for: fireDate)
        let days = calendar.dateComponents([.day], from: today, to: day).day ?? 0
        let dayText: String
        switch days {
        case 0: dayText = "today"
        case 1: dayText = "tomorrow"
        case 2...6:
            let weekday = DateFormatter()
            weekday.calendar = calendar
            weekday.timeZone = calendar.timeZone
            weekday.setLocalizedDateFormatFromTemplate("EEEE")
            dayText = weekday.string(from: fireDate)
        default:
            let date = DateFormatter()
            date.calendar = calendar
            date.timeZone = calendar.timeZone
            let sameYear = calendar.component(.year, from: fireDate) == calendar.component(.year, from: now)
            date.setLocalizedDateFormatFromTemplate(sameYear ? "MMMMd" : "MMMMdyyyy")
            dayText = date.string(from: fireDate)
        }
        return "\(dayText) at \(clock)"
    }
}

/// Splits a spoken reminder request into a task title and a due date, on every Apple client.
///
/// `NSDataDetector` reads the calendar expressions ("tomorrow at 1pm", "next Tuesday at 9am",
/// "December 5 at noon", "tonight"). Three things it does not do are handled here: relative
/// offsets ("in 20 minutes", "in an hour"), a bare trailing hour ("call mom at 5", which means the
/// next 5 o'clock), and knowing whether a time was said at all (it reports noon for "Friday").
public enum TaskifyReminderPhraseParser {
    public static func parse(
        _ input: String,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> TaskifyReminderPhrase {
        var text = stripCommand(from: input)

        var dueDate: Date?
        var hasTime = false
        var matchedRange: Range<String.Index>?

        // A bare clock time with no day named ("call mom at 5") is its next occurrence. The
        // detector would read it as a fixed half of the day, or miss it entirely.
        let namesADay = text.range(of: dayPattern, options: [.regularExpression, .caseInsensitive]) != nil
        if let relative = relativeOffset(in: text, now: now, calendar: calendar) {
            dueDate = relative.date
            hasTime = relative.hasTime
            matchedRange = relative.range
        } else if !namesADay, let bareHour = trailingBareHour(in: text, now: now, calendar: calendar) {
            dueDate = bareHour.date
            hasTime = true
            matchedRange = bareHour.range
        } else if let detected = detectedDate(in: text, now: now, calendar: calendar) {
            dueDate = detected.date
            hasTime = detected.hasTime
            matchedRange = detected.range
        }

        if let matchedRange {
            text = removingDateWords(text, range: matchedRange)
        }
        return TaskifyReminderPhrase(title: cleanTitle(text), dueDate: dueDate, hasTime: hasTime)
    }

    // MARK: - Command words

    private static func stripCommand(from input: String) -> String {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let patterns = [
            // "In Taskify, ..." / "... in Taskify."
            "^(?:in|using|with)\\s+taskify[,:]?\\s+",
            "[,]?\\s+(?:in|using|with|on)\\s+taskify[.!?]*$",
            // "Remind me to ...", "Set a reminder to ...", "Please remind me that I need to ..."
            "^(?:please\\s+)?(?:can\\s+you\\s+)?(?:remind\\s+me|(?:set|create|add|make)\\s+(?:a\\s+|an?\\s+)?reminder)" +
                "(?:\\s+(?:to|about|that\\s+i\\s+(?:need|have)\\s+to|that|for|of))?(?:\\s+|$)",
            // The phrase may arrive without the command, starting with "to"/"about".
            "^(?:to|about)\\s+",
            "[.!?]+$",
        ]
        for pattern in patterns {
            text = replacing(pattern, in: text, with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    // MARK: - "in 20 minutes"

    private static let numberWords: [String: Int] = [
        "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
        "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
        "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "forty-five": 45, "forty five": 45,
        "sixty": 60, "ninety": 90, "a couple of": 2, "a couple": 2, "a few": 3,
    ]

    private static func relativeOffset(
        in text: String,
        now: Date,
        calendar: Calendar
    ) -> (date: Date, hasTime: Bool, range: Range<String.Index>)? {
        if let range = text.range(
            of: "(?i)\\b(?:in|after)\\s+(?:a\\s+)?half\\s+(?:an?\\s+)?hour\\b",
            options: .regularExpression
        ) {
            return (wholeMinute(now.addingTimeInterval(30 * 60), calendar: calendar), true, range)
        }

        let quantity = "(\\d{1,4}|a couple of|a couple|a few|forty[- ]five|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty|ninety)"
        let unit = "(minutes?|mins?|hours?|hrs?|days?|weeks?)"
        guard let match = firstMatch(in: text, pattern: "(?i)\\b(?:in|after)\\s+\(quantity)\\s+\(unit)\\b"),
              let range = Range(match.range, in: text),
              let quantityRange = Range(match.range(at: 1), in: text),
              let unitRange = Range(match.range(at: 2), in: text) else { return nil }
        let quantityText = text[quantityRange].lowercased()
        guard let count = Int(quantityText) ?? numberWords[quantityText], count > 0 else { return nil }
        let unitText = text[unitRange].lowercased()

        if unitText.hasPrefix("m") {
            return (wholeMinute(now.addingTimeInterval(TimeInterval(count * 60)), calendar: calendar), true, range)
        }
        if unitText.hasPrefix("h") {
            return (wholeMinute(now.addingTimeInterval(TimeInterval(count * 3_600)), calendar: calendar), true, range)
        }
        let days = unitText.hasPrefix("w") ? count * 7 : count
        guard let date = calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: now)) else {
            return nil
        }
        return (date, false, range)
    }

    private static func wholeMinute(_ date: Date, calendar: Calendar) -> Date {
        calendar.dateInterval(of: .minute, for: date)?.start ?? date
    }

    // MARK: - Calendar expressions

    /// Words `NSDataDetector` folds into a match ("lunch at noon tomorrow") that belong to the title.
    private static let leadingNonDateWords = ["breakfast", "brunch", "lunch", "dinner", "supper"]

    private static func detectedDate(
        in text: String,
        now: Date,
        calendar: Calendar
    ) -> (date: Date, hasTime: Bool, range: Range<String.Index>)? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) else {
            return nil
        }
        let fullRange = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = detector.matches(in: text, range: fullRange).first(where: { $0.date != nil }),
              let detectedDate = match.date,
              var range = Range(match.range, in: text) else { return nil }

        let matchedLower = text[range].lowercased()
        for word in leadingNonDateWords where matchedLower.hasPrefix(word + " ") {
            range = text.index(range.lowerBound, offsetBy: word.count + 1)..<range.upperBound
            break
        }
        let matched = String(text[range])

        let hasTime = matched.range(of: timePattern, options: [.regularExpression, .caseInsensitive]) != nil
        guard hasTime else {
            return (calendar.startOfDay(for: detectedDate), false, range)
        }
        var date = wholeMinute(detectedDate, calendar: calendar)
        // "at 8am" said at 10am means tomorrow, not two hours ago. A named day is left alone.
        if date <= now,
           matched.range(of: dayPattern, options: [.regularExpression, .caseInsensitive]) == nil,
           let tomorrow = calendar.date(byAdding: .day, value: 1, to: date) {
            date = tomorrow
        }
        return (date, true, range)
    }

    private static let timePattern =
        "\\d\\s*(?:a\\.?\\s?m\\b\\.?|p\\.?\\s?m\\b\\.?)|\\d{1,2}:\\d{2}|\\b(?:noon|midday|midnight|morning|afternoon|evening|tonight|night|o'?clock)\\b|\\bat\\s+\\d"

    private static let dayPattern =
        "\\b(?:today|tomorrow|tonight|yesterday|this|next|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|" +
        "monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|" +
        "january|february|march|april|may|june|july|august|september|october|november|december)\\b|\\d{1,2}/\\d{1,2}"

    // MARK: - "at 5"

    private static func trailingBareHour(
        in text: String,
        now: Date,
        calendar: Calendar
    ) -> (date: Date, range: Range<String.Index>)? {
        guard let match = firstMatch(
            in: text,
            pattern: "(?i)\\s+(?:at|@)\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s*o'?clock)?$"
        ),
            let range = Range(match.range, in: text),
            let hourRange = Range(match.range(at: 1), in: text),
            let hour = Int(text[hourRange]) else { return nil }
        let minute = Range(match.range(at: 2), in: text).flatMap { Int(text[$0]) } ?? 0
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }

        // A 12-hour clock reading means its next occurrence: "at 5" is 5 PM after 5 AM has passed.
        let hours = (1...12).contains(hour) ? [hour % 12, hour % 12 + 12] : [hour]
        let startOfToday = calendar.startOfDay(for: now)
        let candidates = [0, 1].flatMap { dayOffset in
            hours.compactMap { hour -> Date? in
                guard let day = calendar.date(byAdding: .day, value: dayOffset, to: startOfToday) else { return nil }
                return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day)
            }
        }
        guard let date = candidates.filter({ $0 > now }).min() else { return nil }
        return (date, range)
    }

    // MARK: - Title

    private static func removingDateWords(_ text: String, range: Range<String.Index>) -> String {
        let before = String(text[..<range.lowerBound])
        let after = String(text[range.upperBound...])
        // A preposition left dangling by the removed date: "pay rent on [Friday]".
        let trimmedBefore = replacing("(?i)\\s+(?:on|at|by|for|due)\\s*$", in: before, with: " ")
        return trimmedBefore + " " + after
    }

    private static func cleanTitle(_ text: String) -> String {
        var title = replacing("\\s+", in: text, with: " ")
        title = title.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r,;:-\"'“”‘’"))
        title = replacing("(?i)\\s+(?:on|at|by|for|due)$", in: title, with: "")
        // "Remind me tomorrow at 1pm to take out the trash" leaves "to take out the trash".
        title = replacing("^(?:to|about|that)\\s+", in: title, with: "")
        guard let first = title.first else { return "" }
        return first.uppercased() + title.dropFirst()
    }

    // MARK: - Regex helpers

    private static func firstMatch(in text: String, pattern: String) -> NSTextCheckingResult? {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return nil }
        return expression.firstMatch(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text))
    }

    private static func replacing(_ pattern: String, in text: String, with template: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return text
        }
        return expression.stringByReplacingMatches(
            in: text,
            range: NSRange(text.startIndex..<text.endIndex, in: text),
            withTemplate: template
        )
    }
}
