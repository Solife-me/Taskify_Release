import Foundation

public struct CompoundChildPayload: Equatable {
    public var boardId: String
    public var boardName: String?
    public var relays: [String]

    public init(boardId: String, boardName: String? = nil, relays: [String] = []) {
        self.boardId = boardId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.boardName = boardName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.relays = BoardShareContract.normalizeRelays(relays)
    }
}

public enum CompoundChildContract {
    public static func parse(_ raw: String) -> CompoundChildPayload? {
        if let shared = BoardShareContract.parse(raw) {
            return CompoundChildPayload(
                boardId: shared.boardId,
                boardName: shared.boardName,
                relays: shared.relays
            )
        }

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var boardId = trimmed
        var relaySegment = ""

        if let atIndex = trimmed.firstIndex(of: "@") {
            boardId = String(trimmed[..<atIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            relaySegment = String(trimmed[trimmed.index(after: atIndex)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let spaceIndex = trimmed.firstIndex(where: \.isWhitespace) {
            boardId = String(trimmed[..<spaceIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            relaySegment = String(trimmed[spaceIndex...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        guard !boardId.isEmpty else { return nil }
        let relays = relaySegment.isEmpty
            ? []
            : relaySegment
                .split(whereSeparator: { $0.isWhitespace || $0 == "," })
                .map(String.init)

        return CompoundChildPayload(boardId: boardId, relays: relays)
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
