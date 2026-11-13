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

@Test func detailedLayoutGrowsRowsAndPaginatesByTheirHeight() {
    let items = [
        PhysicalChecklistItem(
            id: "1", title: "One", section: "Today",
            detail: "Sep 4, 2026 · a note",
            subtasks: [
                PhysicalChecklistSubtask(title: "Buy stamps"),
                PhysicalChecklistSubtask(title: "Post letter", completed: true),
            ],
            photoCount: 1
        ),
        PhysicalChecklistItem(id: "2", title: "Two", section: "Today"),
    ]
    let job = PhysicalChecklistJob(
        ownerID: "board", title: "Board", paper: .a6, items: items,
        layoutVersion: BoardPrintContract.detailVersion
    )
    let layout = PhysicalChecklistLayout.build(job: job)
    let rows = layout.pages.flatMap(\.rows)
    let first = rows.first { row in
        guard case let .item(item) = row.kind else { return false }
        return item.id == "1"
    }
    let second = rows.first { row in
        guard case let .item(item) = row.kind else { return false }
        return item.id == "2"
    }

    #expect(layout.detailed)
    #expect(layout.layoutVersion == BoardPrintContract.detailVersion)
    #expect((first?.heightMM ?? 0) > PhysicalChecklistLayout.rowHeightMM)
    #expect((second?.heightMM ?? 0) == PhysicalChecklistLayout.rowHeightMM)
    if let first, let center = first.circleCenterMM {
        #expect(center.y >= first.yMM)
        #expect(center.y < first.yMM + first.titleBandMM)
    }
}

@Test func detailedLayoutUsesMorePagesThanTheFixedGrid() {
    let items = (0..<20).map { index in
        PhysicalChecklistItem(
            id: "task-\(index)", title: "Task \(index)",
            detail: "Sep 4, 2026",
            subtasks: (0..<6).map { PhysicalChecklistSubtask(title: "Subtask \($0)") },
            photoCount: 1
        )
    }
    let job = PhysicalChecklistJob(
        ownerID: "board", title: "Board", paper: .a6, items: items,
        layoutVersion: BoardPrintContract.detailVersion
    )
    let layout = PhysicalChecklistLayout.build(job: job)
    let bottom = layout.contentTopMM + (job.paper.sizeMM.height - PhysicalChecklistLayout.marginMM - layout.contentTopMM)

    #expect(layout.pages.count > 3)
    for row in layout.pages.flatMap(\.rows) {
        #expect(row.yMM + row.heightMM <= bottom + 0.001)
    }
}
