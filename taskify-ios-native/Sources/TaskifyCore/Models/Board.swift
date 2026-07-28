import Foundation

public enum TaskifyRelayDefaults {
    public static let urls = [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.solife.me",
    ]
}

public enum TaskifyRelayURL {
    public static func normalize(_ rawValue: String) -> String? {
        var candidate = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return nil }
        if !candidate.contains("://") {
            candidate = "wss://\(candidate)"
        }

        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.fragment == nil else { return nil }

        components.scheme = scheme
        components.host = host
        if components.path == "/" {
            components.path = ""
        }
        return components.string
    }

    public static func normalizedList(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            guard let normalized = normalize(value), seen.insert(normalized).inserted else {
                return nil
            }
            return normalized
        }
    }
}

public struct BoardSharePayload: Equatable, Sendable {
    public var boardID: String
    public var boardName: String?
    public var relayURLs: [String]

    public init(boardID: String, boardName: String? = nil, relayURLs: [String] = []) {
        self.boardID = boardID
        self.boardName = boardName
        self.relayURLs = relayURLs
    }
}

public enum BoardShareContract {
    public static func encode(board: Board) throws -> String {
        let envelope = BoardShareEnvelope(
            v: 1,
            kind: "taskify-share",
            item: BoardShareItem(
                type: "board",
                boardID: board.effectiveNostrBoardID,
                boardName: board.name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                relayURLs: TaskifyRelayURL.normalizedList(board.effectiveRelayURLs)
            )
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(envelope), as: UTF8.self)
    }

    public static func decode(_ rawValue: String) -> BoardSharePayload? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let data = trimmed.data(using: .utf8),
           let envelope = try? JSONDecoder().decode(BoardShareEnvelope.self, from: data),
           envelope.v == 1,
           envelope.kind == "taskify-share",
           envelope.item.type == "board" {
            let boardID = envelope.item.boardID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !boardID.isEmpty else { return nil }
            return BoardSharePayload(
                boardID: boardID,
                boardName: envelope.item.boardName?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty,
                relayURLs: TaskifyRelayURL.normalizedList(envelope.item.relayURLs ?? [])
            )
        }

        guard UUID(uuidString: trimmed) != nil else { return nil }
        return BoardSharePayload(boardID: trimmed)
    }

}

private struct BoardShareEnvelope: Codable {
    var v: Int
    var kind: String
    var item: BoardShareItem
}

private struct BoardShareItem: Codable {
    var type: String
    var boardID: String
    var boardName: String?
    var relayURLs: [String]?

    private enum CodingKeys: String, CodingKey {
        case type
        case boardID = "boardId"
        case boardName
        case relayURLs = "relays"
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
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

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case order
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        order = try container.decodeIfPresent(Int.self, forKey: .order) ?? -1
    }
}

public struct Board: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var kind: BoardKind
    public var columns: [BoardColumn]
    public var children: [String]
    public var archived: Bool
    public var hidden: Bool
    public var indexCardEnabled: Bool
    public var hideChildBoardNames: Bool
    public var clearCompletedDisabled: Bool
    public var createdAt: Date
    public var nostrBoardID: String?
    public var relayURLs: [String]?
    public var nostrUpdatedAt: Int?

    public init(
        id: String = UUID().uuidString,
        name: String,
        kind: BoardKind = .week,
        columns: [BoardColumn] = [],
        children: [String] = [],
        archived: Bool = false,
        hidden: Bool = false,
        indexCardEnabled: Bool = false,
        hideChildBoardNames: Bool = false,
        clearCompletedDisabled: Bool = false,
        createdAt: Date = Date(),
        nostrBoardID: String? = UUID().uuidString,
        relayURLs: [String]? = TaskifyRelayDefaults.urls,
        nostrUpdatedAt: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.columns = columns
        self.children = children
        self.archived = archived
        self.hidden = hidden
        self.indexCardEnabled = indexCardEnabled
        self.hideChildBoardNames = hideChildBoardNames
        self.clearCompletedDisabled = clearCompletedDisabled
        self.createdAt = createdAt
        self.nostrBoardID = nostrBoardID
        self.relayURLs = relayURLs
        self.nostrUpdatedAt = nostrUpdatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case kind
        case columns
        case children
        case archived
        case hidden
        case indexCardEnabled
        case hideChildBoardNames
        case clearCompletedDisabled
        case createdAt
        case nostrBoardID
        case relayURLs
        case nostrUpdatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Board"
        kind = try container.decodeIfPresent(BoardKind.self, forKey: .kind) ?? .week
        columns = try container.decodeIfPresent([BoardColumn].self, forKey: .columns) ?? []
        children = try container.decodeIfPresent([String].self, forKey: .children) ?? []
        archived = try container.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        indexCardEnabled = try container.decodeIfPresent(Bool.self, forKey: .indexCardEnabled) ?? false
        hideChildBoardNames = try container.decodeIfPresent(Bool.self, forKey: .hideChildBoardNames) ?? false
        clearCompletedDisabled = try container.decodeIfPresent(Bool.self, forKey: .clearCompletedDisabled) ?? false
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        nostrBoardID = try container.decodeIfPresent(String.self, forKey: .nostrBoardID)
        relayURLs = try container.decodeIfPresent([String].self, forKey: .relayURLs)
        nostrUpdatedAt = try container.decodeIfPresent(Int.self, forKey: .nostrUpdatedAt)
    }

    public var isVisible: Bool {
        !archived && !hidden
    }

    public var effectiveNostrBoardID: String {
        nostrBoardID ?? id
    }

    public var effectiveRelayURLs: [String] {
        let configured = TaskifyRelayURL.normalizedList(relayURLs ?? [])
        return configured.isEmpty ? TaskifyRelayDefaults.urls : configured
    }

    public func matchesReference(_ reference: String) -> Bool {
        id == reference || effectiveNostrBoardID == reference
    }

    public func templateSnapshot(
        boardID: String = UUID().uuidString
    ) -> Board {
        var template = self
        template.id = "template-\(boardID)"
        template.archived = false
        template.hidden = false
        template.nostrBoardID = boardID
        template.relayURLs = effectiveRelayURLs
        template.nostrUpdatedAt = nil
        return template
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
