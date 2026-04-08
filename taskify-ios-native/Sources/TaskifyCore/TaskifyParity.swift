import Foundation

public enum TaskifyParity {
    public static let pinnedBountyListKey = "taskify::pinned"

    public static func normalizeTaskPriority(_ value: Any?) -> TaskPriority? {
        switch value {
        case let value as Int where (1...3).contains(value):
            return TaskPriority(rawValue: value)
        case let value as Double:
            return TaskPriority(rawValue: Int(value.rounded()))
        case let value as String:
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed == "!" || trimmed == "!!" || trimmed == "!!!" {
                return TaskPriority(rawValue: trimmed.count)
            }
            if let parsed = Int(trimmed), (1...3).contains(parsed) {
                return TaskPriority(rawValue: parsed)
            }
            return nil
        default:
            return nil
        }
    }

    public static func toXOnlyHex(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hex = trimmed.hasPrefix("0x") ? String(trimmed.dropFirst(2)) : trimmed
        if hex.range(of: /^(02|03)[0-9a-f]{64}$/) != nil { return String(hex.suffix(64)) }
        if hex.range(of: /^[0-9a-f]{64}$/) != nil { return hex }
        return nil
    }

    public static func normalizeBounty(_ bounty: Bounty?) -> Bounty? {
        guard var bounty else { return nil }
        bounty.owner = toXOnlyHex(bounty.owner)
        bounty.sender = toXOnlyHex(bounty.sender)
        bounty.receiver = toXOnlyHex(bounty.receiver)

        if bounty.state == "claimed" || bounty.state == "revoked" {
            return bounty
        }

        let hasToken = !(bounty.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
        let hasCipher = bounty.enc != nil

        if hasToken && !hasCipher {
            bounty.state = "unlocked"
            if bounty.lock == nil || bounty.lock == "unknown" { bounty.lock = "none" }
        } else if hasCipher && !hasToken {
            bounty.state = "locked"
        } else if hasToken && hasCipher {
            bounty.state = "unlocked"
        } else {
            bounty.state = "locked"
        }

        return bounty
    }

    public static func normalizeTaskBounty(_ task: Task) -> Task {
        var task = task
        task.bounty = normalizeBounty(task.bounty)
        return task
    }

    public static func normalizeTaskCreatedAt(_ value: Any?) -> Int? {
        value as? Int
    }

    public static func revealsOnDueDate(_ rule: RecurrenceRule) -> Bool {
        isFrequentRecurrence(rule)
    }

    public static func isFrequentRecurrence(_ rule: RecurrenceRule?) -> Bool {
        guard let rule else { return false }
        if rule.type == .daily || rule.type == .weekly { return true }
        if rule.type == .every { return rule.unit == "day" || rule.unit == "week" }
        return false
    }

    public static func recurrenceSeriesKey(_ task: Task) -> String? {
        guard task.recurrence != nil else { return nil }
        if let seriesId = task.seriesId { return "series:\(task.boardId):\(seriesId)" }
        let recurrenceJSON = String(data: (try? JSONEncoder().encode(task.recurrence)) ?? Data(), encoding: .utf8) ?? ""
        return "sig:\(task.boardId)::\(task.title)::\(task.note ?? "")::\(recurrenceJSON)"
    }

    public static func recurringInstanceId(seriesId: String, dueISO: String, rule: RecurrenceRule?, timeZone: String?) -> String {
        let datePart = DateUtils.isoDatePart(dueISO, timeZone: timeZone)
        let timePart = (rule?.type == .every && rule?.unit == "hour") ? DateUtils.isoTimePartUtc(dueISO) : ""
        let suffix = timePart.isEmpty ? datePart : "\(datePart)T\(timePart)"
        return "recurrence:\(seriesId):\(suffix)"
    }

    public static func recurringOccurrenceKey(_ task: Task) -> String? {
        guard isFrequentRecurrence(task.recurrence), let seriesKey = recurrenceSeriesKey(task) else { return nil }
        return "\(seriesKey)::\(DateUtils.isoDatePart(task.dueISO, timeZone: task.dueTimeZone))"
    }

    public static func pickRecurringDuplicate(_ a: Task, _ b: Task) -> Task {
        let aCompleted = a.completed ?? false
        let bCompleted = b.completed ?? false
        if aCompleted != bCompleted { return aCompleted ? a : b }

        let aCompletedAt = a.completedAt.flatMap(ISO8601DateFormatter.taskify.date(from:))?.timeIntervalSince1970 ?? 0
        let bCompletedAt = b.completedAt.flatMap(ISO8601DateFormatter.taskify.date(from:))?.timeIntervalSince1970 ?? 0
        if aCompletedAt != bCompletedAt { return aCompletedAt >= bCompletedAt ? a : b }

        let aIsBase = a.seriesId != nil && a.id == a.seriesId
        let bIsBase = b.seriesId != nil && b.id == b.seriesId
        if aIsBase != bIsBase { return aIsBase ? a : b }

        let aOrder = a.order ?? Int.max
        let bOrder = b.order ?? Int.max
        if aOrder != bOrder { return aOrder < bOrder ? a : b }
        return a.id <= b.id ? a : b
    }

    public static func dedupeRecurringInstances(_ tasks: [Task]) -> [Task] {
        var out: [Task] = []
        var indexByKey: [String: Int] = [:]
        var changed = false

        for task in tasks {
            guard let key = recurringOccurrenceKey(task) else {
                out.append(task)
                continue
            }
            if let existingIndex = indexByKey[key] {
                let winner = pickRecurringDuplicate(out[existingIndex], task)
                if winner != out[existingIndex] { out[existingIndex] = winner }
                changed = true
            } else {
                indexByKey[key] = out.count
                out.append(task)
            }
        }

        return changed ? out : tasks
    }

    public static func nextOccurrence(currentISO: String, rule: RecurrenceRule, keepTime: Bool = false, timeZone: String? = nil) -> String? {
        guard let current = ISO8601DateFormatter.taskify.date(from: currentISO) ?? ISO8601DateFormatter.taskifyFractional.date(from: currentISO) else {
            return nil
        }

        let next: Date?
        switch rule.type {
        case .none:
            next = nil
        case .daily:
            next = Calendar.current.date(byAdding: .day, value: 1, to: current)
        case .weekly:
            guard let days = rule.days, !days.isEmpty else { return nil }
            var candidate: Date?
            for i in 1...28 {
                let test = Calendar.current.date(byAdding: .day, value: i, to: current)!
                if days.contains(Calendar.current.component(.weekday, from: test) - 1) {
                    candidate = test
                    break
                }
            }
            next = candidate
        case .every:
            if rule.unit == "hour" {
                next = Calendar.current.date(byAdding: .hour, value: rule.n ?? 1, to: current)
            } else if rule.unit == "week" {
                next = Calendar.current.date(byAdding: .day, value: (rule.n ?? 1) * 7, to: current)
            } else {
                next = Calendar.current.date(byAdding: .day, value: rule.n ?? 1, to: current)
            }
        case .monthlyDay:
            let interval = max(1, rule.interval ?? 1)
            next = Calendar.current.date(byAdding: .month, value: interval, to: current)
        }

        guard let next else { return nil }
        if let untilISO = rule.untilISO,
           let until = ISO8601DateFormatter.taskify.date(from: untilISO) ?? ISO8601DateFormatter.taskifyFractional.date(from: untilISO),
           DateUtils.startOfDay(next) > DateUtils.startOfDay(until) {
            return nil
        }

        if keepTime {
            return next.ISO8601Format()
        }
        let dateKey = DateUtils.isoDatePart(next.ISO8601Format(), timeZone: timeZone)
        return DateUtils.isoFromDateTime(dateKey, time: DateUtils.isoTimePart(currentISO, timeZone: timeZone), timeZone: timeZone)
    }

    public static func hiddenUntilForBoard(dueISO: String, boardKind: BoardKind, weekStart: Weekday) -> String? {
        guard let due = ISO8601DateFormatter.taskify.date(from: dueISO) ?? ISO8601DateFormatter.taskifyFractional.date(from: dueISO) else { return nil }
        let dueDate = DateUtils.startOfDay(due)
        let today = DateUtils.startOfDay(Date())
        if boardKind == .lists || boardKind == .compound {
            return dueDate > today ? dueDate.ISO8601Format() : nil
        }
        let nowSow = startOfWeek(Date(), weekStart: weekStart)
        let dueSow = startOfWeek(dueDate, weekStart: weekStart)
        return dueSow > nowSow ? dueSow.ISO8601Format() : nil
    }

    public static func applyHiddenForFuture(_ task: Task, weekStart: Weekday, boardKind: BoardKind) -> Task {
        var task = task
        if task.dueDateEnabled == false {
            task.hiddenUntilISO = nil
            return task
        }
        task.hiddenUntilISO = hiddenUntilForBoard(dueISO: task.dueISO, boardKind: boardKind, weekStart: weekStart)
        return task
    }

    public static func nextOrderForBoard(boardId: String, tasks: [Task], newTaskPosition: String) -> Int {
        let boardTasks = tasks.filter { $0.boardId == boardId }
        if newTaskPosition == "top" {
            return (boardTasks.map { $0.order ?? 0 }.min() ?? 0) - 1
        }
        return (boardTasks.map { $0.order ?? -1 }.max() ?? -1) + 1
    }

    public static func nextOrderForCalendarBoard(boardId: String, events: [CalendarEvent], newItemPosition: String) -> Int {
        let boardEvents = events.filter { $0.boardId == boardId && $0.external != true }
        if newItemPosition == "top" {
            return (boardEvents.map { $0.order ?? 0 }.min() ?? 0) - 1
        }
        return (boardEvents.map { $0.order ?? -1 }.max() ?? -1) + 1
    }

    public static func startOfWeek(_ date: Date, weekStart: Weekday) -> Date {
        let sd = DateUtils.startOfDay(date)
        let current = Calendar(identifier: .gregorian).component(.weekday, from: sd) - 1
        let ws = (weekStart == 1 || weekStart == 6) ? weekStart : 0
        var diff = current - ws
        if diff < 0 { diff += 7 }
        return Calendar(identifier: .gregorian).date(byAdding: .day, value: -diff, to: sd) ?? sd
    }

    public static func calendarEventDateKey(_ event: CalendarEvent) -> String? {
        switch event.kind {
        case .date:
            guard let startDate = event.startDate, startDate.wholeMatch(of: DateUtils.isoDatePattern) != nil else { return nil }
            return startDate
        case .time:
            guard let startISO = event.startISO else { return nil }
            let key = DateUtils.isoDatePart(startISO, timeZone: event.startTzid)
            return key.wholeMatch(of: DateUtils.isoDatePattern) != nil ? key : nil
        }
    }

    public static func hiddenUntilForCalendarEvent(_ event: CalendarEvent, boardKind: BoardKind, weekStart: Weekday) -> String? {
        guard boardKind == .lists || boardKind == .compound,
              let dateKey = calendarEventDateKey(event),
              let parsed = DateUtils.parseDateKey(dateKey),
              let eventDate = Calendar(identifier: .gregorian).date(from: DateComponents(year: parsed.year, month: parsed.month, day: parsed.day)) else { return nil }
        let eventWeekStart = startOfWeek(eventDate, weekStart: weekStart)
        let currentWeekStart = startOfWeek(Date(), weekStart: weekStart)
        return eventWeekStart > currentWeekStart ? eventWeekStart.ISO8601Format() : nil
    }

    public static func applyHiddenForCalendarEvent(_ event: CalendarEvent, weekStart: Weekday, boardKind: BoardKind) -> CalendarEvent {
        var event = event
        event.hiddenUntilISO = hiddenUntilForCalendarEvent(event, boardKind: boardKind, weekStart: weekStart)
        return event
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
