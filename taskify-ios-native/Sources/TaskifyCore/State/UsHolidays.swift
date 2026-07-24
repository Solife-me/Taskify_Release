import Foundation

/// A single US federal/cultural holiday occurrence, matching the PWA's `buildUsHolidayCalendarEvents`.
public struct UsHoliday: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let date: Date
    public let summary: String
}

/// Pure calendar-day math for US holidays, ported from `taskify-pwa/src/domains/calendar/holidayUtils.ts`.
public enum UsHolidays {
    private struct Definition {
        let id: String
        let title: String
        let includeObserved: Bool
        let summary: String
        let dateForYear: (Int, Calendar) -> Date?
    }

    private static let definitions: [Definition] = [
        Definition(id: "new-years-day", title: "New Year's Day", includeObserved: true, summary: "US federal holiday") {
            year, calendar in dateFrom(year: year, month: 1, day: 1, calendar: calendar)
        },
        Definition(id: "mlk-day", title: "Martin Luther King Jr. Day", includeObserved: false, summary: "US federal holiday") {
            year, calendar in nthWeekday(year: year, month: 1, weekday: 2, occurrence: 3, calendar: calendar)
        },
        Definition(id: "presidents-day", title: "Presidents Day", includeObserved: false, summary: "US federal holiday") {
            year, calendar in nthWeekday(year: year, month: 2, weekday: 2, occurrence: 3, calendar: calendar)
        },
        Definition(id: "valentines-day", title: "Valentine's Day", includeObserved: false, summary: "US holiday") {
            year, calendar in dateFrom(year: year, month: 2, day: 14, calendar: calendar)
        },
        Definition(id: "easter", title: "Easter", includeObserved: false, summary: "US holiday") {
            year, calendar in easter(year: year, calendar: calendar)
        },
        Definition(id: "memorial-day", title: "Memorial Day", includeObserved: false, summary: "US federal holiday") {
            year, calendar in lastWeekday(year: year, month: 5, weekday: 2, calendar: calendar)
        },
        Definition(id: "juneteenth", title: "Juneteenth", includeObserved: true, summary: "US federal holiday") {
            year, calendar in dateFrom(year: year, month: 6, day: 19, calendar: calendar)
        },
        Definition(id: "independence-day", title: "Independence Day", includeObserved: true, summary: "US federal holiday") {
            year, calendar in dateFrom(year: year, month: 7, day: 4, calendar: calendar)
        },
        Definition(id: "labor-day", title: "Labor Day", includeObserved: false, summary: "US federal holiday") {
            year, calendar in nthWeekday(year: year, month: 9, weekday: 2, occurrence: 1, calendar: calendar)
        },
        Definition(id: "columbus-day", title: "Columbus Day", includeObserved: false, summary: "US federal holiday") {
            year, calendar in nthWeekday(year: year, month: 10, weekday: 2, occurrence: 2, calendar: calendar)
        },
        Definition(id: "veterans-day", title: "Veterans Day", includeObserved: true, summary: "US federal holiday") {
            year, calendar in dateFrom(year: year, month: 11, day: 11, calendar: calendar)
        },
        Definition(id: "thanksgiving-day", title: "Thanksgiving Day", includeObserved: false, summary: "US federal holiday") {
            year, calendar in nthWeekday(year: year, month: 11, weekday: 5, occurrence: 4, calendar: calendar)
        },
        Definition(id: "christmas-eve", title: "Christmas Eve", includeObserved: false, summary: "US holiday") {
            year, calendar in dateFrom(year: year, month: 12, day: 24, calendar: calendar)
        },
        Definition(id: "christmas-day", title: "Christmas Day", includeObserved: true, summary: "US federal holiday") {
            year, calendar in dateFrom(year: year, month: 12, day: 25, calendar: calendar)
        },
    ]

