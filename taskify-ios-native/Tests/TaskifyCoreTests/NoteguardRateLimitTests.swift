import Foundation
import XCTest
@testable import TaskifyCore

/// relay.damus.io runs noteguard's rate limit: 8 posts a minute per IP, and an hour's ban after
/// 10 refusals in a row. These drive the public-relay pacer against a model of it.
final class NoteguardRateLimitTests: XCTestCase {
    /// noteguard's `RateLimit.filter_note`: a token bucket credited with elapsed time in whole
    /// seconds (`Duration::as_secs`), capped at 60 s, where a post is refused if spending its
    /// token would empty the bucket. Refusals don't move `last_post`; any accepted post clears
    /// the refusal streak.
    private struct NoteguardRateLimit {
        let postsPerMinute = 8
        let banAfter = 10
        var tokens: Int?
        var lastPost: TimeInterval = 0
        var streak = 0
        var longestStreak = 0
        var refused = 0

        mutating func post(at now: TimeInterval) -> Bool {
            guard let current = tokens else {
                tokens = postsPerMinute
                lastPost = now
                return true
            }
            let seconds = min(60, Int(now - lastPost))
            let earned = Int((Double(seconds) / 60 * Double(postsPerMinute)).rounded(.down))
            let next = min(max(current + earned - 1, 0), postsPerMinute - 1)
            tokens = next
            guard next > 0 else {
                streak += 1
                refused += 1
                longestStreak = max(longestStreak, streak)
                return false
            }
            lastPost = now
            streak = 0
            return true
        }
    }

    /// Sends `count` events through the pacer, a rejected event staying first in line, and
    /// returns the relay's view plus when the last one went out.
    private func drive(
        _ relay: inout NoteguardRateLimit,
        count: Int,
        from start: TimeInterval,
        inFlightOnFirstRefusal: Int = 1
    ) -> TimeInterval {
        var pacer = RelayPublishPacer.forRelay("wss://relay.damus.io")
        var now = start
        var sent = 0
        var firstRefusal = true
        while sent < count {
            now += pacer.delayBeforePublish(at: now)
            pacer.recordPublish(at: now)
            if relay.post(at: now) {
                pacer.recordAccepted()
                sent += 1
            } else {
                if firstRefusal {
                    // Events already in flight when the budget ran out are refused as well.
                    for _ in 1..<inFlightOnFirstRefusal { _ = relay.post(at: now) }
                    firstRefusal = false
                }
                pacer.recordRateLimit(at: now)
            }
        }
        return now
    }

    func testASteadyBacklogIsNeverRefused() {
        var relay = NoteguardRateLimit()
        let finished = drive(&relay, count: 61, from: 100)
        XCTAssertEqual(relay.refused, 0)
        XCTAssertEqual(finished - 100, 54 * 10, accuracy: 1)
    }

    /// After a quiet spell noteguard's bucket holds 7, not 8: the opening burst fits it.
    func testTheOpeningBurstFitsABucketThatWentQuiet() {
        var relay = NoteguardRateLimit(tokens: 1, lastPost: 0)
        _ = drive(&relay, count: 20, from: 1_000)
        XCTAssertEqual(relay.refused, 0)
    }

    func testTheOldSevenAndAHalfSecondPaceWasRefused() {
        var relay = NoteguardRateLimit()
        var now: TimeInterval = 100
        for index in 0..<20 {
            now = 100 + (index < 8 ? Double(index) * 0.05 : 0.35 + Double(index - 7) * 7.5)
            _ = relay.post(at: now)
        }
        XCTAssertGreaterThan(relay.refused, 0, "The model reproduces the refusals the old pace hit")
    }

    /// Another device on the same network has just spent the IP's budget: the refusals stop well
    /// short of the ban, and the backlog still goes out.
    func testAnEmptyBudgetRecoversWithoutABan() {
        var relay = NoteguardRateLimit(tokens: 0, lastPost: 99)
        _ = drive(&relay, count: 20, from: 100, inFlightOnFirstRefusal: 4)
        XCTAssertLessThan(relay.longestStreak, relay.banAfter)
        XCTAssertLessThanOrEqual(relay.refused, 5)
    }

    func testARateLimitedRelayIsProbedOneEventAtATime() {
        var pacer = RelayPublishPacer.forRelay("wss://relay.damus.io")
        XCTAssertEqual(pacer.maximumInFlight, 4)
        let backoff = pacer.recordRateLimit(at: 100)
        XCTAssertEqual(backoff, 20, accuracy: 0.001)
        XCTAssertEqual(pacer.maximumInFlight, 1)
        XCTAssertEqual(pacer.currentInterval, 10, accuracy: 0.001)
        XCTAssertEqual(RelayPublishPacer.forRelay("wss://relay.solife.me").maximumInFlight, 4)
    }

    func testABanPausesTheRelayForHalfAnHour() {
        XCTAssertTrue(NostrRelayRejection.isBanned("banned: too many rate-limit violations, try again later"))
        XCTAssertFalse(NostrRelayRejection.isBanned("blocked: spam"))
        var pacer = RelayPublishPacer.forRelay("wss://relay.damus.io")
        XCTAssertEqual(pacer.recordBan(at: 100), RelayPublishPacer.banBackoff, accuracy: 0.001)
        XCTAssertEqual(pacer.maximumInFlight, 1)
    }
}
