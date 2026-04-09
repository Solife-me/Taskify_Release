import Foundation

// MARK: - Board Types

public enum BoardKind: String, Codable {
    case week = "week"
    case bible = "bible"
    case list = "list"
    case compound = "compound"
}

public struct Board: Identifiable, Codable, Hashable {
    public let id: String
    public let name: String
    public let kind: BoardKind
    public let archived: Bool
    public let hidden: Bool
    public let columns: [String]?
    public let indexCardEnabled: Bool
    public let clearCompletedDisabled: Bool
    public let createdAt: Int

    public init(
        id: String,
        name: String,
        kind: BoardKind = .week,
        archived: Bool = false,
        hidden: Bool = false,
        columns: [String]? = nil,
        indexCardEnabled: Bool = true,
        clearCompletedDisabled: Bool = false,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.archived = archived
        self.hidden = hidden
        self.columns = columns
        self.indexCardEnabled = indexCardEnabled
        self.clearCompletedDisabled = clearCompletedDisabled
        self.createdAt = createdAt
    }

    public func isVisible() -> Bool {
        return !archived && !hidden
    }
}

public struct ListColumn: Identifiable, Codable, Hashable {
    public let id: String
    public let title: String
    public let tasks: [String]? // task IDs
    public let order: Int

    public init(
        id: String,
        title: String,
        tasks: [String]? = nil,
        order: Int = 0
    ) {
        self.id = id
        self.title = title
        self.tasks = tasks
        self.order = order
    }
}

public struct Weekday: Int, Codable, CaseIterable {
    case sunday = 0
    case monday = 1
    case tuesday = 2
    case wednesday = 3
    case thursday = 4
    case friday = 5
    case saturday = 6

    public var displayName: String {
        switch self {
        case .sunday: return "Sunday"
        case .monday: return "Monday"
        case .tuesday: return "Tuesday"
        case .wednesday: return "Wednesday"
        case .thursday: return "Thursday"
        case .friday: return "Friday"
        case .saturday: return "Saturday"
        }
    }

    public static func from(date: Date) -> Weekday {
        let calendar = Calendar.current
        let weekday = calendar.component(.weekday, from: date)
        return Weekday(rawValue: weekday - 1) ?? .monday
    }
}