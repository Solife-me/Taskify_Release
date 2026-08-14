import Foundation

/// The `taskify://` links widgets use to open the app somewhere useful.
///
/// Shared with the app so both sides agree on the shape -- a widget that builds a URL the app
/// doesn't recognise fails silently, which is exactly how the Control Center button ended up doing
/// nothing.
public enum TaskifyWidgetLink: Equatable, Sendable {
    case upcoming
    case boards
    case task(id: String, boardID: String)
    case event(id: String, boardID: String)
    case quickAdd(boardID: String?, columnID: String?)

    public static let scheme = "taskify"

    public var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        switch self {
        case .upcoming:
            components.host = "upcoming"
        case .boards:
            components.host = "boards"
        case .task(let id, let boardID):
            components.host = "task"
            components.queryItems = [
                URLQueryItem(name: "id", value: id),
                URLQueryItem(name: "board", value: boardID),
            ]
        case .event(let id, let boardID):
            components.host = "event"
            components.queryItems = [
                URLQueryItem(name: "id", value: id),
                URLQueryItem(name: "board", value: boardID),
            ]
        case .quickAdd(let boardID, let columnID):
            components.host = "quick-add"
            var queryItems: [URLQueryItem] = []
            if let boardID, !boardID.isEmpty {
                queryItems.append(URLQueryItem(name: "board", value: boardID))
            }
            if let columnID, !columnID.isEmpty {
                queryItems.append(URLQueryItem(name: "column", value: columnID))
            }
            components.queryItems = queryItems.isEmpty ? nil : queryItems
        }
        // Every case above produces a valid URL; the fallback keeps this non-optional for callers.
        return components.url ?? URL(string: "\(Self.scheme)://upcoming")!
    }

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            query.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        switch url.host()?.lowercased() {
        case "upcoming":
            self = .upcoming
        case "boards":
            self = .boards
        case "task":
            guard let id = value("id"), !id.isEmpty else { return nil }
            self = .task(id: id, boardID: value("board") ?? "")
        case "event":
            guard let id = value("id"), !id.isEmpty else { return nil }
            self = .event(id: id, boardID: value("board") ?? "")
        case "quick-add":
            self = .quickAdd(
                boardID: value("board").flatMap { $0.isEmpty ? nil : $0 },
                columnID: value("column").flatMap { $0.isEmpty ? nil : $0 }
            )
        default:
            return nil
        }
    }
}
