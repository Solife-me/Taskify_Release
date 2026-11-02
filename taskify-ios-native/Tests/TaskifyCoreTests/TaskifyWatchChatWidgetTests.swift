import TaskifyWatchShared
import XCTest

final class TaskifyWatchChatWidgetTests: XCTestCase {
    private let alice = String(repeating: "a", count: 64)
    private let bob = String(repeating: "b", count: 64)

    private func conversation(
        _ id: String,
        _ name: String,
        unread: Int = 0
    ) -> TaskifyWatchChatWidgetConversation {
        TaskifyWatchChatWidgetConversation(
            id: id,
            displayName: name,
            unreadCount: unread,
            isGroup: false
        )
    }

    func testChatLinksRoundTrip() {
        let links: [TaskifyWatchChatLink] = [.messages, .newMessage, .conversation(id: alice)]
        for link in links {
            XCTAssertEqual(TaskifyWatchChatLink(url: link.url), link)
        }
    }

    func testChatLinkRejectsForeignAndMalformedURLs() {
        for raw in [
            "taskify://chat",
            "taskify-watch://tasks",
            "taskify-watch://chat/unknown",
            "taskify-watch://chat/conversation/not-a-key",
            "taskify-watch://chat/conversation/\(alice)/extra",
        ] {
            XCTAssertNil(TaskifyWatchChatLink(url: URL(string: raw)!), raw)
        }
    }

    func testSnapshotPutsUnreadFirstAndKeepsRecencyWithinEachGroup() {
        let carol = String(repeating: "c", count: 64)
        let snapshot = TaskifyWatchChatWidgetSnapshot(
            unreadCount: 1,
            conversations: [
                conversation(alice, "Alice"),
                conversation(carol, "Carol"),
                conversation(bob, "Bob", unread: 1),
            ]
        )
        XCTAssertEqual(snapshot.conversations.map(\.displayName), ["Bob", "Alice", "Carol"])
        XCTAssertEqual(snapshot.unreadConversations.map(\.displayName), ["Bob"])
    }

    func testSnapshotCapKeepsUnreadConversations() {
        let read = (0..<TaskifyWatchChatWidgetSnapshot.maximumConversationCount).map {
            conversation(String(format: "%064x", $0), "Read \($0)")
        }
        let snapshot = TaskifyWatchChatWidgetSnapshot(
            unreadCount: 1,
            conversations: read + [conversation(alice, "Unread", unread: 1)]
        )
        XCTAssertEqual(
            snapshot.conversations.count,
            TaskifyWatchChatWidgetSnapshot.maximumConversationCount
        )
        XCTAssertEqual(snapshot.conversations.first?.displayName, "Unread")
    }

    func testDirectoryComparisonIgnoresUnreadCountsAndOrder() {
        let first = TaskifyWatchChatWidgetSnapshot(conversations: [
            conversation(alice, "Alice"), conversation(bob, "Bob"),
        ])
        let reordered = TaskifyWatchChatWidgetSnapshot(unreadCount: 2, conversations: [
            conversation(bob, "Bob", unread: 2), conversation(alice, "Alice"),
        ])
        let renamed = TaskifyWatchChatWidgetSnapshot(conversations: [
            conversation(alice, "Alicia"), conversation(bob, "Bob"),
        ])
        XCTAssertTrue(first.hasSameDirectory(as: reordered))
        XCTAssertFalse(first.hasSameDirectory(as: renamed))
    }

    func testConversationLookupAndSearch() {
        let snapshot = TaskifyWatchChatWidgetSnapshot(conversations: [
            conversation(alice, "Alice"), conversation(bob, "Bob"),
        ])
        XCTAssertEqual(snapshot.conversation(id: alice.uppercased())?.displayName, "Alice")
        XCTAssertNil(snapshot.conversation(id: String(repeating: "c", count: 64)))
        XCTAssertEqual(snapshot.conversations(matching: "ALI").map(\.displayName), ["Alice"])
        XCTAssertEqual(snapshot.conversations(matching: "  ").count, 2)
    }

    /// The snapshot sits outside the complete-protection chat store, so its encoded form is part
    /// of the privacy contract: names and counts only.
    func testSnapshotEncodingCarriesOnlyNamesAndCounts() throws {
        let data = try JSONEncoder().encode(TaskifyWatchChatWidgetSnapshot(
            unreadCount: 1,
            conversations: [conversation(alice, "Alice", unread: 1)]
        ))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["unreadCount", "conversations"])
        let row = try XCTUnwrap((object["conversations"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(row.keys), ["id", "displayName", "unreadCount", "isGroup"])
    }
}
