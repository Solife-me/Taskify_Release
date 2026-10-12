import Foundation

/// A task note as the rich editor holds it: one entry per line, each with a kind and formatted
/// runs, so editing never touches Markdown syntax. Notes are stored as Markdown; this converts
/// both ways. Line-based because the notes dialect is: a single newline is a line break and each
/// blank line is kept.
///
/// Mirrors `noteLinesFromMarkdown` / `markdownFromNoteLines` in
/// `taskify-pwa/src/domains/tasks/noteMarkdown.ts`; keep the two in step.
public struct TaskNoteLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case paragraph
        case heading(Int)
        case bullet
        /// The number the source gave; serialization renumbers each run of items from it.
        case numbered(Int)
        case checklist(checked: Bool)
        case quote
        /// One line of a fenced code block. Its text is literal.
        case code
        case rule
    }

    public var kind: Kind
    public var depth: Int
    public var runs: [TaskNoteRun]

    public init(kind: Kind = .paragraph, depth: Int = 0, runs: [TaskNoteRun] = []) {
        self.kind = kind
        self.depth = depth
        self.runs = runs
    }

    public var text: String { runs.map(\.text).joined() }
}

public struct TaskNoteRun: Equatable, Sendable {
    public struct Marks: OptionSet, Hashable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let bold = Marks(rawValue: 1)
        public static let italic = Marks(rawValue: 2)
        public static let strikethrough = Marks(rawValue: 4)
        public static let code = Marks(rawValue: 8)
    }

    public var text: String
    public var marks: Marks
    public var link: String?

    public init(_ text: String, marks: Marks = [], link: String? = nil) {
        self.text = text
        self.marks = marks
        self.link = link
    }
}

public enum TaskNoteDocument {
    // MARK: Markdown → lines

    public static func lines(fromMarkdown note: String) -> [TaskNoteLine] {
        var lines: [TaskNoteLine] = []
        var fence: TaskNoteMarkdown.Fence?
        for rawLine in TaskNoteMarkdown.lines(of: note) {
            let line = TaskNoteMarkdown.stripCarriageReturn(rawLine)
            if let open = fence {
                if TaskNoteMarkdown.Fence.closes(line, open) {
                    fence = nil
                } else {
                    lines.append(TaskNoteLine(kind: .code, runs: line.isEmpty ? [] : [TaskNoteRun(line)]))
                }
                continue
            }
            if let open = TaskNoteMarkdown.Fence.opening(line) {
                fence = open
                continue
            }
            if line.allSatisfy(\.isWhitespace) {
                lines.append(TaskNoteLine())
                continue
            }
            if TaskNoteMarkdown.isThematicBreak(line) {
                lines.append(TaskNoteLine(kind: .rule))
                continue
            }
            let info = TaskNoteMarkdown.LineInfo(line)
            let runs = self.runs(fromInline: info.content)
            switch info.kind {
            case .plain: lines.append(TaskNoteLine(runs: runs))
            case .heading(let level): lines.append(TaskNoteLine(kind: .heading(level), runs: runs))
            case .bullet: lines.append(TaskNoteLine(kind: .bullet, depth: info.depth, runs: runs))
            case let .numbered(number, _):
                lines.append(TaskNoteLine(kind: .numbered(number), depth: info.depth, runs: runs))
            case let .checklist(checked, _):
                lines.append(TaskNoteLine(kind: .checklist(checked: checked), depth: info.depth, runs: runs))
            case .quote: lines.append(TaskNoteLine(kind: .quote, runs: runs))
            }
        }
        return lines
    }

