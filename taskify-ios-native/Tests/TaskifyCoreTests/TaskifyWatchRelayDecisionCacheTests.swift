import Foundation
import XCTest
import TaskifyWatchShared

final class TaskifyWatchRelayDecisionCacheTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testOldPublishedListStaysFreshAfterSuccessfulLookup() {
        var cache = TaskifyWatchRelayDecisionCache()
        let decision = TaskifyWatchRelayDecision(
            status: .published, relayURLs: ["wss://recipient.example"],
            eventCreatedAt: 1_700_000_000
        )
        cache.record(decision, for: "recipient", seedEventID: "old-event", checkedAt: now)
        XCTAssertEqual(cache.decision(for: "recipient", seedEventID: "old-event", now: now.addingTimeInterval(60)), decision)
        XCTAssertNil(cache.decision(for: "recipient", seedEventID: "old-event", now: now.addingTimeInterval(6 * 60 * 60)))
    }

    func testChangedPhonePreferenceInvalidatesCachedDecision() {
        var cache = TaskifyWatchRelayDecisionCache()
        cache.record(.init(status: .published, relayURLs: ["wss://old.example"]),
                     for: "recipient", seedEventID: "old", checkedAt: now)
        XCTAssertNil(cache.decision(for: "recipient", seedEventID: "new", now: now))
    }

    func testFailedDiscoveryDoesNotBecomeFreshRoutingEvidence() {
        for decision in [
            TaskifyWatchRelayDecision(status: .indeterminate),
            TaskifyWatchRelayDecision(status: .publishedButUnusable),
            TaskifyWatchRelayDecision(status: .published, relayURLs: ["wss://old.example"], isStale: true),
        ] {
            var cache = TaskifyWatchRelayDecisionCache()
            cache.record(decision, for: "recipient", seedEventID: nil, checkedAt: now)
            XCTAssertNil(cache.decision(for: "recipient", seedEventID: nil, now: now))
        }
    }

    func testCacheIsBoundedAndSupportsRecipientsOutsideContacts() {
        var cache = TaskifyWatchRelayDecisionCache(maximumCount: 2)
        let decision = TaskifyWatchRelayDecision(status: .confirmedAbsent, relayURLs: ["wss://fallback.example"])
        for index in 0..<3 {
            cache.record(decision, for: "peer-\(index)", seedEventID: nil,
                         checkedAt: now.addingTimeInterval(Double(index)))
        }
        XCTAssertNil(cache.decision(for: "peer-0", seedEventID: nil, now: now.addingTimeInterval(3)))
        XCTAssertEqual(cache.decision(for: "peer-2", seedEventID: nil, now: now.addingTimeInterval(3)), decision)
    }
}
