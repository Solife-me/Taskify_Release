import Foundation
import XCTest
@testable import TaskifyCore

final class NostrChatListItemTests: XCTestCase {
    func testStrangersSortAtTopMiddleAndBottomByLatestActivity() {
        let recent = thread("recent", at: 300)
        let older = thread("older", at: 100)
        for (timestamp, expected) in [
            (400, ["strangers", "thread:recent", "thread:older"]),
            (200, ["thread:recent", "strangers", "thread:older"]),
            (50, ["thread:recent", "thread:older", "strangers"]),
        ] {
            let rows = NostrChatListItem.rows(
                threads: [recent, older],
                strangerThreads: [thread("stranger", at: timestamp)]
            )
            XCTAssertEqual(rows.map(\.id), expected)
        }
    }

    func testLatestStrangerDeterminesSingleInboxPositionRegardlessOfInputOrder() {
        let strangers = [thread("old-stranger", at: 50), thread("new-stranger", at: 200)]
        let familiar = [thread("recent", at: 300), thread("older", at: 100)]
        let rows = NostrChatListItem.rows(threads: familiar, strangerThreads: strangers)
        XCTAssertEqual(rows.map(\.id), ["thread:recent", "strangers", "thread:older"])
        XCTAssertEqual(rows, NostrChatListItem.rows(threads: familiar, strangerThreads: strangers.reversed()))
    }

    func testSharedTaskActivityMovesInboxAboveOlderMessages() {
        var stranger = thread("stranger", at: 50)
        stranger.sharedTasks = [SharedInboxItem(
            wrapEventID: "task-wrap",
            rumorEventID: "task-rumor",
            sender: SharedInboxSender(publicKey: "stranger", name: "Stranger"),
            task: SharedTaskDelivery(title: "Shared task"),
            receivedAt: Date(timeIntervalSince1970: 200)
        )]
        let rows = NostrChatListItem.rows(
            threads: [thread("familiar", at: 100)],
            strangerThreads: [stranger]
        )
        XCTAssertEqual(rows.map(\.id), ["strangers", "thread:familiar"])
    }

    func testEqualTimestampsPreserveConversationOrderBeforeInbox() {
        let rows = NostrChatListItem.rows(
            threads: [thread("b", at: 100), thread("a", at: 100)],
            strangerThreads: [thread("stranger", at: 100)]
        )
        XCTAssertEqual(rows.map(\.id), ["thread:b", "thread:a", "strangers"])
    }

    func testNoStrangersLeavesSearchAndExpandedInboxThreadsUnchanged() {
        let threads = [thread("stranger", at: 200), thread("familiar", at: 100)]
        XCTAssertEqual(NostrChatListItem.rows(threads: threads), threads.map(NostrChatListItem.thread))
        XCTAssertTrue(NostrChatListItem.rows(threads: []).isEmpty)
    }

    func testOnlyStrangersProducesSingleInboxRow() {
        XCTAssertEqual(
            NostrChatListItem.rows(threads: [], strangerThreads: [thread("stranger", at: 100)]),
            [.strangers]
        )
    }

    func testInboxMovesAfterNewActivityWithoutChangingItsIdentity() {
        let familiar = [thread("familiar", at: 100)]
        let before = NostrChatListItem.rows(threads: familiar, strangerThreads: [thread("stranger", at: 50)])
        let after = NostrChatListItem.rows(threads: familiar, strangerThreads: [thread("stranger", at: 200)])
        XCTAssertEqual(before.map(\.id), ["thread:familiar", "strangers"])
        XCTAssertEqual(after.map(\.id), ["strangers", "thread:familiar"])
    }

    private func thread(_ peer: String, at timestamp: Int) -> NostrDirectMessageThread {
        NostrDirectMessageThread(
            peerPublicKey: peer,
            messages: [NostrDirectMessage(
                rumorEventID: "rumor-\(peer)",
                wrapEventID: "wrap-\(peer)",
                peerPublicKey: peer,
                senderPublicKey: peer,
                content: "Hello",
                createdAt: timestamp,
                isIncoming: true
            )],
            unreadCount: 1
        )
    }
}
