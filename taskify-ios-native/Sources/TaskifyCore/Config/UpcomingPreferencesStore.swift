import Foundation

public struct UpcomingPreferences: Equatable {
    public var selectedFilterIDs: [String]?
    public var sortMode: TaskSortMode
    public var sortAscending: Bool
    public var boardGrouping: UpcomingBoardGrouping
    public var viewStyle: String
    public var filterPresets: [UpcomingFilterPreset]

    public init(
        selectedFilterIDs: [String]? = nil,
        sortMode: TaskSortMode = .dueDate,
        sortAscending: Bool = true,
        boardGrouping: UpcomingBoardGrouping = .mixed,
        viewStyle: String = "details",
        filterPresets: [UpcomingFilterPreset] = []
    ) {
        self.selectedFilterIDs = selectedFilterIDs
        self.sortMode = sortMode
        self.sortAscending = sortAscending
        self.boardGrouping = boardGrouping
        self.viewStyle = viewStyle
        self.filterPresets = filterPresets
    }
}

public struct UpcomingPreferencesStore {
    public static let filterKey = "taskify_upcoming_filter_v1"
    public static let viewKey = "taskify_upcoming_view_v1"
    public static let sortKey = "taskify_upcoming_sort_v1"
    public static let boardGroupingKey = "taskify_upcoming_board_grouping_v1"
    public static let filterPresetsKey = "taskify_upcoming_filter_presets_v1"

    private let userDefaults: UserDefaults

    public init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    public func load() -> UpcomingPreferences {
        let selectedFilterIDs = loadFilterSelection()
        let storedSort = decodeJSON(StoredUpcomingSort.self, forKey: Self.sortKey)
        let sortMode = storedSort.flatMap { TaskSortMode(upcomingPreferenceRawValue: $0.mode) } ?? .dueDate
        let sortAscending = (storedSort?.direction ?? "asc") != "desc"
        let boardGrouping = UpcomingBoardGrouping(
            rawValue: userDefaults.string(forKey: Self.boardGroupingKey) ?? ""
        ) ?? .mixed
        let viewStyle = normalizedViewStyle(userDefaults.string(forKey: Self.viewKey))
        let filterPresets = decodeJSON([UpcomingFilterPreset].self, forKey: Self.filterPresetsKey) ?? []

        return UpcomingPreferences(
            selectedFilterIDs: selectedFilterIDs,
            sortMode: sortMode,
            sortAscending: sortAscending,
            boardGrouping: boardGrouping,
            viewStyle: viewStyle,
            filterPresets: filterPresets
        )
    }

    public func save(_ preferences: UpcomingPreferences) {
        saveFilterSelection(preferences.selectedFilterIDs)

        userDefaults.set(normalizedViewStyle(preferences.viewStyle), forKey: Self.viewKey)
        userDefaults.set(preferences.boardGrouping.rawValue, forKey: Self.boardGroupingKey)

        encodeJSON(
            StoredUpcomingSort(
                mode: preferences.sortMode.upcomingPreferenceRawValue,
                direction: preferences.sortAscending ? "asc" : "desc"
            ),
            forKey: Self.sortKey
        )
        encodeJSON(preferences.filterPresets, forKey: Self.filterPresetsKey)
    }

    private func loadFilterSelection() -> [String]? {
        guard let raw = userDefaults.string(forKey: Self.filterKey) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "null" {
            return nil
        }
        return decodeJSON([String].self, forKey: Self.filterKey)
    }

    private func saveFilterSelection(_ ids: [String]?) {
        if let ids {
            encodeJSON(ids, forKey: Self.filterKey)
        } else {
            userDefaults.set("null", forKey: Self.filterKey)
        }
    }

    private func normalizedViewStyle(_ raw: String?) -> String {
        switch raw {
        case "list":
            return "list"
        default:
            return "details"
        }
    }

    private func decodeJSON<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let raw = userDefaults.string(forKey: key),
              let data = raw.data(using: .utf8) else {
            return nil
        }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func encodeJSON<T: Encodable>(_ value: T, forKey key: String) {
        guard let data = try? JSONEncoder().encode(value),
              let raw = String(data: data, encoding: .utf8) else {
            return
        }
        userDefaults.set(raw, forKey: key)
    }
}

private struct StoredUpcomingSort: Codable, Equatable {
    let mode: String
    let direction: String
}

private extension TaskSortMode {
    init?(upcomingPreferenceRawValue: String) {
        switch upcomingPreferenceRawValue {
        case "manual":
            self = .manual
        case "due":
            self = .dueDate
        case "priority":
            self = .priority
        case "created":
            self = .createdAt
        case "alpha":
            self = .alphabetical
        default:
            return nil
        }
    }

    var upcomingPreferenceRawValue: String {
        switch self {
        case .manual:
            return "manual"
        case .dueDate:
            return "due"
        case .priority:
            return "priority"
        case .createdAt:
            return "created"
        case .alphabetical:
            return "alpha"
        }
    }
}
