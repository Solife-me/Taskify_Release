import Foundation

public enum ScannedTaskList {
    public struct Row: Identifiable, Sendable {
        public let id = UUID().uuidString
        public var title: String
        public var isSubtask: Bool
        public let needsReview: Bool
    }

    public struct Draft: Sendable {
        public let id: String
        public let title: String
        public var subtasks: [TaskSubtask]
    }

    /// iOS and the PWA add a readable print ID to the subtitle. Older Mac prints have a
    /// subtitle without an ID and use their printed bit pattern instead.
    public static func printSubtitle(in lines: [PhysicalChecklistOCRLine]) -> PhysicalChecklistOCRLine? {
        lines.first { line in
            line.y < 0.25 && line.text.range(
                of: #"\blayout\b.*\bprint\b|fill,\s*check,\s*or x circles.*\bpage\b"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
        }
    }

    public static func printID(in lines: [PhysicalChecklistOCRLine]) -> String? {
        for line in lines where line.y < 0.25 {
            let text = line.text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if let tokenRange = text.range(
                of: #"(?:\blayout\b.*\bprint\s+|^id\s+)[a-z0-9]{8}$"#,
                options: .regularExpression
            ) {
                return String(text[tokenRange].suffix(8))
            }
        }
        return nil
    }

    // Vision sometimes drops a list marker. Indent relative to the preceding parent, with
    // a tolerance based on the page's typical line height to absorb small shifts in the writing.
    public static func rows(from lines: [PhysicalChecklistOCRLine]) -> [Row] {
        let ordered = lines.sorted { ($0.y + $0.height / 2, $0.x) < ($1.y + $1.height / 2, $1.x) }
        let heights = ordered.map(\.height).sorted()
        guard !heights.isEmpty else { return [] }
        let indentThreshold = max(0.025, heights[heights.count / 2] * 1.05)
        var parentX: Double?
        var rows: [Row] = []

        for line in ordered {
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let title = text.replacingOccurrences(
                of: #"^(?:(?:[-–—•·*▪◦☐☑☒✓✔]|\[[ xX]?\]|\d{1,3}[.)])\s*)+"#,
                with: "",
                options: .regularExpression
            )
            guard title.contains(where: { $0.isLetter || $0.isNumber }) else { continue }
            if rows.isEmpty && title == text {
                let heading = title.lowercased().trimmingCharacters(in: .punctuationCharacters)
                if ["to do", "to-do", "todo", "to do list", "to-do list", "task list", "checklist"].contains(heading) {
                    continue
                }
            }
            let isSubtask = parentX.map { line.x - $0 >= indentThreshold } ?? false
            if !isSubtask { parentX = line.x }
            rows.append(Row(title: title, isSubtask: isSubtask, needsReview: line.confidence < 0.5))
        }
        return rows
    }

    public static func drafts(from rows: [Row]) -> [Draft] {
        var tasks: [Draft] = []
        for row in rows {
            let title = row.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            if row.isSubtask, let parentIndex = tasks.indices.last {
                tasks[parentIndex].subtasks.append(TaskSubtask(title: title))
            } else {
                tasks.append(Draft(id: row.id, title: title, subtasks: []))
            }
        }
        return tasks
    }
}
