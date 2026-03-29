import Foundation
import Testing
@testable import TaskifyCore

@Suite("UpcomingPreferencesStore")
struct UpcomingPreferencesStoreTests {

    @Test("loads PWA-shaped upcoming preferences from local storage keys")
    func loadsPwaShapedPreferences() throws {
        let suiteName = "UpcomingPreferencesStoreTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(#"["board:b1","board:b1:col:todo"]"#, forKey: UpcomingPreferencesStore.filterKey)
        defaults.set("list", forKey: UpcomingPreferencesStore.viewKey)
        defaults.set(#"{"mode":"alpha","direction":"desc"}"#, forKey: UpcomingPreferencesStore.sortKey)
        defaults.set("grouped", forKey: UpcomingPreferencesStore.boardGroupingKey)
        defaults.set(
            #"""
            [
                {"id":"preset-1","name":"Work","selection":["board:b1","board:b1:col:todo"]},
                {"id":"preset-2","name":"Home","selection":[]}
            ]
            """#,
            forKey: UpcomingPreferencesStore.filterPresetsKey
        )

        let store = UpcomingPreferencesStore(userDefaults: defaults)
        let preferences = store.load()

        #expect(preferences.selectedFilterIDs == ["board:b1", "board:b1:col:todo"])
        #expect(preferences.viewStyle == "list")
        #expect(preferences.sortMode == .alphabetical)
        #expect(preferences.sortAscending == false)
        #expect(preferences.boardGrouping == .grouped)
        #expect(preferences.filterPresets.map(\.name) == ["Work", "Home"])
        #expect(preferences.filterPresets.last?.selection == [])
    }

    @Test("round-trips nil filter selection as JSON null")
    func roundTripsNilFilterSelection() throws {
        let suiteName = "UpcomingPreferencesStoreTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = UpcomingPreferencesStore(userDefaults: defaults)
        let preferences = UpcomingPreferences(
            selectedFilterIDs: nil,
            sortMode: .createdAt,
            sortAscending: false,
            boardGrouping: .grouped,
            viewStyle: "details",
            filterPresets: [
                .init(id: "preset-1", name: "None", selection: []),
            ]
        )

        store.save(preferences)

        #expect(defaults.string(forKey: UpcomingPreferencesStore.filterKey) == "null")

        let loaded = store.load()
        #expect(loaded.selectedFilterIDs == nil)
        #expect(loaded.sortMode == .createdAt)
        #expect(loaded.sortAscending == false)
        #expect(loaded.boardGrouping == .grouped)
        #expect(loaded.viewStyle == "details")
        #expect(loaded.filterPresets == preferences.filterPresets)
    }
}
