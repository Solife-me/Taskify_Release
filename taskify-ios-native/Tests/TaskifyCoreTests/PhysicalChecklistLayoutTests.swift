import Testing
@testable import TaskifyCore

@Test func physicalChecklistLayoutPreservesTaskMappingAcrossPages() {
    let items = (0..<100).map {
        PhysicalChecklistItem(id: "task-\($0)", title: "Task \($0)", section: $0 < 50 ? "First" : "Second")
    }
    let job = PhysicalChecklistJob(ownerID: "board", title: "Board", paper: .a6, items: items)
    let layout = PhysicalChecklistLayout.build(job: job)
    let taskIDs = layout.pages.flatMap(\.rows).compactMap { row -> String? in
        guard case let .item(item) = row.kind else { return nil }
        return item.id
    }

    #expect(layout.pages.count > 1)
    #expect(taskIDs == items.map(\.id))
    #expect(layout.pageIDBitCentersMM().count == 6)
}

@Test func physicalChecklistAddsAHeaderOnlyWhenSectionChanges() {
    let items = [
        PhysicalChecklistItem(id: "1", title: "One", section: "Today"),
        PhysicalChecklistItem(id: "2", title: "Two", section: "Today"),
        PhysicalChecklistItem(id: "3", title: "Three", section: "Later"),
    ]
    let layout = PhysicalChecklistLayout.build(job: .init(ownerID: "board", title: "Board", items: items))
    let headers = layout.pages.flatMap(\.rows).compactMap { row -> String? in
        guard case let .section(name) = row.kind else { return nil }
        return name
    }

    #expect(headers == ["Today", "Later"])
}
