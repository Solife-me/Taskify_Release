import Foundation
import XCTest
@testable import TaskifyCore

final class DeviceNotificationSelectionTests: XCTestCase {
    func testSelectionsSurviveNavigationAndReloadButDeletedItemsDropOut() throws {
        let suite = "DeviceNotificationSelectionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let september = Date(timeIntervalSince1970: 1_789_200_000)
        let october = september.addingTimeInterval(31 * 86_400)
        let first = "calendar-event-\(Int(september.timeIntervalSince1970))"
        let second = "calendar-event-\(Int(october.timeIntervalSince1970))"
        let selection = [
            DeviceNotificationSelection.eventKey(first): 15,
            DeviceNotificationSelection.eventKey(second): 60,
            DeviceNotificationSelection.reminderKey("reminder"): 0,
        ]
        DeviceNotificationSelection.saveMinutes(selection, defaults: defaults)
        let restored = DeviceNotificationSelection.loadMinutes(defaults: defaults)
        XCTAssertEqual(restored, selection)
        var liveEvents = [first: september, second: october]
        var reminderIsComplete = false
        func resolve() -> (events: [String], reminders: [String]) {
            DeviceNotificationSelection.resolve(restored, event: { id, occurrence in
                XCTAssertEqual(occurrence, id == first ? september : october)
                return liveEvents[id] == occurrence ? id : nil
            }, reminder: { id in reminderIsComplete ? nil : id })
        }
        // The visible page is deliberately absent from the resolver inputs: both months
        // must remain scheduled after navigation or restoring persisted preferences.
        XCTAssertEqual(Set(resolve().events), Set([first, second]))
        XCTAssertEqual(resolve().reminders, ["reminder"])
        liveEvents.removeValue(forKey: first)
        reminderIsComplete = true
        XCTAssertEqual(resolve().events, [second])
        XCTAssertTrue(resolve().reminders.isEmpty)
    }

    func testRemovingASelectionStopsResolvingIt() {
        var selection = [DeviceNotificationSelection.reminderKey("r"): 15]
        selection.removeValue(forKey: DeviceNotificationSelection.reminderKey("r"))
        let result: (events: [String], reminders: [String]) = DeviceNotificationSelection.resolve(
            selection,
            event: { _, _ in XCTFail("Removed selection must not be resolved"); return nil },
            reminder: { _ in XCTFail("Removed selection must not be resolved"); return nil }
        )
        XCTAssertTrue(result.events.isEmpty)
        XCTAssertTrue(result.reminders.isEmpty)
    }
}
