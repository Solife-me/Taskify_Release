import Foundation
import Testing
@testable import TaskifyCore

@MainActor
@Suite("UpcomingViewModel")
struct UpcomingViewModelTests {

    @Test("groups only open tasks with active due dates")
    func groupsOpenDatedTasks() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "Work", kind: "lists", columns: []),
        ])
        vm.setTasks([
            .init(id: "t1", title: "Due soon", completed: false, dueISO: "2026-03-26T18:00:00Z", createdAt: 10, dueDateEnabled: true, boardId: "b1", boardName: "Work"),
            .init(id: "t2", title: "Done", completed: true, dueISO: "2026-03-26T19:00:00Z", createdAt: 11, dueDateEnabled: true, boardId: "b1", boardName: "Work"),
            .init(id: "t3", title: "No due", completed: false, dueISO: nil, createdAt: 12, dueDateEnabled: true, boardId: "b1", boardName: "Work"),
            .init(id: "t4", title: "Disabled due", completed: false, dueISO: "2026-03-27T18:00:00Z", createdAt: 13, dueDateEnabled: false, boardId: "b1", boardName: "Work"),
        ])

        #expect(vm.itemCount == 1)
        #expect(vm.groups.count == 1)
        #expect(vm.groups.first?.tasks.map(\.id) == ["t1"])
    }

    @Test("search matches task notes in addition to title")
    func searchMatchesNotes() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "Work", kind: "lists", columns: []),
        ])
        vm.setTasks([
            .init(id: "t1", title: "Draft memo", completed: false, dueISO: "2026-03-26T18:00:00Z", createdAt: 10, note: "Share with finance", dueDateEnabled: true, boardId: "b1", boardName: "Work"),
            .init(id: "t2", title: "Review", completed: false, dueISO: "2026-03-26T20:00:00Z", createdAt: 11, note: "Legal pass", dueDateEnabled: true, boardId: "b1", boardName: "Work"),
        ])

        vm.searchText = "finance"

        #expect(vm.itemCount == 1)
        #expect(vm.filteredTasks.map(\.id) == ["t1"])
    }

    @Test("list filters constrain tasks to selected columns")
    func listFiltersConstrainColumns() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(
                id: "b1",
                name: "Work",
                kind: "lists",
                columns: [
                    .init(id: "todo", name: "Todo"),
                    .init(id: "doing", name: "Doing"),
                ]
            ),
            .init(id: "b2", name: "Home", kind: "week", columns: []),
        ])
        vm.setTasks([
            .init(id: "t1", title: "Todo item", completed: false, dueISO: "2026-03-26T18:00:00Z", createdAt: 10, columnId: "todo", dueDateEnabled: true, boardId: "b1", boardName: "Work"),
            .init(id: "t2", title: "Doing item", completed: false, dueISO: "2026-03-26T19:00:00Z", createdAt: 11, columnId: "doing", dueDateEnabled: true, boardId: "b1", boardName: "Work"),
            .init(id: "t3", title: "Home item", completed: false, dueISO: "2026-03-26T20:00:00Z", createdAt: 12, dueDateEnabled: true, boardId: "b2", boardName: "Home"),
        ])

        vm.setSelectedFilterIDs(Set(["board:b1:col:todo"]))

        #expect(vm.selectedFilterIDs == Optional(Set(["board:b1", "board:b1:col:todo"])))
        #expect(vm.filteredTasks.map(\.id) == ["t1"])
    }

    @Test("grouped board ordering overrides mixed sort order inside a day")
    func groupedBoardOrdering() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "First", kind: "lists", columns: []),
            .init(id: "b2", name: "Second", kind: "lists", columns: []),
        ])
        vm.setTasks([
            .init(id: "t1", title: "Zulu", completed: false, dueISO: "2026-03-26T18:00:00Z", createdAt: 10, dueDateEnabled: true, boardId: "b1", boardName: "First"),
            .init(id: "t2", title: "Alpha", completed: false, dueISO: "2026-03-26T18:00:00Z", createdAt: 11, dueDateEnabled: true, boardId: "b2", boardName: "Second"),
        ])

        vm.selectSortMode(.alphabetical)
        #expect(vm.groups.first?.tasks.map(\.id) == ["t2", "t1"])

        vm.setBoardGrouping(.grouped)
        #expect(vm.groups.first?.tasks.map(\.id) == ["t1", "t2"])
    }

    @Test("location label includes list name for list boards")
    func locationLabelIncludesListName() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(
                id: "b1",
                name: "Work",
                kind: "lists",
                columns: [.init(id: "todo", name: "Todo")]
            ),
        ])

        let task = BoardTaskItem(
            id: "t1",
            title: "Ship build",
            completed: false,
            dueISO: "2026-03-26T18:00:00Z",
            createdAt: 10,
            columnId: "todo",
            dueDateEnabled: true,
            boardId: "b1",
            boardName: "Work"
        )

        #expect(vm.locationLabel(for: task) == "Work • Todo")
    }

    @Test("calendar events expand into day groups alongside tasks")
    func calendarEventsExpandAcrossDays() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "Work", kind: "lists", columns: [.init(id: "todo", name: "Todo")]),
        ])
        vm.setTasks([
            .init(
                id: "t1",
                title: "Ship build",
                completed: false,
                dueISO: "2026-03-26T18:00:00Z",
                createdAt: 10,
                columnId: "todo",
                dueDateEnabled: true,
                boardId: "b1",
                boardName: "Work"
            ),
        ])
        vm.setEvents([
            .init(
                id: "e1",
                boardId: "b1",
                boardName: "Work",
                title: "Retreat",
                kind: "date",
                startDate: "2026-03-26",
                endDate: "2026-03-28",
                columnId: "todo"
            ),
        ])

        #expect(vm.itemCount == 2)
        #expect(vm.groups.map(\.dateKey) == ["2026-03-26", "2026-03-27", "2026-03-28"])
        #expect(vm.groups.first?.tasks.map(\.id) == ["t1"])
        #expect(vm.groups.first?.events.map(\.id) == ["e1"])
        #expect(vm.events(for: "2026-03-27").map(\.id) == ["e1"])
    }

    @Test("minimum date cutoff mirrors board-upcoming future-only grouping")
    func minimumDateCutoff() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "Work", kind: "lists", columns: [.init(id: "todo", name: "Todo")]),
        ])
        vm.setMinimumDateKeyExclusive("2026-03-26")
        vm.setTasks([
            .init(
                id: "t-past",
                title: "Past due",
                completed: false,
                dueISO: "2026-03-25T18:00:00Z",
                createdAt: 8,
                columnId: "todo",
                dueDateEnabled: true,
                boardId: "b1",
                boardName: "Work"
            ),
            .init(
                id: "t-today",
                title: "Today",
                completed: false,
                dueISO: "2026-03-26T18:00:00Z",
                createdAt: 9,
                columnId: "todo",
                dueDateEnabled: true,
                boardId: "b1",
                boardName: "Work"
            ),
            .init(
                id: "t-future",
                title: "Tomorrow",
                completed: false,
                dueISO: "2026-03-27T18:00:00Z",
                createdAt: 10,
                columnId: "todo",
                dueDateEnabled: true,
                boardId: "b1",
                boardName: "Work"
            ),
        ])
        vm.setEvents([
            .init(
                id: "e-range",
                boardId: "b1",
                boardName: "Work",
                title: "Conference",
                kind: "date",
                startDate: "2026-03-26",
                endDate: "2026-03-28",
                columnId: "todo"
            ),
            .init(
                id: "e-today",
                boardId: "b1",
                boardName: "Work",
                title: "Today sync",
                kind: "time",
                startISO: "2026-03-26T14:00:00Z",
                columnId: "todo"
            ),
            .init(
                id: "e-future",
                boardId: "b1",
                boardName: "Work",
                title: "Tomorrow sync",
                kind: "time",
                startISO: "2026-03-27T14:00:00Z",
                columnId: "todo"
            ),
        ])

        #expect(vm.groups.map(\.dateKey) == ["2026-03-27", "2026-03-28"])
        #expect(vm.tasks(for: "2026-03-27").map(\.id) == ["t-future"])
        #expect(vm.events(for: "2026-03-27").map(\.id) == ["e-range", "e-future"])
        #expect(vm.events(for: "2026-03-28").map(\.id) == ["e-range"])
    }

    @Test("event search matches description and locations")
    func eventSearchMatchesDescriptionAndLocations() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "Work", kind: "lists", columns: []),
        ])
        vm.setEvents([
            .init(
                id: "e1",
                boardId: "b1",
                boardName: "Work",
                title: "Weekly sync",
                kind: "time",
                startISO: "2026-03-26T15:00:00Z",
                description: "Budget review with finance",
                locations: ["HQ North"]
            ),
            .init(
                id: "e2",
                boardId: "b1",
                boardName: "Work",
                title: "Design critique",
                kind: "time",
                startISO: "2026-03-26T18:00:00Z",
                description: "Homepage polish",
                locations: ["Studio"]
            ),
        ])

        vm.searchText = "finance"

        #expect(vm.filteredEvents.map(\.id) == ["e1"])

        vm.searchText = "studio"

        #expect(vm.filteredEvents.map(\.id) == ["e2"])
    }

    @Test("all-day events sort ahead of timed events on the same day")
    func allDayEventsSortAheadOfTimedEvents() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(id: "b1", name: "Work", kind: "lists", columns: []),
        ])
        vm.setEvents([
            .init(
                id: "e1",
                boardId: "b1",
                boardName: "Work",
                title: "All day planning",
                kind: "date",
                startDate: "2026-03-26"
            ),
            .init(
                id: "e2",
                boardId: "b1",
                boardName: "Work",
                title: "Morning review",
                kind: "time",
                startISO: "2026-03-26T14:00:00Z"
            ),
            .init(
                id: "e3",
                boardId: "b1",
                boardName: "Work",
                title: "Afternoon review",
                kind: "time",
                startISO: "2026-03-26T18:00:00Z"
            ),
        ])

        #expect(vm.groups.first?.events.map(\.id) == ["e1", "e2", "e3"])
    }

    @Test("restores and persists upcoming preferences using PWA-compatible semantics")
    func restoresAndPersistsPreferences() {
        let preferences = UpcomingPreferences(
            selectedFilterIDs: ["board:b1:col:todo"],
            sortMode: .alphabetical,
            sortAscending: false,
            boardGrouping: .grouped,
            viewStyle: "list",
            filterPresets: [
                .init(id: "preset-1", name: "Todo", selection: ["board:b1:col:todo"]),
            ]
        )

        let vm = UpcomingViewModel(preferences: preferences)
        vm.setBoards([
            .init(
                id: "b1",
                name: "Work",
                kind: "lists",
                columns: [
                    .init(id: "todo", name: "Todo"),
                    .init(id: "doing", name: "Doing"),
                ]
            ),
        ])

        #expect(vm.sortMode == .alphabetical)
        #expect(vm.sortAscending == false)
        #expect(vm.boardGrouping == .grouped)
        #expect(vm.selectedFilterIDs == Optional(Set(["board:b1", "board:b1:col:todo"])))
        #expect(vm.filterPresets.map(\.name) == ["Todo"])
        #expect(vm.currentPreferences(viewStyle: "list").viewStyle == "list")
        #expect(vm.currentPreferences(viewStyle: "list").selectedFilterIDs == ["board:b1", "board:b1:col:todo"])
    }

    @Test("saves applies and deletes filter presets")
    func savesAppliesAndDeletesFilterPresets() {
        let vm = UpcomingViewModel()
        vm.setBoards([
            .init(
                id: "b1",
                name: "Work",
                kind: "lists",
                columns: [
                    .init(id: "todo", name: "Todo"),
                    .init(id: "doing", name: "Doing"),
                ]
            ),
        ])

        vm.setSelectedFilterIDs(Set(["board:b1:col:todo"]))
        vm.saveFilterPreset(named: "Todo only")

        #expect(vm.filterPresets.count == 1)
        guard let preset = vm.filterPresets.first else { return }
        #expect(preset.selection == ["board:b1", "board:b1:col:todo"])

        vm.clearAllFilters()
        #expect(vm.selectedFilterIDs == Optional(Set<String>()))

        vm.applyFilterPreset(preset)
        #expect(vm.selectedFilterIDs == Optional(Set(["board:b1", "board:b1:col:todo"])))

        vm.deleteFilterPreset(preset)
        #expect(vm.filterPresets.isEmpty)
    }
}
