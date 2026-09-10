import Foundation
import XCTest
import TaskifyWatchShared
@testable import TaskifyWatchChatRuntime

final class TaskifyWatchViewCacheTests: XCTestCase {
    func testMarkdownReusesExactTextButDoesNotRetainViewStyling() {
        var documents = 0
        var inlines = 0
        let cache = TaskifyWatchMarkdownCache(parseDocument: {
            documents += 1
            return NostrChatMarkdown.document($0)
        }, parseInline: {
            inlines += 1
            return NostrChatMarkdown.inlineAttributedString($0)
        })
        let original = cache.document("**Hello**")
        XCTAssertEqual(cache.document("**Hello**"), original)
        XCTAssertEqual(documents, 1)
        XCTAssertNotEqual(cache.document("**Updated**"), original)
        XCTAssertEqual(documents, 2)
        var styled = cache.inline("Hello")
        styled.link = URL(string: "https://example.com")
        XCTAssertNil(cache.inline("Hello").link)
        XCTAssertEqual(inlines, 1)
        cache.clear()
        _ = cache.document("**Hello**")
        _ = cache.inline("Hello")
        XCTAssertEqual(documents, 3)
        XCTAssertEqual(inlines, 2)
    }

    private func task(_ id: String, due: Date) -> TaskifyWatchTask {
        TaskifyWatchTask(id: id, title: id, boardID: "board", boardName: "Board",
                         columnName: nil, dueDate: due, dueTimeEnabled: true, priority: nil, order: 0)
    }

    func testTaskListsTrackMidnightTimezoneAndPendingCompletions() throws {
        let parse = ISO8601DateFormatter()
        let before = try XCTUnwrap(parse.date(from: "2026-09-01T23:50:00Z"))
        let after = try XCTUnwrap(parse.date(from: "2026-09-02T00:15:00Z"))
        let first = task("first", due: before.addingTimeInterval(-60))
        let second = task("second", due: after.addingTimeInterval(-60))
        let snapshot = TaskifyWatchSnapshot(tasks: [first, second], boards: [
            TaskifyWatchBoard(id: "board", name: "Board", openTaskCount: 20),
        ])
        let index = TaskifyWatchTaskIndex(snapshot: snapshot, pendingCompletions: [])
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        XCTAssertEqual(index.dayLists(now: before, calendar: utc).today.map(\.id), ["first"])
        XCTAssertEqual(index.dayLists(now: before, calendar: utc).upcoming.map(\.id), ["first", "second"])
        XCTAssertEqual(index.dayLists(now: after, calendar: utc).today.map(\.id), ["second"])
        var chicago = utc
        chicago.timeZone = TimeZone(identifier: "America/Chicago")!
        XCTAssertEqual(index.dayLists(now: after, calendar: chicago).today.map(\.id), ["first", "second"])
        let completing = TaskifyWatchTaskIndex(snapshot: snapshot, pendingCompletions: ["second"])
        XCTAssertEqual(completing.tasksByBoard["board"]?.map(\.id), ["first"])
        XCTAssertEqual(completing.openCounts["board"], 19)
        XCTAssertTrue(completing.dayLists(now: after, calendar: utc).today.isEmpty)
    }

    private func message(_ id: String, sender: String = "peer", time: Int) -> TaskifyWatchChatMessage {
        TaskifyWatchChatMessage(rumorID: id, wrapID: "wrap-\(id)", conversationID: "chat",
                                senderPublicKey: sender, memberPublicKeys: ["me", "peer"],
                                content: id, createdAt: time, kind: .text)
    }

    func testChatIndexesPreserveOrderingAndReflectUpdatedReadAndMessageState() {
        var snapshot = TaskifyWatchChatSnapshot(messages: [message("new", time: 20), message("old", time: 10)])
        let first = TaskifyWatchChatIndex(snapshot: snapshot, identity: "me")
        XCTAssertEqual(first.messages(conversationID: "CHAT").map(\.rumorID), ["old", "new"])
        XCTAssertEqual(first.threads.first?.preview, "new")
        XCTAssertEqual(first.unreadCount, 2)
        snapshot.readAt["chat"] = 20
        snapshot.messages.append(message("latest", time: 30))
        let updated = TaskifyWatchChatIndex(snapshot: snapshot, identity: "me")
        XCTAssertEqual(updated.unreadCount, 1)
        XCTAssertEqual(updated.threads.first?.preview, "latest")
        snapshot.messages.removeAll()
        XCTAssertTrue(TaskifyWatchChatIndex(snapshot: snapshot, identity: "me").threads.isEmpty)
    }

    func testGroupAvatarMembersPrioritizeRecentSendersAndProfilePhotos() {
        let snapshot = TaskifyWatchChatSnapshot(contacts: [
            TaskifyWatchContact(
                publicKey: "alice",
                npub: "npub-alice",
                displayName: "Alice",
                avatarURL: URL(string: "https://profiles.example/alice.jpg")
            ),
            TaskifyWatchContact(
                publicKey: "carol",
                npub: "npub-carol",
                displayName: "Carol",
                avatarURL: URL(string: "https://profiles.example/carol.jpg")
            ),
        ])
        let index = TaskifyWatchChatIndex(snapshot: snapshot, identity: "me")

        let members = index.groupAvatarMembers(
            memberPublicKeys: ["me", "alice", "bob", "carol", "dave"],
            recentSenderPublicKeys: ["bob", "outside", "bob"]
        )

        XCTAssertEqual(members.map(\.publicKey), ["bob", "alice", "carol", "me"])
        XCTAssertEqual(members.map(\.displayName), ["?", "Alice", "Carol", "You"])
        XCTAssertNil(members[0].avatarURL)
        XCTAssertNotNil(members[1].avatarURL)
    }

    func testDeliveryExpiresWithoutRebuildingTheIndex() {
        let expiry = Date(timeIntervalSince1970: 2_000)
        let snapshot = TaskifyWatchChatSnapshot(messages: [message("outgoing", sender: "me", time: 10)], outbox: [
            TaskifyWatchChatOutboxEntry(rumorID: "outgoing", conversationID: "chat", wraps: [],
                                       senderPublicKey: "me", expiresAt: expiry),
        ])
        let index = TaskifyWatchChatIndex(snapshot: snapshot, identity: "me")
        XCTAssertEqual(index.messages(conversationID: "chat", now: expiry.addingTimeInterval(-1)).first?.deliveryState, .queued)
        XCTAssertEqual(index.messages(conversationID: "chat", now: expiry).first?.deliveryState, .failed)
    }
}
