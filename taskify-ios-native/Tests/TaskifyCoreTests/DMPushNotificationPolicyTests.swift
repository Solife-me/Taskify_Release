import Foundation
import XCTest
@testable import TaskifyCore

final class DMPushNotificationPolicyTests: XCTestCase {
    private let sender = try! NostrIdentity(privateKey: Data(repeating: 0x11, count: 32))
    private let recipient = try! NostrIdentity(privateKey: Data(repeating: 0x22, count: 32))

    func testSelectionsAllowOnlyTheirConfiguredCategories() {
        XCTAssertTrue(DMPushNotificationSelection.messages.allows(.message))
        XCTAssertFalse(DMPushNotificationSelection.messages.allows(.paymentReceived))
        XCTAssertFalse(DMPushNotificationSelection.payments.allows(.message))
        XCTAssertTrue(DMPushNotificationSelection.payments.allows(.paymentReceived))
        XCTAssertTrue(DMPushNotificationSelection.both.allows(.message))
        XCTAssertTrue(DMPushNotificationSelection.both.allows(.paymentReceived))
    }

    func testIncomingEcashIsClassifiedAsPaymentInsteadOfMessage() {
        let payment = """
        {"id":"native-request","mint":"https://mint.example","unit":"sat","proofs":[{
          "amount":1,
          "secret":"test-secret",
          "C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          "id":"009a1f293253e41e"
        }]}
        """

        XCTAssertEqual(DMPushNotificationPolicy.category(forIncomingContent: payment), .paymentReceived)
        XCTAssertEqual(DMPushNotificationPolicy.category(forIncomingContent: "Hello"), .message)
    }

    func testRichPreviewUsesCachedSenderNameAndFirstThreeMessageLines() throws {
        let contact = try XCTUnwrap(NostrContact(
            publicKeyValue: sender.publicKeyHex,
            petname: "Alice"
        ))
        XCTAssertEqual(
            DMPushNotificationPreviewPolicy.presentation(
                for: try incomingRumor(kind: NIP17GiftWrap.rumorKind, content: "One\nTwo\nThree\nFour"),
                identityPublicKey: recipient.publicKeyHex,
                contacts: [contact],
                selection: .both
            ),
            .activity(title: "Alice", subtitle: nil, body: "One\nTwo\nThree")
        )
    }

    func testRichPreviewIdentifiesAnUncachedSenderByShortNpub() throws {
        let npub = try XCTUnwrap(NostrPublicKey.npub(from: sender.publicKey))
        XCTAssertEqual(
            DMPushNotificationPreviewPolicy.presentation(
                for: try incomingRumor(kind: NIP17GiftWrap.rumorKind, content: "Hello"),
                identityPublicKey: recipient.publicKeyHex,
                contacts: [],
                selection: .messages
            ),
            .activity(
                title: "Unknown sender",
                subtitle: "\(npub.prefix(12))…\(npub.suffix(6))",
                body: "Hello"
            )
        )
    }

    func testRichPreviewFormatsReactionsAndTaskAssignments() throws {
        let reaction = try incomingRumor(
            kind: 7,
            content: "👍",
            extraTags: [["e", String(repeating: "e", count: 64)]]
        )
        XCTAssertEqual(
            DMPushNotificationPreviewPolicy.presentation(
                for: reaction,
                identityPublicKey: recipient.publicKeyHex,
                contacts: [],
                selection: .both
            )?.body,
            "Reacted 👍"
        )

        let assignment = TaskifyShareEnvelope(
            item: .task(SharedTaskDelivery(
                title: "Prepare release notes",
                sourceTaskID: "task-1",
                assignment: true
            ))
        )
        XCTAssertEqual(
            DMPushNotificationPreviewPolicy.presentation(
                for: try incomingRumor(
                    kind: NIP17GiftWrap.rumorKind,
                    content: assignment.messageContent()
                ),
                identityPublicKey: recipient.publicKeyHex,
                contacts: [],
                selection: .messages
            )?.body,
            "New task assignment: Prepare release notes"
        )
    }

    func testPaymentWrapIsLeftForPostRedemptionNotification() throws {
        let payment = """
        {"id":"native-request","mint":"https://mint.example","unit":"sat","proofs":[{
          "amount":1,"secret":"test-secret",
          "C":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          "id":"009a1f293253e41e"
        }]}
        """
        XCTAssertNil(DMPushNotificationPreviewPolicy.presentation(
            for: try incomingRumor(kind: NIP17GiftWrap.rumorKind, content: payment),
            identityPublicKey: recipient.publicKeyHex,
            contacts: [],
            selection: .both
        ))
    }

    func testRichPreviewSuppressesMessageActivityWhenOnlyPaymentsAreEnabled() throws {
        XCTAssertNil(DMPushNotificationPreviewPolicy.presentation(
            for: try incomingRumor(kind: NIP17GiftWrap.rumorKind, content: "Hello"),
            identityPublicKey: recipient.publicKeyHex,
            contacts: [],
            selection: .payments
        ))
    }

    private func incomingRumor(
        kind: Int,
        content: String,
        extraTags: [[String]] = []
    ) throws -> NIP17DecryptedRumor {
        let rumor = try NIP17Rumor(
            publicKey: sender.publicKeyHex,
            createdAt: 1_700_000_000,
            kind: kind,
            tags: [["p", recipient.publicKeyHex]] + extraTags,
            content: content
        )
        return NIP17DecryptedRumor(
            wrapEventID: String(repeating: "a", count: 64),
            rumor: rumor
        )
    }
}
