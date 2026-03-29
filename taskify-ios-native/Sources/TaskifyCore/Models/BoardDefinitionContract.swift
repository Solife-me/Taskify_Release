import Foundation

public struct BoardDefinitionPayload: Codable, Equatable {
    public var name: String?
    public var kind: String?
    public var clearCompletedDisabled: Bool
    public var columns: [BoardColumn]?
    public var listIndex: Bool?
    public var children: [String]?
    public var hideBoardNames: Bool?
    public var archived: Bool?
    public var hidden: Bool?
    public var sortMode: String?
    public var sortDirection: String?
    public var version: Int?

    enum CodingKeys: String, CodingKey {
        case name
        case kind
        case clearCompletedDisabled
        case columns
        case listIndex
        case children
        case hideBoardNames
        case archived
        case hidden
        case sortMode
        case sortDirection
        case version
    }

    public init(
        name: String? = nil,
        kind: String? = nil,
        clearCompletedDisabled: Bool,
        columns: [BoardColumn]? = nil,
        listIndex: Bool? = nil,
        children: [String]? = nil,
        hideBoardNames: Bool? = nil,
        archived: Bool? = nil,
        hidden: Bool? = nil,
        sortMode: String? = nil,
        sortDirection: String? = nil,
        version: Int? = nil
    ) {
        self.name = name
        self.kind = kind
        self.clearCompletedDisabled = clearCompletedDisabled
        self.columns = columns
        self.listIndex = listIndex
        self.children = children
        self.hideBoardNames = hideBoardNames
        self.archived = archived
        self.hidden = hidden
        self.sortMode = sortMode
        self.sortDirection = sortDirection
        self.version = version
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        clearCompletedDisabled = try container.decodeIfPresent(Bool.self, forKey: .clearCompletedDisabled) ?? false
        columns = try container.decodeIfPresent([BoardColumn].self, forKey: .columns)
        listIndex = try container.decodeIfPresent(Bool.self, forKey: .listIndex)
        children = try container.decodeIfPresent([String].self, forKey: .children)
        hideBoardNames = try container.decodeIfPresent(Bool.self, forKey: .hideBoardNames)
        archived = try container.decodeIfPresent(Bool.self, forKey: .archived)
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden)
        sortMode = try container.decodeIfPresent(String.self, forKey: .sortMode)
        sortDirection = try container.decodeIfPresent(String.self, forKey: .sortDirection)
        version = try container.decodeIfPresent(Int.self, forKey: .version)
    }
}

public struct BoardDefinitionMetadata: Equatable {
    public var name: String?
    public var kind: String?
    public var columns: [BoardColumn]?
    public var children: [String]?
    public var archived: Bool?
    public var hidden: Bool?
    public var clearCompletedDisabled: Bool?
    public var indexCardEnabled: Bool?
    public var hideChildBoardNames: Bool?
    public var sortMode: String?
    public var sortDirection: String?

    public init(
        name: String? = nil,
        kind: String? = nil,
        columns: [BoardColumn]? = nil,
        children: [String]? = nil,
        archived: Bool? = nil,
        hidden: Bool? = nil,
        clearCompletedDisabled: Bool? = nil,
        indexCardEnabled: Bool? = nil,
        hideChildBoardNames: Bool? = nil,
        sortMode: String? = nil,
        sortDirection: String? = nil
    ) {
        self.name = name
        self.kind = kind
        self.columns = columns
        self.children = children
        self.archived = archived
        self.hidden = hidden
        self.clearCompletedDisabled = clearCompletedDisabled
        self.indexCardEnabled = indexCardEnabled
        self.hideChildBoardNames = hideChildBoardNames
        self.sortMode = sortMode
        self.sortDirection = sortDirection
    }

    public var isEmpty: Bool {
        name == nil
            && kind == nil
            && columns == nil
            && children == nil
            && archived == nil
            && hidden == nil
            && clearCompletedDisabled == nil
            && indexCardEnabled == nil
            && hideChildBoardNames == nil
            && sortMode == nil
            && sortDirection == nil
    }
}

public enum BoardDefinitionCodec {
    public static func encode(_ payload: BoardDefinitionPayload) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(payload) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func decode(_ raw: String?) -> BoardDefinitionPayload? {
        guard let raw,
              let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(BoardDefinitionPayload.self, from: data)
    }

