import Foundation

public struct BoardSharePayload: Equatable {
    public var boardId: String
    public var boardName: String?
    public var relays: [String]

    public init(boardId: String, boardName: String? = nil, relays: [String] = []) {
        self.boardId = boardId
        self.boardName = boardName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.relays = BoardShareContract.normalizeRelays(relays)
    }

    public var relaysCSV: String? {
        relays.isEmpty ? nil : relays.joined(separator: ",")
    }
}

public enum BoardShareContract {
    private static let boardIdRegex = try! NSRegularExpression(
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        options: [.caseInsensitive]
    )
    private static let embeddedPrefix = "Taskify-Share:"

    public static func parse(_ raw: String) -> BoardSharePayload? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let payload = parseEnvelopeJSON(trimmed) {
            return payload
        }

        if let embeddedPayload = parseEmbeddedEnvelope(trimmed) {
            return embeddedPayload
        }

        guard isBoardId(trimmed) else { return nil }
        return BoardSharePayload(boardId: trimmed)
    }

    public static func buildPayload(boardId: String, boardName: String? = nil, relays: [String] = []) -> BoardSharePayload {
        BoardSharePayload(boardId: boardId, boardName: boardName, relays: relays)
    }

    public static func buildEnvelopeString(boardId: String, boardName: String? = nil, relays: [String] = []) -> String {
        let envelope = ShareEnvelope(
            item: ShareBoardItem(
                boardId: boardId.trimmingCharacters(in: .whitespacesAndNewlines),
                boardName: boardName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                relays: normalizeRelays(relays)
            )
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(envelope),
              let string = String(data: data, encoding: .utf8) else {
            return boardId
        }
        return string
    }

    static func normalizeRelays(_ relays: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for relay in relays
            .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) })
            .filter({ !$0.isEmpty }) where seen.insert(relay).inserted {
            ordered.append(relay)
        }
        return ordered
    }

    private static func parseEnvelopeJSON(_ raw: String) -> BoardSharePayload? {
        guard let data = raw.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(ShareEnvelope.self, from: data),
              envelope.v == 1,
              envelope.kind == "taskify-share",
              envelope.item.type == "board" else {
            return nil
        }
        let boardId = envelope.item.boardId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !boardId.isEmpty else { return nil }
        return BoardSharePayload(
            boardId: boardId,
            boardName: envelope.item.boardName,
            relays: envelope.item.relays ?? []
        )
    }

    private static func parseEmbeddedEnvelope(_ raw: String) -> BoardSharePayload? {
        guard let line = raw.split(separator: "\n").first(where: {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(embeddedPrefix)
        }) else { return nil }
        let encoded = line
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: embeddedPrefix, with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let decoded = decodeBase64URL(encoded) else { return nil }
        return parseEnvelopeJSON(decoded)
    }

    private static func decodeBase64URL(_ encoded: String) -> String? {
        let normalized = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - normalized.count % 4) % 4
        let padded = normalized + String(repeating: "=", count: padding)
        guard let data = Data(base64Encoded: padded) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func isBoardId(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return boardIdRegex.firstMatch(in: value, options: [], range: range) != nil
    }
}

private struct ShareEnvelope: Codable {
    var v: Int = 1
    var kind: String = "taskify-share"
    var item: ShareBoardItem
}

private struct ShareBoardItem: Codable {
    var type: String = "board"
    var boardId: String
    var boardName: String?
    var relays: [String]?
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
