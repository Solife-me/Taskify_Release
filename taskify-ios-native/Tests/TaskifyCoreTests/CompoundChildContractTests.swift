import Foundation
import Testing
@testable import TaskifyCore

@Suite("CompoundChildContract")
struct CompoundChildContractTests {

    @Test("parses board ids with relay suffixes")
    func parsesBoardIdsWithRelaySuffixes() {
        let payload = CompoundChildContract.parse("child-board@wss://a.example,wss://b.example")

        #expect(payload == CompoundChildPayload(
            boardId: "child-board",
            relays: ["wss://a.example", "wss://b.example"]
        ))
    }

    @Test("parses board ids followed by relay whitespace")
    func parsesBoardIdsWithWhitespaceRelaySuffixes() {
        let payload = CompoundChildContract.parse("child-board wss://a.example wss://b.example")

        #expect(payload == CompoundChildPayload(
            boardId: "child-board",
            relays: ["wss://a.example", "wss://b.example"]
        ))
    }

    @Test("accepts Taskify share payloads")
    func parsesTaskifySharePayloads() {
        let raw = BoardShareContract.buildEnvelopeString(
            boardId: "123e4567-e89b-12d3-a456-426614174000",
            boardName: "Child Board",
            relays: ["wss://relay.example"]
        )

        let payload = CompoundChildContract.parse(raw)

        #expect(payload == CompoundChildPayload(
            boardId: "123e4567-e89b-12d3-a456-426614174000",
            boardName: "Child Board",
            relays: ["wss://relay.example"]
        ))
    }
}
