import XCTest
@testable import TaskifyCore

final class TaskifyNotificationContractTests: XCTestCase {
    func testUrgentAlarmDefaultsToNineAMWhenTodayIsStillEarly() throws {
        let calendar = chicagoCalendar
        let now = try date(2026, 8, 13, 8, 24, calendar: calendar)
        let selectedDate = try date(2026, 8, 13, 0, 0, calendar: calendar)

        let result = TaskifyUrgentAlarmContract.defaultDueDate(
            for: selectedDate,
            now: now,
            calendar: calendar,
            timeZone: calendar.timeZone
        )

        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day, .hour, .minute], from: result),
            DateComponents(year: 2026, month: 8, day: 13, hour: 9, minute: 0)
        )
    }

    func testUrgentAlarmDefaultsToNextWholeHourAfterNineAM() throws {
        let calendar = chicagoCalendar
        let now = try date(2026, 8, 13, 10, 24, calendar: calendar)

        let result = TaskifyUrgentAlarmContract.defaultDueDate(
            for: now,
            now: now,
            calendar: calendar,
            timeZone: calendar.timeZone
        )

        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day, .hour, .minute], from: result),
            DateComponents(year: 2026, month: 8, day: 13, hour: 11, minute: 0)
        )
    }

    func testUrgentAlarmKeepsFutureDateAndUsesNineAM() throws {
        let calendar = chicagoCalendar
        let now = try date(2026, 8, 13, 22, 45, calendar: calendar)
        let selectedDate = try date(2026, 8, 16, 0, 0, calendar: calendar)

        let result = TaskifyUrgentAlarmContract.defaultDueDate(
            for: selectedDate,
            now: now,
            calendar: calendar,
            timeZone: calendar.timeZone
        )

        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day, .hour, .minute], from: result),
            DateComponents(year: 2026, month: 8, day: 16, hour: 9, minute: 0)
        )
    }

    func testUrgentAlarmNextWholeHourCanCrossMidnight() throws {
        let calendar = chicagoCalendar
        let now = try date(2026, 8, 13, 23, 45, calendar: calendar)

        let result = TaskifyUrgentAlarmContract.defaultDueDate(
            for: now,
            now: now,
            calendar: calendar,
            timeZone: calendar.timeZone
        )

        XCTAssertEqual(
            calendar.dateComponents([.year, .month, .day, .hour, .minute], from: result),
            DateComponents(year: 2026, month: 8, day: 14, hour: 0, minute: 0)
        )
    }

    func testCompleteActionReadsTheStableTaskIdentifier() {
        let accountID = String(repeating: "ab", count: 32)
        let action = TaskifyNotificationContract.action(
            for: TaskifyNotificationContract.completeTaskActionIdentifier,
            userInfo: [
                TaskifyNotificationContract.accountIDKey: accountID,
                TaskifyNotificationContract.taskIDKey: "task-123",
                TaskifyNotificationContract.boardIDKey: "board-456",
            ]
        )

        XCTAssertEqual(action, .completeTask(accountID: accountID, taskID: "task-123"))
    }

    func testCompleteActionRejectsMissingOrBlankTaskIdentifiers() {
        XCTAssertNil(TaskifyNotificationContract.action(
            for: TaskifyNotificationContract.completeTaskActionIdentifier,
            userInfo: [:]
        ))
        XCTAssertNil(TaskifyNotificationContract.action(
            for: TaskifyNotificationContract.completeTaskActionIdentifier,
            userInfo: [TaskifyNotificationContract.taskIDKey: "task-123"]
        ))
        XCTAssertNil(TaskifyNotificationContract.action(
            for: TaskifyNotificationContract.completeTaskActionIdentifier,
            userInfo: [TaskifyNotificationContract.taskIDKey: "   "]
        ))
    }

    func testUnrelatedNotificationActionsAreIgnored() {
        let accountID = String(repeating: "ab", count: 32)
        XCTAssertNil(TaskifyNotificationContract.action(
            for: "unrelated-action",
            userInfo: [
                TaskifyNotificationContract.accountIDKey: accountID,
                TaskifyNotificationContract.taskIDKey: "task-123",
            ]
        ))
    }

    func testReplyActionReadsTheConversationAndTypedText() {
        let accountID = String(repeating: "21", count: 32)
        let conversationID = String(repeating: "ab", count: 32)
        let group = TaskifyNotificationContract.ReplyTarget(
            conversationID: conversationID.uppercased(),
            isGroup: true
        )
        XCTAssertEqual(group.userInfo, [
            TaskifyNotificationContract.conversationIDKey: conversationID,
            TaskifyNotificationContract.conversationKindKey: "group",
        ])
        let userInfo = group.userInfo.merging(
            [TaskifyNotificationContract.accountIDKey: accountID],
            uniquingKeysWith: { _, new in new }
        )
        XCTAssertEqual(
            TaskifyNotificationContract.action(
                for: TaskifyNotificationContract.replyDirectMessageActionIdentifier,
                userInfo: userInfo,
                responseText: "  On my way  \n"
            ),
            .reply(
                accountID: accountID,
                to: .init(conversationID: conversationID, isGroup: true),
                text: "On my way"
            )
        )
    }

    func testReplyActionRejectsBlankTextOrIncompleteConversation() {
        let accountID = String(repeating: "21", count: 32)
        let conversationID = String(repeating: "ab", count: 32)
        let userInfo = TaskifyNotificationContract.ReplyTarget(
            conversationID: conversationID,
            isGroup: false
        ).userInfo.merging(
            [TaskifyNotificationContract.accountIDKey: accountID],
            uniquingKeysWith: { _, new in new }
        )
        let reply = TaskifyNotificationContract.replyDirectMessageActionIdentifier
        XCTAssertNil(TaskifyNotificationContract.action(for: reply, userInfo: userInfo, responseText: " \n "))
        XCTAssertNil(TaskifyNotificationContract.action(for: reply, userInfo: userInfo))
        XCTAssertNil(TaskifyNotificationContract.action(
            for: reply,
            userInfo: [
                TaskifyNotificationContract.accountIDKey: accountID,
                TaskifyNotificationContract.conversationIDKey: conversationID,
            ],
            responseText: "Hello"
        ))
        XCTAssertNil(TaskifyNotificationContract.action(
            for: reply,
            userInfo: [
                TaskifyNotificationContract.accountIDKey: accountID,
                TaskifyNotificationContract.conversationIDKey: "npub-or-garbage",
                TaskifyNotificationContract.conversationKindKey: "direct",
            ],
            responseText: "Hello"
        ))
    }

    func testNotificationTapDestinationsUseStableDeviceLocalValues() {
        XCTAssertEqual(
            TaskifyNotificationContract.destination(userInfo: [
                TaskifyNotificationContract.destinationKey: "chat",
            ]),
            .chat
        )
        XCTAssertEqual(
            TaskifyNotificationContract.destination(userInfo: [
                TaskifyNotificationContract.destinationKey: "wallet",
            ]),
            .wallet
        )
    }

    func testNotificationTapDestinationRejectsMissingOrUnknownValues() {
        XCTAssertNil(TaskifyNotificationContract.destination(userInfo: [:]))
        XCTAssertNil(TaskifyNotificationContract.destination(userInfo: [
            TaskifyNotificationContract.destinationKey: "boards",
        ]))
    }

    func testPushPreviewSelectionIsScopedPerAccount() throws {
        let suite = "TaskifyNotificationContractTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = String(repeating: "11", count: 32)
        let second = String(repeating: "22", count: 32)

        DMPushNotificationSharedSettings.saveSelection(
            .messages,
            accountID: first,
            defaults: defaults
        )
        DMPushNotificationSharedSettings.saveSelection(
            .payments,
            accountID: second,
            defaults: defaults
        )

        XCTAssertEqual(
            DMPushNotificationSharedSettings.selection(accountID: first, defaults: defaults),
            .messages
        )
        XCTAssertEqual(
            DMPushNotificationSharedSettings.selection(accountID: second, defaults: defaults),
            .payments
        )
    }

    func testUrgentAlarmRequiresAnIncompleteFutureTaskWithDueTime() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let eligible = TaskItem(
            id: "eligible",
            boardID: "board",
            title: "Wake me",
            dueDate: now.addingTimeInterval(3_600),
            dueDateEnabled: true,
            dueTimeEnabled: true
        )
        var dateOnly = eligible
        dateOnly.dueTimeEnabled = false
        var completed = eligible
        completed.completed = true
        var past = eligible
        past.dueDate = now.addingTimeInterval(-60)

        XCTAssertTrue(TaskifyUrgentAlarmContract.isEligible(eligible, now: now))
        XCTAssertFalse(TaskifyUrgentAlarmContract.isEligible(dateOnly, now: now))
        XCTAssertFalse(TaskifyUrgentAlarmContract.isEligible(completed, now: now))
        XCTAssertFalse(TaskifyUrgentAlarmContract.isEligible(past, now: now))
    }

    func testUrgentRecurringTasksShareADevicePreferenceKey() {
        let first = TaskItem(
            id: "first",
            boardID: "board",
            title: "Medication",
            recurrence: .daily(),
            seriesID: "medication-series"
        )
        let second = TaskItem(
            id: "second",
            boardID: "board",
            title: "Medication",
            recurrence: .daily(),
            seriesID: "medication-series"
        )

        XCTAssertEqual(
            TaskifyUrgentAlarmContract.preferenceKey(for: first),
            TaskifyUrgentAlarmContract.preferenceKey(for: second)
        )
        XCTAssertEqual(TaskifyUrgentAlarmContract.preferenceKey(for: first), "series:medication-series")
    }

    private var chicagoCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }

    private func date(
        _ year: Int,
        _ month: Int,
        _ day: Int,
        _ hour: Int,
        _ minute: Int,
        calendar: Calendar
    ) throws -> Date {
        try XCTUnwrap(calendar.date(from: DateComponents(
            year: year,
            month: month,
            day: day,
            hour: hour,
            minute: minute
        )))
    }

    func testFallbackPushLosesEveryActionKey() {
        let pushed: [AnyHashable: Any] = [
            "aps": ["alert": "New Message"],
            "taskify": ["type": "dm-preview"],
            TaskifyNotificationContract.accountIDKey: String(repeating: "ab", count: 32),
            TaskifyNotificationContract.taskIDKey: "task-1",
            TaskifyNotificationContract.boardIDKey: "board-1",
            TaskifyNotificationContract.destinationKey: "chat",
            TaskifyNotificationContract.conversationIDKey: String(repeating: "a", count: 64),
            TaskifyNotificationContract.conversationKindKey: "direct",
        ]
        let cleaned = TaskifyNotificationContract.removingActionKeys(from: pushed)
        XCTAssertEqual(Set(cleaned.keys.compactMap { $0 as? String }), ["aps", "taskify"])
    }
}
