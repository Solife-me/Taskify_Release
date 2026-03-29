import Foundation
import Testing
@testable import TaskifyCore

@Suite("BoardScopeResolver")
struct BoardScopeResolverTests {

    @Test("compound boards include parent and child board IDs")
    func compoundBoardsIncludeParentAndChildren() {
        let ids = BoardScopeResolver.scopedBoardIDs(
            currentBoardId: "compound-board",
            kind: "compound",
            childBoardIDs: ["child-a", "child-b"]
        )

        #expect(ids == ["compound-board", "child-a", "child-b"])
    }

    @Test("non-compound boards keep only their own ID")
    func nonCompoundBoardsKeepOnlyCurrentBoard() {
        let ids = BoardScopeResolver.scopedBoardIDs(
            currentBoardId: "week-board",
            kind: "week",
            childBoardIDs: ["child-a", "child-b"]
        )

        #expect(ids == ["week-board"])
    }

    @Test("scope IDs are trimmed and deduplicated")
    func scopeIDsTrimAndDeduplicate() {
        let ids = BoardScopeResolver.scopedBoardIDs(
            currentBoardId: " compound-board ",
            kind: "compound",
            childBoardIDs: ["child-a", "child-a", " ", "child-b", "compound-board"]
        )

        #expect(ids == ["compound-board", "child-a", "child-b"])
    }
}
