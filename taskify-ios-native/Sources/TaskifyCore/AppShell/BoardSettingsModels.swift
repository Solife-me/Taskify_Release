import Foundation

public struct BoardOption: Identifiable, Equatable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct BoardChildSnapshot: Identifiable, Equatable {
    public var id: String
    public var name: String
    public var relayHints: [String]

    public init(id: String, name: String, relayHints: [String] = []) {
        self.id = id
        self.name = name
        self.relayHints = relayHints
    }
}

public struct BoardSettingsSnapshot: Equatable {
    public var id: String
    public var name: String
    public var kind: String
    public var columns: [BoardColumn]
    public var children: [BoardChildSnapshot]
    public var clearCompletedDisabled: Bool
    public var indexCardEnabled: Bool
    public var hideChildBoardNames: Bool
    public var relayHints: [String]

    public init(
        id: String,
        name: String,
        kind: String,
        columns: [BoardColumn],
        children: [BoardChildSnapshot] = [],
        clearCompletedDisabled: Bool = false,
        indexCardEnabled: Bool = false,
        hideChildBoardNames: Bool = false,
        relayHints: [String] = []
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.columns = columns
        self.children = children
        self.clearCompletedDisabled = clearCompletedDisabled
        self.indexCardEnabled = indexCardEnabled
        self.hideChildBoardNames = hideChildBoardNames
        self.relayHints = relayHints
    }
}

public struct ProfileBoardSummary: Identifiable, Equatable {
    public var id: String
    public var name: String
    public var kind: String
    public var archived: Bool
    public var hidden: Bool
    public var relayHints: [String]

    public init(
        id: String,
        name: String,
        kind: String,
        archived: Bool = false,
        hidden: Bool = false,
        relayHints: [String] = []
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.archived = archived
        self.hidden = hidden
        self.relayHints = relayHints
    }
}