    public static func mergedMetadata(
        payload: BoardDefinitionPayload?,
        tags: [[String]]
    ) -> BoardDefinitionMetadata {
        let payloadName = trimmed(payload?.name)
        let payloadKind = trimmed(payload?.kind)
        let tagName = tagValue(tags, keys: ["name", "title", "n"])
        let tagKind = tagValue(tags, keys: ["k"])
        let tagColumns = decodedTagColumns(tags)
        let payloadColumns = payload?.columns ?? []
        let includeColumns = payload?.columns != nil || !tagColumns.isEmpty
        let mergedColumns = mergeColumns(primary: tagColumns, fallback: payloadColumns)

        let tagChildren = decodedTagChildren(tags)
        let payloadChildren = payload?.children ?? []
        let includeChildren = payload?.children != nil || !tagChildren.isEmpty
        let mergedChildren = mergeStrings(primary: tagChildren, fallback: payloadChildren)

        let payloadSortMode = trimmed(payload?.sortMode)
        let payloadSortDirection = trimmed(payload?.sortDirection)
        let tagSort = sortTagValues(tags)
        let resolvedSortMode = tagSort.mode ?? payloadSortMode
        let resolvedSortDirection = resolvedSortMode == nil
            ? nil
            : (tagSort.direction ?? payloadSortDirection ?? "asc")

        return BoardDefinitionMetadata(
            name: payloadName ?? tagName,
            kind: tagKind ?? payloadKind,
            columns: includeColumns ? mergedColumns : nil,
            children: includeChildren ? mergedChildren : nil,
            archived: payload?.archived,
            hidden: payload?.hidden,
            clearCompletedDisabled: payload.map(\.clearCompletedDisabled),
            indexCardEnabled: payload?.listIndex,
            hideChildBoardNames: payload?.hideBoardNames,
            sortMode: resolvedSortMode,
            sortDirection: resolvedSortDirection
        )
    }
}

private func trimmed(_ value: String?) -> String? {
    value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
}

private func tagValue(_ tags: [[String]], keys: [String]) -> String? {
    for key in keys {
        if let value = tags.first(where: { $0.first == key })?.dropFirst().first {
            let trimmedValue = trimmed(String(value))
            if trimmedValue != nil {
                return trimmedValue
            }
        }
    }
    return nil
}

private func decodedTagColumns(_ tags: [[String]]) -> [BoardColumn] {
    var seen = Set<String>()
    var columns: [BoardColumn] = []

    for tag in tags where tag.first == "col" {
        guard tag.count > 2,
              let id = trimmed(tag[1]),
              let name = trimmed(tag[2]),
              seen.insert(id).inserted else {
            continue
        }
        columns.append(BoardColumn(id: id, name: name))
    }

    return columns
}

private func decodedTagChildren(_ tags: [[String]]) -> [String] {
    mergeStrings(
        primary: tags.compactMap { tag in
            guard tag.first == "ch", tag.count > 1 else { return nil }
            return trimmed(tag[1])
        },
        fallback: []
    )
}

private func sortTagValues(_ tags: [[String]]) -> (mode: String?, direction: String?) {
    guard let sortTag = tags.first(where: { $0.first == "sort" }) else {
        return (nil, nil)
    }
    let mode = sortTag.count > 1 ? trimmed(sortTag[1]) : nil
    let direction = sortTag.count > 2 ? trimmed(sortTag[2]) : nil
    return (mode, direction)
}

private func mergeColumns(primary: [BoardColumn], fallback: [BoardColumn]) -> [BoardColumn] {
    var seen = Set<String>()
    var merged: [BoardColumn] = []

    for column in primary + fallback {
        let id = column.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = column.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !name.isEmpty, seen.insert(id).inserted else { continue }
        merged.append(BoardColumn(id: id, name: name))
    }

    return merged
}

private func mergeStrings(primary: [String], fallback: [String]) -> [String] {
    var seen = Set<String>()
    var merged: [String] = []

    for value in primary + fallback {
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty, seen.insert(trimmedValue).inserted else { continue }
        merged.append(trimmedValue)
    }

    return merged
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
