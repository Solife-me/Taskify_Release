import Foundation
import XCTest
@testable import TaskifyCore

final class ShareMessageReconciliationTests: XCTestCase {
    func testIdlePartialReceiptDoesNotRepeatedlyInvalidateSnapshot() {
        let parent = message(id: "1", at: 100, state: .sent)
        var comment = message(id: "2", at: 100, state: .queued)
        comment.replyToEventID = parent.rumorEventID
        let observer = SnapshotObserver()
        observer.apply([parent, comment])
        XCTAssertEqual(observer.writes, 1)
        XCTAssertEqual(observer.snapshot.directMessageHistory.map(\.rumorEventID), [parent.rumorEventID, comment.rumorEventID])
        // Models repeated refreshes while the attachment is accepted but its
        // comment or sender copy still awaits a relay. There must be no feedback.
        for _ in 0..<100 { observer.apply([parent, comment]) }
        XCTAssertEqual(observer.writes, 1)
        comment.deliveryState = .sent
        observer.apply([parent, comment])
        XCTAssertEqual(observer.writes, 2)
        for _ in 0..<100 { observer.apply([parent, comment]) }
        XCTAssertEqual(observer.writes, 2)
    }

    /// Chat keeps complete history (paged in the UI), so a receipt for a message older than
    /// everything loaded is inserted once. Reconciling the same receipt again must be a no-op,
    /// or every share-state refresh would write the snapshot and trigger another.
    func testOldReceiptBehindLongHistoryIsInsertedOnceWithoutRepeatRefreshes() throws {
        var snapshot = TaskifySnapshot.empty
        snapshot.directMessages = (1...400).map { index in
            NostrDirectMessage(rumorEventID: String(format: "%064x", index),
                wrapEventID: String(format: "%064x", index + 400),
                peerPublicKey: String(repeating: "a", count: 64), senderPublicKey: String(repeating: "b", count: 64),
                content: "Synthetic message", createdAt: 100 + index, isIncoming: false, deliveryState: .sent)
        }
        let receipt = message(id: "f", at: 1, state: .sent)
        let updated = try XCTUnwrap(snapshot.reconcilingSharedMessages([receipt]))
        XCTAssertEqual(updated.directMessages?.count, 401)
        XCTAssertEqual(updated.directMessages?.first?.rumorEventID, receipt.rumorEventID)
        XCTAssertNil(updated.reconcilingSharedMessages([receipt]))
    }

    func testStaleQueuedReceiptCannotDowngradeConfirmedMessage() throws {
        let sent = message(id: "1", at: 100, state: .sent)
        let snapshot = try XCTUnwrap(TaskifySnapshot.empty.reconcilingSharedMessages([sent]))
        var stale = sent
        stale.deliveryState = .queued
        XCTAssertNil(snapshot.reconcilingSharedMessages([stale]))
    }

    func testSuppressedReceiptsStaySuppressedAndEmptyQueueIsIdle() {
        let sent = message(id: "1", at: 100, state: .sent)
        var snapshot = TaskifySnapshot.empty
        snapshot.directMessageDeletedEventIDs = [sent.rumorEventID: 200]
        XCTAssertNil(snapshot.reconcilingSharedMessages([sent], now: 150))
        XCTAssertNil(snapshot.reconcilingSharedMessages([], now: 150))
        XCTAssertNil(snapshot.directMessages)
    }

    private func message(id: String, at time: Int, state: NostrDirectMessageDeliveryState) -> NostrDirectMessage {
        NostrDirectMessage(rumorEventID: String(repeating: id, count: 64),
            wrapEventID: String(repeating: id, count: 64),
            peerPublicKey: String(repeating: "a", count: 64), senderPublicKey: String(repeating: "b", count: 64),
            content: "Synthetic message", createdAt: time, isIncoming: false, deliveryState: state)
    }

    private final class SnapshotObserver {
        var writes = 0
        var snapshot = TaskifySnapshot.empty { didSet { writes += 1 } }
        func apply(_ messages: [NostrDirectMessage]) {
            if let updated = snapshot.reconcilingSharedMessages(messages) { snapshot = updated }
        }
    }
}
