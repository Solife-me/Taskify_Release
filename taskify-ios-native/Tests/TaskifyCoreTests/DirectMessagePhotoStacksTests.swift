import XCTest
@testable import TaskifyCore

final class DirectMessagePhotoStacksTests: XCTestCase {
    private let peer = String(repeating: "1", count: 64)
    private let me = String(repeating: "2", count: 64)

    private func message(
        _ id: Int,
        at time: Int,
        incoming: Bool = true,
        mimeType: String? = "image/png",
        replyTo: String? = nil
    ) -> NostrDirectMessage {
        let attachment = mimeType.flatMap {
            NostrDirectMessageAttachment(
                url: "https://files.example/\(id)",
                mimeType: $0,
                keyHex: String(repeating: "11", count: 32),
                nonceHex: String(repeating: "22", count: 16)
            )
        }
        return NostrDirectMessage(
            rumorEventID: String(format: "%064x", id),
            wrapEventID: String(format: "%064x", id + 10_000),
            peerPublicKey: peer,
            senderPublicKey: incoming ? peer : me,
            content: attachment?.url ?? "Text \(id)",
            createdAt: time,
            isIncoming: incoming,
            replyToEventID: replyTo,
            attachment: attachment
        )
    }

    func testBackToBackPhotosStackUnderTheNewest() {
        let photos = [message(1, at: 100), message(2, at: 101), message(3, at: 102)]
        let grouping = DirectMessagePhotoStacks.group(photos)
        XCTAssertEqual(grouping.stacks[photos[2].id]?.map(\.id), photos.map(\.id))
        XCTAssertEqual(grouping.stackedMessageIDs, [photos[0].id, photos[1].id])
    }

    func testRunsBreakOnTextSenderReplyGapAndNonMessages() {
        let a = message(1, at: 100)
        let b = message(2, at: 101)
        let text = message(3, at: 102, mimeType: nil)
        let c = message(4, at: 103)
        let d = message(5, at: 104, incoming: false)
        let e = message(6, at: 105, incoming: false)
        let late = message(7, at: 105 + DirectMessagePhotoStacks.maximumGap + 1, incoming: false)
        let reply = message(8, at: 300, incoming: false, replyTo: String(repeating: "9", count: 64))
        let pdf = message(9, at: 301, incoming: false, mimeType: "application/pdf")
        let f = message(10, at: 400)
        let g = message(11, at: 401)
        let grouping = DirectMessagePhotoStacks.group([a, b, text, c, d, e, late, reply, pdf, f, nil, g])
        XCTAssertEqual(grouping.stacks.count, 2)
        XCTAssertEqual(grouping.stacks[b.id]?.map(\.id), [a.id, b.id])
        XCTAssertEqual(grouping.stacks[e.id]?.map(\.id), [d.id, e.id], "A different sender starts a new run")
        XCTAssertEqual(grouping.stackedMessageIDs, [a.id, d.id])
    }

    func testAttachmentLabelsDescribeTheFile() throws {
        let pdf = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://files.example/doc",
            mimeType: "application/pdf",
            filename: "Itinerary.pdf",
            size: 71 * 1_024,
            keyHex: String(repeating: "11", count: 32),
            nonceHex: String(repeating: "22", count: 16)
        ))
        XCTAssertEqual(pdf.fileExtensionLabel, "PDF")
        XCTAssertTrue(pdf.kindAndSizeLabel.hasPrefix("PDF"), pdf.kindAndSizeLabel)
        XCTAssertTrue(pdf.kindAndSizeLabel.contains("KB"), pdf.kindAndSizeLabel)
        let photo = try XCTUnwrap(NostrDirectMessageAttachment(
            url: "https://files.example/photo",
            mimeType: "image/png",
            keyHex: String(repeating: "11", count: 32),
            nonceHex: String(repeating: "22", count: 16)
        ))
        XCTAssertEqual(photo.fileExtensionLabel, "PNG", "A filename-less attachment falls back to its type")
    }
}
