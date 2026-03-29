import Foundation

public enum BoardColumnDerivation {
    public static func deriveColumns(from tasks: [BoardTaskItem], preferredOrder: [String] = []) -> [BoardColumn] {
        var seen = Set<String>()
        var orderedIds: [String] = []

        for id in preferredOrder.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
            if seen.insert(id).inserted {
                orderedIds.append(id)
            }
        }

        // Preserve first-seen task order for columns not in preferredOrder.
        for raw in tasks.compactMap({ $0.columnId?.trimmingCharacters(in: .whitespacesAndNewlines) }).filter({ !$0.isEmpty }) {
            if seen.insert(raw).inserted {
                orderedIds.append(raw)
            }
        }

        if orderedIds.isEmpty {
            return [
                .init(id: "todo", name: "To do"),
                .init(id: "doing", name: "Doing"),
                .init(id: "done", name: "Done"),
            ]
        }

        return orderedIds.map { .init(id: $0, name: prettify($0)) }
    }

    private static func prettify(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }
}
