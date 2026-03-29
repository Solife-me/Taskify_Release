import Foundation
import Testing
@testable import TaskifyCore

@Suite("BoardColumnDerivation")
struct BoardColumnDerivationTests {

    @Test("derives unique columns preserving first-seen order")
    func derivesColumnsFromTasks() {
        let tasks: [BoardTaskItem] = [
            .init(id: "1", title: "A", completed: false, columnId: "inbox"),
            .init(id: "2", title: "B", completed: false, columnId: "doing"),
            .init(id: "3", title: "C", completed: true, columnId: "inbox"),
        ]

        let cols = BoardColumnDerivation.deriveColumns(from: tasks)
        #expect(cols.map(\.id) == ["inbox", "doing"])
        #expect(cols.first?.name == "Inbox")
    }

    @Test("preferred order is honored before task-derived order")
    func preferredOrder() {
        let tasks: [BoardTaskItem] = [
            .init(id: "1", title: "A", completed: false, columnId: "doing"),
            .init(id: "2", title: "B", completed: false, columnId: "backlog"),
        ]

        let cols = BoardColumnDerivation.deriveColumns(from: tasks, preferredOrder: ["todo", "doing"])
        #expect(cols.map(\.id) == ["todo", "doing", "backlog"])
    }

    @Test("falls back to defaults when no task columns")
    func fallbackColumns() {
        let cols = BoardColumnDerivation.deriveColumns(from: [
            .init(id: "1", title: "A", completed: false, columnId: nil)
        ])
        #expect(cols.map(\.id) == ["todo", "doing", "done"])
    }
}
