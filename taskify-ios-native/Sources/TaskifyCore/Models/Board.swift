import Foundation

public enum TaskifyRelayDefaults {
    public static let urls = [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.solife.me",
    ]
}

public enum BoardKind: String, Codable, CaseIterable, Sendable {
    case week
    case list = "lists"
    case compound
    case bible
}

public struct BoardColumn: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var order: Int

    public init(id: String, name: String, order: Int) {
        self.id = id
        self.name = name
        self.order = order
    }
}

public struct Board: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var kind: BoardKind
    public var columns: [BoardColumn]
    public var archived: Bool
    public var hidden: Bool
    public var indexCardEnabled: Bool
    public var clearCompletedDisabled: Bool
    public var createdAt: Date
    public var nostrBoardID: String?
    public var relayURLs: [String]?

    public init(
        id: String = UUID().uuidString,
        name: String,
        kind: BoardKind = .week,
        columns: [BoardColumn] = [],
        archived: Bool = false,
        hidden: Bool = false,
        indexCardEnabled: Bool = true,
        clearCompletedDisabled: Bool = false,
        createdAt: Date = Date(),
        nostrBoardID: String? = UUID().uuidString,
        relayURLs: [String]? = TaskifyRelayDefaults.urls
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.columns = columns
        self.archived = archived
        self.hidden = hidden
        self.indexCardEnabled = indexCardEnabled
        self.clearCompletedDisabled = clearCompletedDisabled
        self.createdAt = createdAt
        self.nostrBoardID = nostrBoardID
        self.relayURLs = relayURLs
    }

    public var isVisible: Bool {
        !archived && !hidden
    }

    public var effectiveNostrBoardID: String {
        nostrBoardID ?? id
    }

    public var effectiveRelayURLs: [String] {
        let configured = relayURLs?.filter { !$0.isEmpty } ?? []
        return configured.isEmpty ? TaskifyRelayDefaults.urls : configured
    }

    public static func week(id: String = "week-default", name: String = "Week") -> Board {
        Board(
            id: id,
            name: name,
            kind: .week,
            columns: WeekdayColumn.allCases.map {
                BoardColumn(id: $0.rawValue, name: $0.shortName, order: $0.calendarWeekday)
            }
        )
    }
}

public enum WeekdayColumn: String, Codable, CaseIterable, Identifiable, Sendable {
    case sunday
    case monday
    case tuesday
    case wednesday
    case thursday
    case friday
    case saturday

    public var id: String { rawValue }

    public var shortName: String {
        switch self {
        case .sunday: "Sun"
        case .monday: "Mon"
        case .tuesday: "Tue"
        case .wednesday: "Wed"
        case .thursday: "Thu"
        case .friday: "Fri"
        case .saturday: "Sat"
        }
    }

    public var fullName: String {
        switch self {
        case .sunday: "Sunday"
        case .monday: "Monday"
        case .tuesday: "Tuesday"
        case .wednesday: "Wednesday"
        case .thursday: "Thursday"
        case .friday: "Friday"
        case .saturday: "Saturday"
        }
    }

    public var calendarWeekday: Int {
        switch self {
        case .sunday: 1
        case .monday: 2
        case .tuesday: 3
        case .wednesday: 4
        case .thursday: 5
        case .friday: 6
        case .saturday: 7
        }
    }

    public static func containing(_ date: Date, calendar: Calendar = .current) -> WeekdayColumn {
        let weekday = calendar.component(.weekday, from: date)
        return allCases.first { $0.calendarWeekday == weekday } ?? .sunday
    }
}
