#if canImport(UserNotifications)
import UserNotifications
import XCTest
@testable import TaskifyCore

final class TaskifyNotificationCategoriesTests: XCTestCase {
    func testTaskAndDirectMessageCategoriesAreRegisteredTogether() throws {
        let categories = Dictionary(
            uniqueKeysWithValues: TaskifyNotificationCategories.all.map { ($0.identifier, $0) }
        )
        XCTAssertEqual(Set(categories.keys), [
            TaskifyNotificationContract.taskCategoryIdentifier,
            TaskifyNotificationContract.directMessageCategoryIdentifier,
        ])
        XCTAssertEqual(
            categories[TaskifyNotificationContract.taskCategoryIdentifier]?.actions.map(\.identifier),
            [TaskifyNotificationContract.completeTaskActionIdentifier]
        )
        let reply = try XCTUnwrap(
            categories[TaskifyNotificationContract.directMessageCategoryIdentifier]?.actions.first
                as? UNTextInputNotificationAction
        )
        XCTAssertEqual(reply.identifier, TaskifyNotificationContract.replyDirectMessageActionIdentifier)
        XCTAssertFalse(reply.options.contains(.foreground))
        XCTAssertFalse(reply.options.contains(.authenticationRequired))
    }

    func testSignatureMatchesARebuiltSetAndDetectsChangedCategories() {
        let registered = TaskifyNotificationCategories.signature(TaskifyNotificationCategories.all)
        XCTAssertEqual(TaskifyNotificationCategories.signature(TaskifyNotificationCategories.all), registered)

        XCTAssertNotEqual(
            TaskifyNotificationCategories.signature([TaskifyNotificationCategories.taskCategory]),
            registered
        )

        let plainReply = UNNotificationCategory(
            identifier: TaskifyNotificationContract.directMessageCategoryIdentifier,
            actions: [UNNotificationAction(
                identifier: TaskifyNotificationContract.replyDirectMessageActionIdentifier,
                title: "Reply",
                options: []
            )],
            intentIdentifiers: [],
            options: []
        )
        XCTAssertNotEqual(
            TaskifyNotificationCategories.signature([TaskifyNotificationCategories.taskCategory, plainReply]),
            registered
        )
    }
}
#endif
