import Foundation
import XCTest
@testable import TaskifyCore

final class AccountBackupTests: XCTestCase {
    private let privateKeyHex = String(repeating: "0", count: 63) + "1"
    private let publicKeyHex = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    private let encryptedFixture = "AgABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fb8bW1O1bRFTC9VHEkeKEaQ52KRsQ4k/8ndFE0CmQgEH2ktB0C+CWSSkh3J7wJ3El0Oeb9yKnfwrBg88f652Qn119+oKCD1ofquSVpux9lUDsX8XE/JtwKBX17PbLwTljqOmTv1F4dWihin3/gCAM4+koX8dKpltkNH3zs3JbUYZrPvj8vGozumZLh0G0qIuGw9Y3z0gK+E5HETdknUk6TVxc4BAbb07ts/EAIKZKf8Y1Bpf8a5AcuQYQUaw7qqkiEiMrCcIfulsxV7pDeMxMYZ0BXKXWAjCS65yGZmouusxZB/HIbsDobNIUmlNmRlJAyEbSDsolayMcNm/iZ1rR7kVok6yhBpRqrM0XcV72Deisp7yYHGaB80OdPGjP/Sogyb1hqQMTemYpj8pD48eMCvy+ytLV4LKmFxo1iMsnFliWNhbJApmfSh8SizYvldZxqMIoKT1n/3K8M6NcVxYM+3GUlx/cMf7vl5tP5rF605UBwOZAabZUqc5d8ZtJSVqcUte1RLO71KNOLKI//wfiS5XwwROGospdiaYPypQESgSU8w=="

    func testDecryptsPWANIP44V2Fixture() throws {
        let privateKey = try Data(hex: privateKeyHex)
        let plaintext = try NIP44V2.decrypt(
            encryptedFixture,
            privateKey: privateKey,
            publicKey: try Data(hex: publicKeyHex)
        )
        let payload = try JSONDecoder().decode(NostrAppBackupPayload.self, from: plaintext)

        XCTAssertEqual(payload.version, 1)
        XCTAssertEqual(payload.timestamp, 1_700_000_000)
        XCTAssertEqual(payload.boards.first?.name, "Family Week")
        XCTAssertEqual(payload.boards.first?.nostrID, "shared-board-id")
        XCTAssertEqual(payload.defaultRelayURLs, ["wss://relay.solife.me"])
        XCTAssertEqual(payload.settings["nostrBackupEnabled"], .boolean(true))
    }

