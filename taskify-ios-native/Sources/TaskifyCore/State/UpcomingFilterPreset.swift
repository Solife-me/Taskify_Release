import Foundation

/// A named, saved selection of Upcoming filter options (board- and list-column-level), matching the PWA's
/// `upcomingFilterPresets`. Each entry in `selection` is either a board ID or a `"<boardID>::<columnID>"` pair.
public struct UpcomingFilterPreset: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var selection: [String]

    public init(id: String = UUID().uuidString, name: String, selection: [String]) {
        self.id = id
        self.name = name
        self.selection = selection
    }
}
