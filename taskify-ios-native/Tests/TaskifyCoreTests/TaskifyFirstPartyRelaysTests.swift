import XCTest
@testable import TaskifyCore
import TaskifyWatchShared

/// Watch changes are proxied through Taskify's servers, whose shared IPs public relays rate-limit
/// per IP. They go only to Taskify's own relays; the phone fans them out to the board's public
/// relays from its own connection when it applies the Watch command.
final class TaskifyFirstPartyRelaysTests: XCTestCase {
    func testWatchPublishesOnlyToFirstPartyRelays() {
        XCTAssertEqual(
            TaskifyFirstPartyRelays.watchPublishTargets(boardRelayURLs: [
                "wss://relay.damus.io", "wss://relay.solife.me/", "wss://nos.lol",
            ]),
            ["wss://relay.solife.me"]
        )
    }

    func testABoardWithoutFirstPartyRelaysStillReachesTaskifysRelay() {
        XCTAssertEqual(
            TaskifyFirstPartyRelays.watchPublishTargets(boardRelayURLs: ["wss://relay.damus.io", "wss://nos.lol"]),
            [TaskifyFirstPartyRelays.relayURL]
        )
    }

    func testNativePacerTreatsTheSameRelaysAsFirstParty() {
        XCTAssertEqual(RelayPublishPacer.firstPartyRelayURLs, TaskifyFirstPartyRelays.urls)
    }
}