    /// Inline Markdown as formatted runs.
    public static func runs(fromInline markdown: String) -> [TaskNoteRun] {
        guard !markdown.isEmpty else { return [] }
        guard let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return [TaskNoteRun(markdown)] }
        var runs: [TaskNoteRun] = []
        for run in attributed.runs {
            let intent = run.inlinePresentationIntent ?? []
            var marks: TaskNoteRun.Marks = []
            if intent.contains(.stronglyEmphasized) { marks.insert(.bold) }
            if intent.contains(.emphasized) { marks.insert(.italic) }
            if intent.contains(.strikethrough) { marks.insert(.strikethrough) }
            if intent.contains(.code) { marks.insert(.code) }
            runs.append(TaskNoteRun(
                String(attributed[run.range].characters),
                marks: marks,
                link: run.link?.absoluteString
            ))
        }
        return merged(runs)
    }

    // MARK: Lines → Markdown

    public static func markdown(from lines: [TaskNoteLine]) -> String {
        var output: [String] = []
        var index = 0
        var previousNumbered: (depth: Int, number: Int)?
        while index < lines.count {
            let line = lines[index]
            let indent = String(repeating: "  ", count: max(0, line.depth))
            var numbered: (depth: Int, number: Int)?
            switch line.kind {
            case .code:
                var block: [String] = []
                while index < lines.count, lines[index].kind == .code {
                    block.append(lines[index].text)
                    index += 1
                }
                let ticks = String(repeating: "`", count: max(3, longestRun(of: "`", in: block.joined(separator: "\n")) + 1))
                output.append(ticks)
                output.append(contentsOf: block)
                output.append(ticks)
                previousNumbered = nil
                continue
            case .rule:
                output.append("---")
            case .paragraph:
                let text = inlineMarkdown(line.runs)
                output.append(text.isEmpty ? "" : escapingBlockSyntax(text))
            case .heading(let level):
                output.append(String(repeating: "#", count: min(max(level, 1), 6)) + " " + inlineMarkdown(line.runs))
            case .bullet:
                output.append(indent + "- " + inlineMarkdown(line.runs))
            case .numbered(let start):
                let number = previousNumbered.flatMap { $0.depth == line.depth ? $0.number + 1 : nil } ?? start
                numbered = (line.depth, number)
                output.append(indent + "\(number). " + inlineMarkdown(line.runs))
            case .checklist(let checked):
                output.append(indent + (checked ? "- [x] " : "- [ ] ") + inlineMarkdown(line.runs))
            case .quote:
                output.append("> " + inlineMarkdown(line.runs))
            }
            previousNumbered = numbered
            index += 1
        }
        return output.joined(separator: "\n")
    }

    /// Formatted runs as inline Markdown. Marks open and close at run boundaries in a fixed
    /// nesting order (link, bold, italic, strikethrough, code), and whitespace is kept outside
    /// them, which Markdown requires for emphasis to close.
    public static func inlineMarkdown(_ runs: [TaskNoteRun]) -> String {
        enum Mark: Equatable {
            case link(String), bold, italic, strikethrough, code

            var open: String {
                switch self {
                case .link: "["
                case .bold: "**"
                case .italic: "*"
                case .strikethrough: "~~"
                case .code: "`"
                }
            }

            var close: String {
                switch self {
                case .link(let url): "](\(url.replacingOccurrences(of: " ", with: "%20").replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")))"
                case .bold: "**"
                case .italic: "*"
                case .strikethrough: "~~"
                case .code: "`"
                }
            }
        }

        func marks(of run: TaskNoteRun) -> [Mark] {
            var marks: [Mark] = []
            if let link = run.link, !link.isEmpty { marks.append(.link(link)) }
            if run.marks.contains(.bold) { marks.append(.bold) }
            if run.marks.contains(.italic) { marks.append(.italic) }
            if run.marks.contains(.strikethrough) { marks.append(.strikethrough) }
            if run.marks.contains(.code) { marks.append(.code) }
            return marks
        }

        var output = ""
        var open: [Mark] = []
        var pendingSpace = ""
        for run in merged(runs) {
            let text = run.text
            guard text.contains(where: { !$0.isWhitespace }) else {
                pendingSpace += text
                continue
            }
            let target = marks(of: run)
            var keep = 0
            while keep < open.count, keep < target.count, open[keep] == target[keep] { keep += 1 }
            if keep < open.count {
                for mark in open[keep...].reversed() { output += mark.close }
                open.removeSubrange(keep...)
            }
            output += pendingSpace
            pendingSpace = ""

            let leading = String(text.prefix { $0.isWhitespace })
            let trailing = String(String(text.reversed()).prefix { $0.isWhitespace }.reversed())
            let core = String(text.dropFirst(leading.count).dropLast(trailing.count))
            output += leading
            for mark in target.dropFirst(open.count) {
                output += mark == .code ? codeOpening(for: core) : mark.open
                open.append(mark)
            }
            if target.contains(.code) {
                output += core
                // A code span closes with its run: its content can't hold other runs' text.
                output += codeClosing(for: core)
                open.removeLast()
            } else {
                output += escapingInline(core)
            }
            pendingSpace = trailing
        }
        for mark in open.reversed() { output += mark.close }
        return output + pendingSpace
    }

    // MARK: Helpers

    static func merged(_ runs: [TaskNoteRun]) -> [TaskNoteRun] {
        var result: [TaskNoteRun] = []
        for run in runs where !run.text.isEmpty {
            if let last = result.last, last.marks == run.marks, last.link == run.link, !run.marks.contains(.code) {
                result[result.count - 1].text += run.text
            } else {
                result.append(run)
            }
        }
        return result
    }

    private static func longestRun(of character: Character, in text: String) -> Int {
        var longest = 0
        var current = 0
        for scalar in text {
            current = scalar == character ? current + 1 : 0
            longest = max(longest, current)
        }
        return longest
    }

    private static func codeOpening(for text: String) -> String {
        let ticks = String(repeating: "`", count: longestRun(of: "`", in: text) + 1)
        return text.hasPrefix("`") ? ticks + " " : ticks
    }

    private static func codeClosing(for text: String) -> String {
        let ticks = String(repeating: "`", count: longestRun(of: "`", in: text) + 1)
        return text.hasSuffix("`") ? " " + ticks : ticks
    }

    /// Backslash-escapes what would otherwise read as inline syntax. Underscores inside words are
    /// literal already, so `snake_case` stays as typed.
    static func escapingInline(_ text: String) -> String {
        let characters = Array(text)
        var output = ""
        for (index, character) in characters.enumerated() {
            switch character {
            case "\\", "*", "`", "[", "]":
                output.append("\\")
            case "_":
                let before = index > 0 ? characters[index - 1] : nil
                let after = index + 1 < characters.count ? characters[index + 1] : nil
                if !(before?.isLetter == true || before?.isNumber == true)
                    || !(after?.isLetter == true || after?.isNumber == true) {
                    output.append("\\")
                }
            case "~":
                let before = index > 0 ? characters[index - 1] : nil
                let after = index + 1 < characters.count ? characters[index + 1] : nil
                if before == "~" || after == "~" { output.append("\\") }
            case "<":
                if index + 1 < characters.count, characters[index + 1].isLetter { output.append("\\") }
            default:
                break
            }
            output.append(character)
        }
        return output
    }

    /// A paragraph whose text would read as a heading, list item, quote, rule or fence gets the
    /// smallest escape that keeps it a paragraph.
    static func escapingBlockSyntax(_ text: String) -> String {
        let info = TaskNoteMarkdown.LineInfo(text)
        let isBlock = info.kind != .plain
            || TaskNoteMarkdown.isThematicBreak(text)
            || TaskNoteMarkdown.Fence.opening(text) != nil
        guard isBlock else { return text }
        let body = text.drop { $0 == " " || $0 == "\t" }
        let indent = String(text.prefix(text.count - body.count))
        if let first = body.first, first.isNumber {
            // "1. text" stays a paragraph as "1\. text".
            let digits = body.prefix { $0.isNumber }
            return indent + digits + "\\" + body.dropFirst(digits.count)
        }
        return indent + "\\" + body
    }
}
