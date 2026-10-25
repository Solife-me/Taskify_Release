import Foundation
import XCTest
@testable import TaskifyCore

/// Calendar invitation secrets shared with the PWA and CLI. `event-invitation-vectors.json` is
/// written by taskify-core (`tests/event-invitation-vectors.test.ts`) from `planEventInvitations`.
final class EventInvitationVectorTests: XCTestCase {
    struct Input: Decodable {
        var eventKey: String?
        var inviteTokens: [String: String]?
        var participantPubkeys: [String]
        var previousPubkeys: [String]
        var senderPubkey: String?
    }

    struct Expected: Decodable {
        var eventKey: String
        var inviteTokens: [String: String]?
        var inviteePubkeys: [String]
        var addedPubkeys: [String]
    }

    struct Vector: Decodable {
        var name: String
        var input: Input
        var expected: Expected
    }

    struct VectorFile: Decodable {
        var vectors: [Vector]
    }

    func testIOSPlansInvitationsLikeThePWAAndCLI() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TaskifyCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // taskify-ios-native
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("taskify-core/fixtures/event-invitation-vectors.json")
        let vectors = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url)).vectors
        XCTAssertFalse(vectors.isEmpty)

        for vector in vectors {
            let input = vector.input
            let event = TaskifyEvent(
                id: "event-1",
                boardID: "board-1",
                title: "Vector",
                participants: input.previousPubkeys.map { TaskifyEventParticipant(publicKey: $0) },
                schedule: .time,
                startISO: "2026-11-01T15:00:00Z",
                endISO: "2026-11-01T16:00:00Z",
                canonicalAddress: "",
                viewAddress: "",
                eventKey: input.eventKey ?? "",
                inviteToken: "",
                inviteTokens: input.inviteTokens,
                relayURLs: [],
                rsvpStatus: .accepted
            )
            var generated = 0
            let plan = TaskifyEventInvitationPlanner.prepare(
                event: event,
                participants: input.participantPubkeys.map { TaskifyEventParticipant(publicKey: $0) },
                previousParticipants: input.previousPubkeys.map { TaskifyEventParticipant(publicKey: $0) },
                senderPublicKey: input.senderPubkey,
                generateInviteToken: {
                    generated += 1
                    return "token-\(generated)"
                }
            )

            XCTAssertEqual(plan.event.inviteTokens, vector.expected.inviteTokens, vector.name)
            XCTAssertEqual(plan.event.participants?.map(\.publicKey) ?? [], vector.expected.inviteePubkeys, vector.name)
            XCTAssertEqual(plan.addedRecipientPublicKeys, vector.expected.addedPubkeys, vector.name)
            let keyKept = plan.event.eventKey == (input.eventKey ?? "")
            XCTAssertEqual(keyKept ? "kept" : "generated", vector.expected.eventKey, vector.name)
        }
    }
}
