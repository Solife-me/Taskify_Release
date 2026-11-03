import Foundation
import TaskifyWatchShared
import XCTest

final class TaskifyReminderPhraseTests: XCTestCase {
    private let calendar = Calendar.current

    private func components(_ date: Date?) -> DateComponents? {
        date.map { calendar.dateComponents([.year, .month, .day, .hour, .minute], from: $0) }
    }

    private func day(offset: Int, hour: Int = 0, minute: Int = 0, from now: Date = Date()) -> DateComponents? {
        let start = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now))!
        return components(calendar.date(bySettingHour: hour, minute: minute, second: 0, of: start))
    }

    func testTomorrowAtOnePMFromTheSiriExample() {
        let phrase = TaskifyReminderPhraseParser.parse("remind me to take out the trash tomorrow at 1pm")
        XCTAssertEqual(phrase.title, "Take out the trash")
        XCTAssertTrue(phrase.hasTime)
        XCTAssertEqual(components(phrase.dueDate), day(offset: 1, hour: 13))
        XCTAssertEqual(phrase.reminderRawValues, ["0h"])
    }

    func testInvocationWordsAroundThePhraseAreRemoved() {
        for input in [
            "In Taskify remind me to take out the trash tomorrow at 1 PM.",
            "to take out the trash tomorrow at 1 p.m.",
            "Remind me to take out the trash tomorrow at 1pm in Taskify",
            "remind me tomorrow at 1pm to take out the trash",
        ] {
            let phrase = TaskifyReminderPhraseParser.parse(input)
            XCTAssertEqual(phrase.title, "Take out the trash", input)
            XCTAssertEqual(components(phrase.dueDate), day(offset: 1, hour: 13), input)
        }
    }

    func testDateWithoutTimeIsADayReminder() {
        let phrase = TaskifyReminderPhraseParser.parse("pay rent tomorrow")
        XCTAssertEqual(phrase.title, "Pay rent")
        XCTAssertFalse(phrase.hasTime)
        XCTAssertEqual(components(phrase.dueDate), day(offset: 1))
        XCTAssertEqual(phrase.reminderRawValues, ["0d"])
    }

    func testDanglingPrepositionBeforeTheDateIsRemoved() {
        let phrase = TaskifyReminderPhraseParser.parse("remind me to pay rent on Friday")
        XCTAssertEqual(phrase.title, "Pay rent")
        XCTAssertNotNil(phrase.dueDate)
        XCTAssertFalse(phrase.hasTime)
        XCTAssertEqual(phrase.dueDate.map { calendar.component(.weekday, from: $0) }, 6)
    }

    func testMealWordStaysInTheTitle() {
        let phrase = TaskifyReminderPhraseParser.parse("eat lunch at noon tomorrow")
        XCTAssertEqual(phrase.title, "Eat lunch")
        XCTAssertEqual(components(phrase.dueDate), day(offset: 1, hour: 12))
    }

    func testRelativeMinutesAndHours() {
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 15, minute: 4, second: 30))!
        let minutes = TaskifyReminderPhraseParser.parse("call mom in 20 minutes", now: now)
        XCTAssertEqual(minutes.title, "Call mom")
        XCTAssertTrue(minutes.hasTime)
        XCTAssertEqual(components(minutes.dueDate), DateComponents(year: 2026, month: 11, day: 2, hour: 15, minute: 24))

        let hour = TaskifyReminderPhraseParser.parse("feed the cat in an hour", now: now)
        XCTAssertEqual(hour.title, "Feed the cat")
        XCTAssertEqual(components(hour.dueDate), DateComponents(year: 2026, month: 11, day: 2, hour: 16, minute: 4))

        let half = TaskifyReminderPhraseParser.parse("stretch in half an hour", now: now)
        XCTAssertEqual(half.title, "Stretch")
        XCTAssertEqual(components(half.dueDate), DateComponents(year: 2026, month: 11, day: 2, hour: 15, minute: 34))
    }

    func testRelativeDaysHaveNoTime() {
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 15))!
        let phrase = TaskifyReminderPhraseParser.parse("renew passport in 3 days", now: now)
        XCTAssertEqual(phrase.title, "Renew passport")
        XCTAssertFalse(phrase.hasTime)
        XCTAssertEqual(components(phrase.dueDate), DateComponents(year: 2026, month: 11, day: 5, hour: 0, minute: 0))
    }

    func testBareHourMeansItsNextOccurrence() {
        let afternoon = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 14))!
        let later = TaskifyReminderPhraseParser.parse("call mom at 5", now: afternoon)
        XCTAssertEqual(later.title, "Call mom")
        XCTAssertEqual(components(later.dueDate), DateComponents(year: 2026, month: 11, day: 2, hour: 17, minute: 0))

        let morning = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 3))!
        let early = TaskifyReminderPhraseParser.parse("call mom at 5", now: morning)
        XCTAssertEqual(components(early.dueDate), DateComponents(year: 2026, month: 11, day: 2, hour: 5, minute: 0))

        let night = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 22))!
        let tomorrow = TaskifyReminderPhraseParser.parse("call mom at 5:30", now: night)
        XCTAssertEqual(components(tomorrow.dueDate), DateComponents(year: 2026, month: 11, day: 3, hour: 5, minute: 30))
    }

    func testTimeAlreadyPassedTodayMovesToTomorrow() {
        // "8am" has always passed by 11pm, and "11:59pm" never has before then.
        let now = Date()
        let hour = calendar.component(.hour, from: now)
        guard hour >= 9 else { return }
        let phrase = TaskifyReminderPhraseParser.parse("take vitamins at 8am")
        XCTAssertEqual(phrase.title, "Take vitamins")
        XCTAssertEqual(components(phrase.dueDate), day(offset: 1, hour: 8))
    }

    func testNoDateLeavesTheTitleAlone() {
        let phrase = TaskifyReminderPhraseParser.parse("Remind me to buy milk")
        XCTAssertEqual(phrase, TaskifyReminderPhrase(title: "Buy milk"))
        XCTAssertEqual(phrase.reminderRawValues, [])
    }

    func testOnlyATimeLeavesAnEmptyTitle() {
        let phrase = TaskifyReminderPhraseParser.parse("remind me tomorrow at 1pm")
        XCTAssertEqual(phrase.title, "")
        XCTAssertEqual(components(phrase.dueDate), day(offset: 1, hour: 13))
    }

    // MARK: - Reminder vocabulary

    func testReminderOffsetsRoundTripTheStoredStrings() {
        for (minutes, raw) in [(5, "5m"), (15, "15m"), (30, "30m"), (60, "1h"), (1_440, "1d"), (10_080, "1w"), (90, "custom-90")] {
            XCTAssertEqual(TaskifyReminderOffset.rawValue(minutesBefore: minutes, dateOnly: false), raw)
            XCTAssertEqual(TaskifyReminderOffset.minutesBefore(rawValue: raw), minutes)
        }
        XCTAssertEqual(TaskifyReminderOffset.rawValue(minutesBefore: 0, dateOnly: false), "0h")
        XCTAssertEqual(TaskifyReminderOffset.rawValue(minutesBefore: 0, dateOnly: true), "0d")
        XCTAssertNil(TaskifyReminderOffset.minutesBefore(rawValue: "soon"))
        XCTAssertEqual(TaskifyReminderOffset.label(rawValue: "0h"), "At due time")
        XCTAssertEqual(TaskifyReminderOffset.label(rawValue: "custom-90"), "90 minutes before")
    }

    func testNormalizingForAnUntimedTaskSwapsTheDueReminderAndDropsDuplicates() {
        XCTAssertEqual(
            TaskifyReminderOffset.normalized(["1h", "0h", "custom-60", "bogus", "1d"], dateOnly: true),
            ["0d", "1h", "1d"]
        )
        XCTAssertEqual(TaskifyReminderOffset.normalized(["0d"], dateOnly: false), ["0h"])
    }

    func testLegacyMinuteCountsInAPayloadAreRead() {
        XCTAssertEqual(TaskifyReminderOffset.rawValues(fromPayloadValue: ["0h", 1_440]), ["0h", "1d"])
        XCTAssertEqual(TaskifyReminderOffset.rawValues(fromPayloadValue: nil), [])
    }
}
