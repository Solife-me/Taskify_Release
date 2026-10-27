import Foundation
import XCTest
@testable import TaskifyCore

/// Event RSVPs shared with the PWA and CLI. `calendar-rsvp-vectors.json` is written by
/// taskify-core (`tests/calendar-rsvp-vectors.test.ts`) from `calendarRsvp.ts`.
final class CalendarRsvpVectorTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TaskifyCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // taskify-ios-native
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("taskify-core/fixtures/calendar-rsvp-vectors.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func vectors(_ section: String) throws -> [[String: Any]] {
        let vectors = try XCTUnwrap(fixture()[section] as? [[String: Any]], section)
        XCTAssertFalse(vectors.isEmpty, section)
        return vectors
    }

    private func payloadFields(_ payload: CalendarRSVPPayload) -> [String: String] {
        var fields = [
            "v": String(payload.version),
            "eventId": payload.eventID,
            "status": payload.status.rawValue,
            "inviteToken": payload.inviteToken,
        ]
        if let freeBusy = payload.freeBusy { fields["fb"] = freeBusy.rawValue }
        if let note = payload.note { fields["note"] = note }
        return fields
    }

    private func stringFields(_ object: [String: Any]) -> [String: String] {
        object.mapValues { value in (value as? NSNumber).map(\.stringValue) ?? (value as? String) ?? "\(value)" }
    }

    func testIOSDerivesBoardTokensLikeThePWAAndCLI() throws {
        for vector in try vectors("boardTokens") {
            let name = vector["name"] as? String ?? ""
            let input = try XCTUnwrap(vector["input"] as? [String: String], name)
            XCTAssertEqual(
                SharedCalendarRSVPContract.boardRSVPToken(
                    boardID: input["boardId"] ?? "",
                    attendeePublicKey: input["attendeePubkey"] ?? ""
                ),
                vector["expected"] as? String,
                name
            )
        }
    }

    func testIOSPlansRSVPsLikeThePWAAndCLI() throws {
        for vector in try vectors("plans") {
            let name = vector["name"] as? String ?? ""
            let input = try XCTUnwrap(vector["input"] as? [String: Any], name)
            let expected = try XCTUnwrap(vector["expected"] as? [String: Any], name)
            do {
                let plan = try SharedCalendarRSVPContract.plan(
                    canonical: input["canonical"] as? String ?? "",
                    eventID: input["eventId"] as? String ?? "",
                    attendeePublicKey: input["attendeePubkey"] as? String ?? "",
                    status: input["status"] as? String ?? "",
                    inviteToken: input["inviteToken"] as? String,
                    freeBusy: input["fb"] as? String,
                    note: input["note"] as? String
                )
                XCTAssertEqual(expected["kind"] as? String, "ready", name)
                XCTAssertEqual(plan.boardPublicKey, expected["boardPubkey"] as? String, name)
                XCTAssertEqual(plan.canonicalAddress, expected["canonicalAddress"] as? String, name)
                XCTAssertEqual(plan.tags, expected["tags"] as? [[String]], name)
                XCTAssertEqual(payloadFields(plan.payload), stringFields(try XCTUnwrap(expected["payload"] as? [String: Any], name)), name)
            } catch let error as SharedCalendarRSVPContract.PlanError {
                XCTAssertEqual(expected["kind"] as? String, "invalid", name)
                XCTAssertEqual(error.coreMessage, expected["error"] as? String, name)
            }
        }
    }

    func testIOSAcceptsOrganizerResponsesLikeThePWAAndCLI() throws {
        for vector in try vectors("acceptance") {
            let name = vector["name"] as? String ?? ""
            let input = try XCTUnwrap(vector["input"] as? [String: Any], name)
            let rsvp = try XCTUnwrap(input["rsvp"] as? [String: Any], name)
            let event = try XCTUnwrap(input["event"] as? [String: Any], name)
            let expected = try XCTUnwrap(vector["expected"] as? [String: Any], name)
            let payload = try JSONSerialization.data(withJSONObject: try XCTUnwrap(input["payload"], name))
            do {
                let response = try SharedCalendarRSVPContract.accept(
                    kind: rsvp["kind"] as? Int ?? 0,
                    authorPublicKey: rsvp["pubkey"] as? String ?? "",
                    createdAt: rsvp["created_at"] as? Int ?? 0,
                    tags: rsvp["tags"] as? [[String]] ?? [],
                    payload: payload,
                    eventID: event["id"] as? String ?? "",
                    canonicalAddress: event["canonicalAddress"] as? String ?? "",
                    inviteTokens: event["inviteTokens"] as? [String: String],
                    boardToken: input["boardToken"] as? String ?? ""
                )
                XCTAssertEqual(expected["accepted"] as? Bool, true, name)
                let fields = try XCTUnwrap(expected["response"] as? [String: Any], name)
                XCTAssertEqual(response.eventID, fields["eventId"] as? String, name)
                XCTAssertEqual(response.authorPublicKey, fields["attendeePubkey"] as? String, name)
                XCTAssertEqual(response.createdAt, fields["createdAt"] as? Int, name)
                XCTAssertEqual(response.status.rawValue, fields["status"] as? String, name)
                XCTAssertEqual(response.inviteToken, fields["inviteToken"] as? String, name)
                XCTAssertEqual(response.freeBusy?.rawValue, fields["fb"] as? String, name)
                XCTAssertEqual(response.note, fields["note"] as? String, name)
            } catch let rejection as SharedCalendarRSVPContract.Rejection {
                XCTAssertEqual(expected["accepted"] as? Bool, false, name)
                XCTAssertEqual(rejection.rawValue, expected["reason"] as? String, name)
            }
        }
    }

    func testIOSKeepsTheNewestResponseLikeThePWAAndCLI() throws {
        func response(_ fields: [String: Any]) -> TaskifyEventRSVPResponse {
            TaskifyEventRSVPResponse(
                eventID: fields["eventId"] as? String ?? "",
                authorPublicKey: fields["attendeePubkey"] as? String ?? "",
                createdAt: fields["createdAt"] as? Int ?? 0,
                status: SharedInboxItemStatus(rawValue: fields["status"] as? String ?? "") ?? .pending,
                inviteToken: fields["inviteToken"] as? String ?? ""
            )
        }
        for vector in try vectors("latest") {
            let name = vector["name"] as? String ?? ""
            let input = (vector["input"] as? [[String: Any]] ?? []).map(response)
            let expected = (vector["expected"] as? [[String: Any]] ?? []).map(response)
            XCTAssertEqual(SharedCalendarRSVPContract.latestResponses(input), expected, name)
        }
    }
}
