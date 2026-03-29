import Foundation
import Testing
@testable import TaskifyCore

@Suite("BoardDefinitionContract")
struct BoardDefinitionContractTests {

    @Test("list board payload encodes and decodes columns")
    func listPayloadRoundTrip() {
        let payload = BoardDefinitionPayload(
            clearCompletedDisabled: true,
            columns: [
                BoardColumn(id: "todo", name: "To Do"),
                BoardColumn(id: "done", name: "Done"),
            ],
            listIndex: true
        )

        let raw = BoardDefinitionCodec.encode(payload)
        let decoded = BoardDefinitionCodec.decode(raw)

        #expect(decoded == payload)
    }

    @Test("compound board payload preserves children and hide flag")
    func compoundPayloadRoundTrip() {
        let payload = BoardDefinitionPayload(
            clearCompletedDisabled: false,
            listIndex: true,
            children: ["board-a", "board-b"],
            hideBoardNames: true
        )

        let raw = BoardDefinitionCodec.encode(payload)
        let decoded = BoardDefinitionCodec.decode(raw)

        #expect(decoded == payload)
    }

    @Test("rich board payload preserves archived hidden and sort fields")
    func richPayloadRoundTrip() {
        let payload = BoardDefinitionPayload(
            name: "Shared board",
            kind: "lists",
            clearCompletedDisabled: true,
            columns: [
                BoardColumn(id: "todo", name: "To Do"),
            ],
            listIndex: false,
            children: [],
            hideBoardNames: false,
            archived: true,
            hidden: false,
            sortMode: "priority",
            sortDirection: "desc",
            version: 1
        )

        let raw = BoardDefinitionCodec.encode(payload)
        let decoded = BoardDefinitionCodec.decode(raw)

        #expect(decoded == payload)
    }

    @Test("missing clear-completed flag decodes to false for legacy compatibility")
    func legacyPayloadDefaultsClearCompletedFlag() {
        let raw = """
        {"kind":"lists","name":"Legacy board","columns":[{"id":"todo","name":"To Do"}]}
        """

        let decoded = BoardDefinitionCodec.decode(raw)

        #expect(decoded?.name == "Legacy board")
        #expect(decoded?.kind == "lists")
        #expect(decoded?.clearCompletedDisabled == false)
        #expect(decoded?.columns == [BoardColumn(id: "todo", name: "To Do")])
    }

    @Test("merged metadata combines tag columns children and sort with payload booleans")
    func mergedMetadataCombinesPayloadAndTags() {
        let payload = BoardDefinitionPayload(
            name: "Payload name",
            kind: "lists",
            clearCompletedDisabled: true,
            columns: [
                BoardColumn(id: "done", name: "Done"),
            ],
            listIndex: true,
            children: ["child-b"],
            hideBoardNames: true,
            archived: false,
            hidden: true,
            sortMode: "alphabetical",
            sortDirection: "desc"
        )
        let tags = [
            ["k", "compound"],
            ["name", "Tag name"],
            ["col", "todo", "To Do"],
            ["ch", "child-a"],
            ["sort", "priority", "asc"],
        ]

        let metadata = BoardDefinitionCodec.mergedMetadata(payload: payload, tags: tags)

        #expect(metadata.name == "Payload name")
        #expect(metadata.kind == "compound")
        #expect(metadata.columns == [
            BoardColumn(id: "todo", name: "To Do"),
            BoardColumn(id: "done", name: "Done"),
        ])
        #expect(metadata.children == ["child-a", "child-b"])
        #expect(metadata.archived == false)
        #expect(metadata.hidden == true)
        #expect(metadata.clearCompletedDisabled == true)
        #expect(metadata.indexCardEnabled == true)
        #expect(metadata.hideChildBoardNames == true)
        #expect(metadata.sortMode == "priority")
        #expect(metadata.sortDirection == "asc")
    }

    @Test("tag-only metadata still resolves when payload is absent")
    func tagOnlyMetadataFallback() {
        let tags = [
            ["k", "lists"],
            ["name", "Shared board"],
            ["col", "items", "Items"],
            ["sort", "manual"],
        ]

        let metadata = BoardDefinitionCodec.mergedMetadata(payload: nil, tags: tags)

        #expect(metadata.name == "Shared board")
        #expect(metadata.kind == "lists")
        #expect(metadata.columns == [BoardColumn(id: "items", name: "Items")])
        #expect(metadata.sortMode == "manual")
        #expect(metadata.sortDirection == "asc")
        #expect(metadata.clearCompletedDisabled == nil)
    }
}