    func testEncryptsExactlyLikePWANIP44V2Fixture() throws {
        let plaintext = Data(#"{"version":1,"timestamp":1700000000,"boards":[{"id":"pwa-week","nostrId":"shared-board-id","relays":["wss://relay.solife.me"],"name":"Family Week","kind":"week","order":0}],"settings":{"nostrBackupEnabled":true},"walletSeed":{"type":"nut13-wallet-backup","version":1,"mnemonic":"do not import","counters":{}},"defaultRelays":["wss://relay.solife.me"]}"#.utf8)
        let nonce = Data((0..<32).map(UInt8.init))

        let encrypted = try NIP44V2.encrypt(
            plaintext,
            privateKey: Data(hex: privateKeyHex),
            publicKey: Data(hex: publicKeyHex),
            nonce: nonce
        )

        XCTAssertEqual(encrypted, encryptedFixture)
    }

    func testNIP44RejectsTamperedCiphertext() throws {
        var raw = try XCTUnwrap(Data(base64Encoded: encryptedFixture))
        raw[50] ^= 0x01
        XCTAssertThrowsError(try NIP44V2.decrypt(
            raw.base64EncodedString(),
            privateKey: Data(hex: privateKeyHex),
            publicKey: Data(hex: publicKeyHex)
        )) { error in
            XCTAssertEqual(error as? NIP44V2Error, .authenticationFailed)
        }
    }

    func testBackupContractVerifiesAndDecodesPWAEvent() throws {
        let privateKey = try Data(hex: privateKeyHex)
        let identity = try NostrIdentity(privateKey: privateKey)
        let event = try NostrEvent.signed(
            privateKey: privateKey,
            createdAt: 1_700_000_000,
            kind: NostrAppBackupContract.eventKind,
            tags: [
                ["d", NostrAppBackupContract.eventDTag],
                ["client", "taskify.app"],
            ],
            content: encryptedFixture
        )

        let payload = try NostrAppBackupContract.decode(event: event, identity: identity)
        XCTAssertEqual(payload.boards.map(\.id), ["pwa-week"])

        var wrongTag = event
        wrongTag.tags = [["d", "some-other-backup"]]
        XCTAssertThrowsError(try NostrAppBackupContract.decode(event: wrongTag, identity: identity))
    }

    func testNativeBackupEventRoundTripsThroughPWAContract() throws {
        let identity = try NostrIdentity(privateKey: Data(hex: privateKeyHex))
        let payload = NostrAppBackupPayload(
            timestamp: 1,
            boards: [NostrAppBackupBoard(
                id: "native-board",
                nostrID: "native-nostr-board",
                name: "Native Board",
                kind: .list,
                preservedFields: ["futureBoardOption": .string("keep")]
            )],
            settings: ["futureSetting": .boolean(true)],
            walletSeed: .object(["mnemonic": .string("keep encrypted")]),
            defaultRelayURLs: ["wss://relay.solife.me"],
            preservedFields: ["futureRootValue": .integer(42)]
        )
        let event = try NostrAppBackupContract.event(
            payload: payload,
            identity: identity,
            createdAt: 1_700_000_100,
            nonce: Data((0..<32).map(UInt8.init))
        )

        XCTAssertTrue(event.verify())
        XCTAssertEqual(event.kind, NostrAppBackupContract.eventKind)
        XCTAssertEqual(event.firstTagValue(named: "d"), NostrAppBackupContract.eventDTag)
        let decoded = try NostrAppBackupContract.decode(event: event, identity: identity)
        XCTAssertEqual(decoded.timestamp, 1_700_000_100)
        XCTAssertEqual(decoded.walletSeed, payload.walletSeed)
        XCTAssertEqual(decoded.settings, payload.settings)
        XCTAssertEqual(decoded.preservedFields, payload.preservedFields)
        XCTAssertEqual(decoded.boards.first?.preservedFields, payload.boards.first?.preservedFields)
    }

    func testBackupPatchPreservesUnsupportedAndConcurrentRemoteData() throws {
        let raw = #"{"version":1,"timestamp":1700000000,"boards":[{"id":"existing","nostrId":"nostr-existing","name":"Old Name","kind":"lists","futureBoardOption":{"mode":"keep"}},{"id":"deleted","nostrId":"nostr-deleted","name":"Deleted Native Board","kind":"week"},{"id":"remote-new","nostrId":"nostr-remote-new","name":"Concurrent PWA Board","kind":"week"},{"id":"future","nostrId":"nostr-future","name":"Future Board","kind":"kanban","lanes":["one"]}],"settings":{"futureSetting":true},"walletSeed":{"mnemonic":"preserve me"},"defaultRelays":["wss://relay.solife.me"],"futureRootValue":42}"#
        let baseline = try JSONDecoder().decode(
            NostrAppBackupPayload.self,
            from: Data(raw.utf8)
        )
        let nativeBoards = [
            Board(
                id: "native-existing",
                name: "Renamed Natively",
                kind: .list,
                columns: [BoardColumn(id: "items", name: "Items", order: 0)],
                nostrBoardID: "nostr-existing",
                relayURLs: ["wss://nos.lol"]
            ),
            Board(
                id: "native-added",
                name: "Added Natively",
                kind: .week,
                nostrBoardID: "nostr-added",
                relayURLs: ["wss://relay.solife.me"]
            ),
        ]

        let updated = baseline.updatingNativeBoards(
            nativeBoards,
            managedNostrBoardIDs: ["nostr-existing", "nostr-deleted"],
            timestamp: 1_700_000_100
        )

        XCTAssertEqual(updated.walletSeed, baseline.walletSeed)
        XCTAssertEqual(updated.settings, baseline.settings)
        XCTAssertEqual(updated.preservedFields["futureRootValue"], .integer(42))
        XCTAssertFalse(updated.boards.contains { $0.nostrID == "nostr-deleted" })
        XCTAssertTrue(updated.boards.contains { $0.nostrID == "nostr-remote-new" })
        XCTAssertTrue(updated.boards.contains { $0.nostrID == "nostr-future" })
        XCTAssertTrue(updated.boards.contains { $0.nostrID == "nostr-added" })
        let existing = try XCTUnwrap(updated.boards.first { $0.nostrID == "nostr-existing" })
        XCTAssertEqual(existing.name, "Renamed Natively")
        XCTAssertEqual(existing.relayURLs, ["wss://nos.lol"])
        XCTAssertEqual(
            existing.preservedFields["futureBoardOption"],
            .object(["mode": .string("keep")])
        )
        let future = try XCTUnwrap(updated.boards.first { $0.nostrID == "nostr-future" })
        XCTAssertFalse(future.isSupportedByNative)
        XCTAssertEqual(future.preservedFields["kind"], .string("kanban"))
        XCTAssertEqual(future.preservedFields["lanes"], .array([.string("one")]))
    }

    func testReviewAndMergePreserveLocalDataWhileAddingCompatibleBoards() {
        let existing = Board.week(id: "native-week", name: "My Native Week")
        let localTask = TaskItem(id: "local-task", boardID: existing.id, title: "Keep me")
        var snapshot = TaskifySnapshot(
            boards: [existing],
            tasks: [localTask],
            selectedBoardID: existing.id
        )
        let existingNostrID = snapshot.boards[0].effectiveNostrBoardID
        let payload = NostrAppBackupPayload(
            timestamp: 1_700_000_000,
            boards: [
                NostrAppBackupBoard(
                    id: "existing-pwa-id",
                    nostrID: existingNostrID,
                    relayURLs: ["wss://relay.solife.me"],
                    name: "Do not overwrite my local name",
                    kind: .week
                ),
                NostrAppBackupBoard(
                    id: "pwa-list",
                    nostrID: "nostr-list",
                    name: "Groceries",
                    kind: .list,
                    order: 1,
                    columns: [NostrAppBackupColumn(id: "produce", name: "Produce")]
                ),
                NostrAppBackupBoard(
                    id: "pwa-compound",
                    nostrID: "nostr-compound",
                    name: "Home",
                    kind: .compound,
                    order: 2,
                    children: ["pwa-list"]
                ),
                NostrAppBackupBoard(
                    id: "pwa-bible",
                    nostrID: "nostr-bible",
                    name: "Bible",
                    kind: .bible
                ),
            ],
            settings: ["accent": .string("orange")],
            walletSeed: .object(["mnemonic": .string("never import")]),
            defaultRelayURLs: ["wss://nos.lol"]
        )

        let review = NostrAppBackupReview(payload: payload, currentBoards: snapshot.boards)
        XCTAssertEqual(review.importableBoardCount, 2)
        XCTAssertEqual(review.alreadyConnectedBoardCount, 1)
        XCTAssertEqual(review.unsupportedBoardCount, 1)
        XCTAssertTrue(review.containsWalletSeed)
        XCTAssertTrue(review.containsPWASettings)

        let result = snapshot.mergePWAAccountBackup(payload)
        XCTAssertEqual(result.importedBoardCount, 2)
        XCTAssertEqual(result.updatedBoardCount, 1)
        XCTAssertEqual(result.skippedBoardCount, 1)
        XCTAssertEqual(snapshot.tasks, [localTask])
        XCTAssertEqual(snapshot.boards.first?.name, "My Native Week")
        XCTAssertEqual(snapshot.boards.first?.effectiveRelayURLs, ["wss://relay.solife.me"])

        let list = snapshot.boards.first { $0.effectiveNostrBoardID == "nostr-list" }
        let compound = snapshot.boards.first { $0.effectiveNostrBoardID == "nostr-compound" }
        XCTAssertEqual(list?.name, "Groceries")
        XCTAssertEqual(list?.columns.map(\.id), ["produce"])
        XCTAssertEqual(compound?.children, [list?.id].compactMap { $0 })
        XCTAssertFalse(snapshot.boards.contains { $0.effectiveNostrBoardID == "nostr-bible" })
    }
}
