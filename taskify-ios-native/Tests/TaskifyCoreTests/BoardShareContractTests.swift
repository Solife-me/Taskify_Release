import Foundation
import Testing
@testable import TaskifyCore

@Suite("BoardShareContract")
struct BoardShareContractTests {

    @Test("parses bare board ids")
    func parsesBareBoardIds() {
        let payload = BoardShareContract.parse("123e4567-e89b-12d3-a456-426614174000")
        #expect(payload == BoardSharePayload(boardId: "123e4567-e89b-12d3-a456-426614174000"))
    }

    @Test("builds and parses PWA-compatible share envelopes")
    func envelopeRoundTrip() {
        let raw = BoardShareContract.buildEnvelopeString(
            boardId: "123e4567-e89b-12d3-a456-426614174000",
            boardName: "Team Board",
            relays: [" wss://relay.example ", "wss://relay.example", "wss://relay.two"]
        )

        let payload = BoardShareContract.parse(raw)

        #expect(payload == BoardSharePayload(
            boardId: "123e4567-e89b-12d3-a456-426614174000",
            boardName: "Team Board",
            relays: ["wss://relay.example", "wss://relay.two"]
        ))
    }

    @Test("parses embedded Taskify-Share payloads")
    func embeddedPayload() {
        let json = BoardShareContract.buildEnvelopeString(
            boardId: "123e4567-e89b-12d3-a456-426614174000",
            boardName: "Template"
        )
        let data = Data(json.utf8)
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        let payload = BoardShareContract.parse("Taskify-Share: \(encoded)")

        #expect(payload?.boardId == "123e4567-e89b-12d3-a456-426614174000")
        #expect(payload?.boardName == "Template")
    }
}