    public static func holidays(fromYear: Int, toYear: Int, calendar: Calendar = .current) -> [UsHoliday] {
        let lowYear = min(fromYear, toYear)
        let highYear = max(fromYear, toYear)
        guard lowYear <= highYear else { return [] }

        var results: [UsHoliday] = []
        var seenIDs = Set<String>()

        func add(id: String, title: String, date: Date?, summary: String) {
            guard let date, seenIDs.insert(id).inserted else { return }
            results.append(UsHoliday(id: id, title: title, date: calendar.startOfDay(for: date), summary: summary))
        }

        for year in lowYear...highYear {
            for definition in definitions {
                guard let holidayDate = definition.dateForYear(year, calendar) else { continue }
                add(
                    id: "us-holiday:\(definition.id):\(year)",
                    title: definition.title,
                    date: holidayDate,
                    summary: definition.summary
                )
                guard definition.includeObserved,
                      let observed = observedDate(holidayDate, calendar: calendar) else { continue }
                add(
                    id: "us-holiday:\(definition.id):\(year):observed",
                    title: "\(definition.title) (Observed)",
                    date: observed,
                    summary: "\(definition.summary) (observed date)"
                )
            }

            add(
                id: "us-holiday:dst-start:\(year)",
                title: "Daylight Saving Time Begins",
                date: nthWeekday(year: year, month: 3, weekday: 1, occurrence: 2, calendar: calendar),
                summary: "Clocks move forward one hour in most US time zones"
            )
            add(
                id: "us-holiday:dst-end:\(year)",
                title: "Daylight Saving Time Ends",
                date: nthWeekday(year: year, month: 11, weekday: 1, occurrence: 1, calendar: calendar),
                summary: "Clocks move back one hour in most US time zones"
            )
        }

        return results.sorted {
            $0.date == $1.date ? $0.title < $1.title : $0.date < $1.date
        }
    }

    private static func dateFrom(year: Int, month: Int, day: Int, calendar: Calendar) -> Date? {
        calendar.date(from: DateComponents(year: year, month: month, day: day))
    }

    /// - Parameter weekday: `Calendar.component(.weekday, from:)` convention, 1 = Sunday ... 7 = Saturday.
    private static func nthWeekday(year: Int, month: Int, weekday: Int, occurrence: Int, calendar: Calendar) -> Date? {
        guard occurrence >= 1, let firstOfMonth = dateFrom(year: year, month: month, day: 1, calendar: calendar) else {
            return nil
        }
        let firstWeekday = calendar.component(.weekday, from: firstOfMonth)
        let offset = (weekday - firstWeekday + 7) % 7
        let day = 1 + offset + (occurrence - 1) * 7
        guard let range = calendar.range(of: .day, in: .month, for: firstOfMonth), range.contains(day) else {
            return nil
        }
        return dateFrom(year: year, month: month, day: day, calendar: calendar)
    }

    private static func lastWeekday(year: Int, month: Int, weekday: Int, calendar: Calendar) -> Date? {
        guard let firstOfMonth = dateFrom(year: year, month: month, day: 1, calendar: calendar),
              let range = calendar.range(of: .day, in: .month, for: firstOfMonth) else {
            return nil
        }
        let maxDay = range.count
        guard let lastOfMonth = dateFrom(year: year, month: month, day: maxDay, calendar: calendar) else { return nil }
        let lastWeekday = calendar.component(.weekday, from: lastOfMonth)
        let offset = (lastWeekday - weekday + 7) % 7
        let day = maxDay - offset
        guard day >= 1, day <= maxDay else { return nil }
        return dateFrom(year: year, month: month, day: day, calendar: calendar)
    }

    private static func observedDate(_ date: Date, calendar: Calendar) -> Date? {
        switch calendar.component(.weekday, from: date) {
        case 7: return calendar.date(byAdding: .day, value: -1, to: date) // Saturday -> observed Friday
        case 1: return calendar.date(byAdding: .day, value: 1, to: date) // Sunday -> observed Monday
        default: return nil
        }
    }

    /// Anonymous Gregorian algorithm.
    private static func easter(year: Int, calendar: Calendar) -> Date? {
        guard year >= 1583 else { return nil }
        let a = year % 19
        let b = year / 100
        let c = year % 100
        let d = b / 4
        let e = b % 4
        let f = (b + 8) / 25
        let g = (b - f + 1) / 3
        let h = (19 * a + b - d - g + 15) % 30
        let i = c / 4
        let k = c % 4
        let l = (32 + 2 * e + 2 * i - h - k) % 7
        let m = (a + 11 * h + 22 * l) / 451
        let month = (h + l - 7 * m + 114) / 31
        let day = ((h + l - 7 * m + 114) % 31) + 1
        guard month >= 1, month <= 12, day >= 1, day <= 31 else { return nil }
        return dateFrom(year: year, month: month, day: day, calendar: calendar)
    }
}
