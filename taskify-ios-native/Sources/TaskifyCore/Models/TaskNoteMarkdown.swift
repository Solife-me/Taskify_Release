import Foundation

/// A block of a task note. Notes are Markdown: headings, bullet and numbered lists, GitHub-style
/// checklist items (`- [ ] item`), quotes, fenced code and horizontal rules, with inline bold,
/// italic, strikethrough, code and links. Raw HTML is not interpreted. A single newline is a
/// line break, as notes were plain text before they were Markdown.
///
/// Mirrors `taskify-pwa/src/domains/tasks/noteMarkdown.ts`; keep the two in step so a note
/// reads and edits the same on every client.
public enum TaskNoteBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, content: String)
    case bulletItem(depth: Int, content: String)
    case numberedItem(depth: Int, number: Int, content: String)
    /// `line` is the item's zero-based line in the note: the handle `togglingChecklistItem` takes.
    case checklistItem(depth: Int, checked: Bool, content: String, line: Int)
    case quote(String)
    case code(String)
    case thematicBreak
}

/// A formatting command from the note editor's toolbar, in toolbar order: the commands a
/// narrow screen shows without scrolling come first.
public enum TaskNoteFormat: String, CaseIterable, Sendable {
    case bold, italic, bulletList, numberedList, checklist
    case heading, link, strikethrough, code, quote
}

/// The note text and selection after an editor command. Selections are UTF-16 ranges, the unit
/// `UITextView`, `NSTextView` and the browser all use.
public struct TaskNoteEdit: Equatable, Sendable {
    public var text: String
    public var selection: NSRange

    public init(text: String, selection: NSRange) {
        self.text = text
        self.selection = selection
    }
}

public enum TaskNoteMarkdown {
    // MARK: Reading

    public static func blocks(_ note: String) -> [TaskNoteBlock] {
        var blocks: [TaskNoteBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var code: [String] = []
        var fence: Fence?

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph.removeAll()
        }
        func flushQuote() {
            guard !quote.isEmpty else { return }
            blocks.append(.quote(quote.joined(separator: "\n")))
            quote.removeAll()
        }

        for (index, rawLine) in lines(of: note).enumerated() {
            let line = stripCarriageReturn(rawLine)
            if let open = fence {
                if Fence.closes(line, open) {
                    blocks.append(.code(code.joined(separator: "\n")))
                    code.removeAll()
                    fence = nil
                } else {
                    code.append(line)
                }
                continue
            }
            if let open = Fence.opening(line) {
                flushParagraph()
                flushQuote()
                fence = open
                continue
            }
            if line.allSatisfy(\.isWhitespace) {
                flushParagraph()
                flushQuote()
                continue
            }
            if isThematicBreak(line) {
                flushParagraph()
                flushQuote()
                blocks.append(.thematicBreak)
                continue
            }
            let info = LineInfo(line)
            if case .quote = info.kind {
                flushParagraph()
                quote.append(info.content)
                continue
            }
            flushQuote()
            switch info.kind {
            case .plain:
                paragraph.append(info.content)
            case .heading(let level):
                flushParagraph()
                if !info.content.isEmpty {
                    blocks.append(.heading(level: level, content: info.content))
                }
            case .bullet:
                flushParagraph()
                blocks.append(.bulletItem(depth: info.depth, content: info.content))
            case .numbered(let number, _):
                flushParagraph()
                blocks.append(.numberedItem(depth: info.depth, number: number, content: info.content))
            case .checklist(let checked, _):
                flushParagraph()
                blocks.append(.checklistItem(
                    depth: info.depth,
                    checked: checked,
                    content: info.content,
                    line: index
                ))
            case .quote:
                break
            }
        }
        if fence != nil {
            // An unclosed fence runs to the end of the note, as in CommonMark.
            blocks.append(.code(code.joined(separator: "\n")))
        }
        flushParagraph()
        flushQuote()
        return blocks
    }

    public static func hasChecklistItems(_ note: String) -> Bool {
        blocks(note).contains {
            if case .checklistItem = $0 { return true }
            return false
        }
    }

    /// The note with checklist item `line` ticked or unticked, or nil when that line is not a
    /// checklist item (inside a code block, say, or edited away since it was rendered).
    public static func togglingChecklistItem(in note: String, line: Int) -> String? {
        let isItem = blocks(note).contains {
            if case let .checklistItem(_, _, _, itemLine) = $0 { return itemLine == line }
            return false
        }
        guard isItem else { return nil }
        var all = lines(of: note)
        let info = LineInfo(stripCarriageReturn(all[line]))
        guard case let .checklist(checked, _) = info.kind, let box = info.checkbox else { return nil }
        let scalars = Array(all[line].utf16)
        let replacement = Array((checked ? " " : "x").utf16)
        let updated = scalars[..<box] + replacement + scalars[(box + 1)...]
        all[line] = String(decoding: updated, as: UTF16.self)
        return all.joined(separator: "\n")
    }

    /// Moves every checklist item out of the note into subtasks, keeping each one's ticked state.
    /// Blank lines the removal leaves doubled up are collapsed.
    public static func extractingChecklist(from note: String) -> (note: String, subtasks: [TaskSubtask]) {
        let itemLines = Dictionary(uniqueKeysWithValues: blocks(note).compactMap { block -> (Int, (Bool, String))? in
            if case let .checklistItem(_, checked, content, line) = block { return (line, (checked, content)) }
            return nil
        })
        guard !itemLines.isEmpty else { return (note, []) }

        var kept: [String] = []
        var subtasks: [TaskSubtask] = []
        var removedSinceText = false
        for (index, line) in lines(of: note).enumerated() {
            if let item = itemLines[index] {
                let (checked, content) = item
                let title = plainInline(content).trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty {
                    subtasks.append(TaskSubtask(title: title, completed: checked))
                }
                removedSinceText = true
                continue
            }
            let isBlank = line.allSatisfy(\.isWhitespace)
            if isBlank, removedSinceText, kept.last?.allSatisfy(\.isWhitespace) ?? true {
                continue
            }
            if !isBlank { removedSinceText = false }
            kept.append(line)
        }
        while let last = kept.last, last.allSatisfy(\.isWhitespace) { kept.removeLast() }
        while let first = kept.first, first.allSatisfy(\.isWhitespace) { kept.removeFirst() }
        return (kept.joined(separator: "\n"), subtasks)
    }

    /// Plain text for compact previews such as a task card: Markdown syntax removed, list items
    /// marked with •, ☐ or ☑, and blank lines collapsed.
    public static func previewText(_ note: String) -> String {
        var output: [String] = []
        for block in blocks(note) {
            switch block {
            case .paragraph(let content), .quote(let content):
                output.append(contentsOf: content.components(separatedBy: "\n").map(plainInline))
            case .heading(_, let content):
                output.append(plainInline(content))
            case let .bulletItem(depth, content):
                output.append(indentation(depth) + "• " + plainInline(content))
            case let .numberedItem(depth, number, content):
                output.append(indentation(depth) + "\(number). " + plainInline(content))
            case let .checklistItem(depth, checked, content, _):
                output.append(indentation(depth) + (checked ? "☑ " : "☐ ") + plainInline(content))
            case .code(let content):
                output.append(content)
            case .thematicBreak:
                continue
            }
        }
        return output
            .filter { !$0.allSatisfy(\.isWhitespace) }
            .joined(separator: "\n")
    }

    /// Inline Markdown as plain text: emphasis markers dropped, `[label](url)` reduced to label.
    public static func plainInline(_ markdown: String) -> String {
        guard markdown.contains(where: { "*_~`[<\\!".contains($0) }) else { return markdown }
        guard let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return markdown }
        return String(attributed.characters)
    }

    // MARK: Editing

    public static func applying(_ format: TaskNoteFormat, to text: String, selection: NSRange) -> TaskNoteEdit {
        let selection = clamped(selection, in: text)
        switch format {
        case .bold: return wrapping(text, selection, marker: "**")
        case .italic: return wrapping(text, selection, marker: "*")
        case .strikethrough: return wrapping(text, selection, marker: "~~")
        case .code: return wrapping(text, selection, marker: "`")
        case .link: return insertingLink(text, selection)
        case .heading, .bulletList, .numberedList, .checklist, .quote:
            return prefixingLines(text, selection, format: format)
        }
    }

    /// What Return does on a list or quote line: start the next item, or, on an item with nothing
    /// in it, end the list. Nil when Return should just insert a newline.
    public static func continuingList(in text: String, selection: NSRange) -> TaskNoteEdit? {
        let selection = clamped(selection, in: text)
        guard selection.length == 0 else { return nil }
        let ns = text as NSString
        let lineRange = contentLineRange(ns, at: selection.location)
        let line = ns.substring(with: lineRange)
        let info = LineInfo(line)
        let nextPrefix: String
        switch info.kind {
        case .bullet(let marker): nextPrefix = "\(marker) "
        case .numbered(let number, let delimiter): nextPrefix = "\(number + 1)\(delimiter) "
        case .checklist(_, let marker): nextPrefix = "\(next(listMarker: marker)) [ ] "
        case .quote: nextPrefix = "> "
        case .plain, .heading: return nil
        }
        if info.content.allSatisfy(\.isWhitespace) {
            let updated = ns.replacingCharacters(in: lineRange, with: "")
            return TaskNoteEdit(text: updated, selection: NSRange(location: lineRange.location, length: 0))
        }
        let insertion = "\n" + info.indent + nextPrefix
        let updated = ns.replacingCharacters(in: selection, with: insertion)
        let cursor = selection.location + (insertion as NSString).length
        return TaskNoteEdit(text: updated, selection: NSRange(location: cursor, length: 0))
    }
}

// MARK: - Line structure

extension TaskNoteMarkdown {
    enum LineKind: Equatable {
        case plain
        case heading(Int)
        case bullet(Character)
        case numbered(Int, Character)
        /// `marker` is the list marker before the box: `-`, `*`, `+` or a number like `3.`.
        case checklist(checked: Bool, marker: String)
        case quote
    }

    /// One line split into indentation, block marker and content. Offsets are UTF-16.
    struct LineInfo {
        var indent: String
        var depth: Int
        var kind: LineKind
        var content: String
        /// Where the content starts: the length of indentation plus marker.
        var prefixLength: Int
        /// The offset of the character inside `[ ]` on a checklist line.
        var checkbox: Int?

        init(_ line: String) {
            var columns = 0
            var index = line.startIndex
            while index < line.endIndex, line[index] == " " || line[index] == "\t" {
                columns += line[index] == "\t" ? 4 : 1
                index = line.index(after: index)
            }
            indent = String(line[..<index])
            depth = columns / 2
            let rest = line[index...]
            let indentLength = indent.utf16.count
            kind = .plain
            content = String(rest)
            prefixLength = indentLength
            checkbox = nil

            if let level = Self.headingLevel(rest) {
                kind = .heading(level)
                let after = rest.dropFirst(level)
                let trimmed = after.drop(while: { $0 == " " })
                content = String(trimmed).trimmingCharacters(in: .whitespaces)
                prefixLength = indentLength + level + (after.count - trimmed.count)
                return
            }
            if rest.first == ">" {
                kind = .quote
                var after = rest.dropFirst()
                if after.first == " " { after = after.dropFirst() }
                content = String(after)
                prefixLength = indentLength + (rest.count - after.count)
                return
            }
            guard let (marker, afterMarker) = Self.listMarker(rest) else { return }
            if let (checked, afterBox) = Self.checkboxPrefix(afterMarker) {
                let markerText = String(rest[..<afterMarker.startIndex]).trimmingCharacters(in: .whitespaces)
                kind = .checklist(checked: checked, marker: markerText)
                content = String(afterBox)
                prefixLength = indentLength + rest[..<afterBox.startIndex].utf16.count
                checkbox = indentLength + rest[..<afterMarker.startIndex].utf16.count + 1
                return
            }
            switch marker {
            case .bullet(let character): kind = .bullet(character)
            case .numbered(let number, let delimiter): kind = .numbered(number, delimiter)
            }
            content = String(afterMarker)
            prefixLength = indentLength + rest[..<afterMarker.startIndex].utf16.count
        }

        private enum Marker {
            case bullet(Character)
            case numbered(Int, Character)
        }

        private static func headingLevel(_ rest: Substring) -> Int? {
            let level = rest.prefix { $0 == "#" }.count
            guard (1...6).contains(level) else { return nil }
            let after = rest.dropFirst(level)
            guard after.isEmpty || after.first == " " else { return nil }
            return level
        }

        /// The list marker and what follows its separating space. A bare marker at the end of a
        /// line ("-") counts, so an emptied item still reads as a list item while editing.
        private static func listMarker(_ rest: Substring) -> (Marker, Substring)? {
            guard let first = rest.first else { return nil }
            if first == "-" || first == "*" || first == "+" {
                let after = rest.dropFirst()
                if after.isEmpty { return (.bullet(first), after) }
                guard after.first == " " else { return nil }
                return (.bullet(first), after.dropFirst())
            }
            let digits = rest.prefix { $0.isASCII && $0.isNumber }
            guard (1...9).contains(digits.count), let number = Int(digits) else { return nil }
            let afterDigits = rest.dropFirst(digits.count)
            guard let delimiter = afterDigits.first, delimiter == "." || delimiter == ")" else { return nil }
            let after = afterDigits.dropFirst()
            if after.isEmpty { return (.numbered(number, delimiter), after) }
            guard after.first == " " else { return nil }
            return (.numbered(number, delimiter), after.dropFirst())
        }

        private static func checkboxPrefix(_ text: Substring) -> (Bool, Substring)? {
            let characters = Array(text.prefix(3))
            guard characters.count == 3, characters[0] == "[", characters[2] == "]" else { return nil }
            let checked: Bool
            switch characters[1] {
            case " ": checked = false
            case "x", "X": checked = true
            default: return nil
            }
            let after = text.dropFirst(3)
            if after.isEmpty { return (checked, after) }
            guard after.first == " " else { return nil }
            return (checked, after.dropFirst())
        }
    }

    struct Fence {
        var marker: Character
        var count: Int

        static func opening(_ line: String) -> Fence? {
            let trimmed = line.drop { $0 == " " }
            guard let marker = trimmed.first, marker == "`" || marker == "~" else { return nil }
            let count = trimmed.prefix { $0 == marker }.count
            guard count >= 3 else { return nil }
            // A backtick fence's info string may not contain backticks (CommonMark).
            if marker == "`", trimmed.dropFirst(count).contains("`") { return nil }
            return Fence(marker: marker, count: count)
        }

        static func closes(_ line: String, _ fence: Fence) -> Bool {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let count = trimmed.prefix { $0 == fence.marker }.count
            return count >= fence.count && count == trimmed.count
        }
    }

    static func lines(of note: String) -> [String] {
        note.components(separatedBy: "\n")
    }

    static func stripCarriageReturn(_ line: String) -> String {
        line.hasSuffix("\r") ? String(line.dropLast()) : line
    }

    static func isThematicBreak(_ line: String) -> Bool {
        let compact = line.filter { $0 != " " && $0 != "\t" }
        guard compact.count >= 3, let marker = compact.first, "-*_".contains(marker) else { return false }
        return compact.allSatisfy { $0 == marker }
    }

    static func indentation(_ depth: Int) -> String {
        String(repeating: "  ", count: depth)
    }

    static func next(listMarker marker: String) -> String {
        guard let delimiter = marker.last, delimiter == "." || delimiter == ")",
              let number = Int(marker.dropLast()) else { return marker }
        return "\(number + 1)\(delimiter)"
    }
}

// MARK: - Editing internals

private extension TaskNoteMarkdown {
    static func clamped(_ selection: NSRange, in text: String) -> NSRange {
        let length = (text as NSString).length
        let location = min(max(0, selection.location), length)
        return NSRange(location: location, length: min(max(0, selection.length), length - location))
    }

    /// The line around `location`, without its newline.
    static func contentLineRange(_ ns: NSString, at location: Int) -> NSRange {
        var range = ns.lineRange(for: NSRange(location: location, length: 0))
        if range.length > 0, ns.character(at: range.location + range.length - 1) == 0x0A {
            range.length -= 1
        }
        return range
    }

    static func isSpace(_ unit: unichar) -> Bool {
        unit == 0x20 || unit == 0x09 || unit == 0x0A || unit == 0x0D
    }

    static func isWordCharacter(_ unit: unichar) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return true }
        return CharacterSet.alphanumerics.contains(scalar) || unit == 0x27 // apostrophe
    }

    static func run(of marker: unichar, in ns: NSString, from start: Int, step: Int) -> Int {
        var count = 0
        var index = start
        while index >= 0, index < ns.length, ns.character(at: index) == marker {
            count += 1
            index += step
        }
        return count
    }

    /// Wraps the selection in `marker`, or unwraps it when it is already wrapped. An empty
    /// selection inside a word wraps that word; elsewhere it inserts a pair to type between.
    static func wrapping(_ text: String, _ original: NSRange, marker: String) -> TaskNoteEdit {
        let ns = text as NSString
        var selection = original
        while selection.length > 0, isSpace(ns.character(at: selection.location)) {
            selection.location += 1
            selection.length -= 1
        }
        while selection.length > 0, isSpace(ns.character(at: selection.location + selection.length - 1)) {
            selection.length -= 1
        }
        if selection.length == 0 {
            var start = selection.location
            var end = selection.location
            while start > 0, isWordCharacter(ns.character(at: start - 1)) { start -= 1 }
            while end < ns.length, isWordCharacter(ns.character(at: end)) { end += 1 }
            if start < selection.location, end > selection.location {
                selection = NSRange(location: start, length: end - start)
            }
        }

        let markerLength = (marker as NSString).length
        let markerUnit = (marker as NSString).character(at: 0)
        let end = selection.location + selection.length

        func matches(before: Int, after: Int) -> Bool {
            guard marker.allSatisfy({ $0 == "*" }) else {
                return before >= markerLength && after >= markerLength
            }
            // `*` and `**` share a character: count the whole run so italic never strips half of
            // a bold marker and bold never strips an italic one.
            if markerLength == 2 { return before >= 2 && after >= 2 }
            return (before == 1 || before >= 3) && (after == 1 || after >= 3)
        }

        // Markers just outside the selection.
        let outsideBefore = marker.allSatisfy({ $0 == "*" })
            ? run(of: markerUnit, in: ns, from: selection.location - 1, step: -1)
            : (selection.location >= markerLength
                && ns.substring(with: NSRange(location: selection.location - markerLength, length: markerLength)) == marker
                ? markerLength : 0)
        let outsideAfter = marker.allSatisfy({ $0 == "*" })
            ? run(of: markerUnit, in: ns, from: end, step: 1)
            : (end + markerLength <= ns.length
                && ns.substring(with: NSRange(location: end, length: markerLength)) == marker
                ? markerLength : 0)
        if matches(before: outsideBefore, after: outsideAfter) {
            let afterRange = NSRange(location: end, length: markerLength)
            let beforeRange = NSRange(location: selection.location - markerLength, length: markerLength)
            let updated = (ns.replacingCharacters(in: afterRange, with: "") as NSString)
                .replacingCharacters(in: beforeRange, with: "")
            return TaskNoteEdit(
                text: updated,
                selection: NSRange(location: selection.location - markerLength, length: selection.length)
            )
        }

        // Markers just inside the selection.
        if selection.length >= markerLength * 2 {
            let selected = ns.substring(with: selection) as NSString
            let insideBefore = marker.allSatisfy({ $0 == "*" })
                ? run(of: markerUnit, in: selected, from: 0, step: 1)
                : (selected.hasPrefix(marker) ? markerLength : 0)
            let insideAfter = marker.allSatisfy({ $0 == "*" })
                ? run(of: markerUnit, in: selected, from: selected.length - 1, step: -1)
                : (selected.hasSuffix(marker) ? markerLength : 0)
            if insideBefore < selected.length, matches(before: insideBefore, after: insideAfter) {
                let inner = selected.substring(with: NSRange(
                    location: markerLength,
                    length: selected.length - markerLength * 2
                ))
                let updated = ns.replacingCharacters(in: selection, with: inner)
                return TaskNoteEdit(
                    text: updated,
                    selection: NSRange(location: selection.location, length: (inner as NSString).length)
                )
            }
        }

        let selected = ns.substring(with: selection)
        let updated = ns.replacingCharacters(in: selection, with: marker + selected + marker)
        return TaskNoteEdit(
            text: updated,
            selection: NSRange(location: selection.location + markerLength, length: selection.length)
        )
    }

    static func insertingLink(_ text: String, _ selection: NSRange) -> TaskNoteEdit {
        let ns = text as NSString
        let selected = ns.substring(with: selection).trimmingCharacters(in: .whitespacesAndNewlines)
        if selected.isEmpty {
            let updated = ns.replacingCharacters(in: selection, with: "[](https://)")
            return TaskNoteEdit(text: updated, selection: NSRange(location: selection.location + 1, length: 0))
        }
        if selected.hasPrefix("http://") || selected.hasPrefix("https://") {
            let updated = ns.replacingCharacters(in: selection, with: "[](\(selected))")
            return TaskNoteEdit(text: updated, selection: NSRange(location: selection.location + 1, length: 0))
        }
        let label = "[\(selected)]("
        let updated = ns.replacingCharacters(in: selection, with: label + "https://)")
        let urlStart = selection.location + (label as NSString).length
        return TaskNoteEdit(text: updated, selection: NSRange(location: urlStart, length: 8))
    }

    static func matches(_ kind: LineKind, _ format: TaskNoteFormat) -> Bool {
        switch (kind, format) {
        case (.bullet, .bulletList), (.numbered, .numberedList), (.checklist, .checklist), (.quote, .quote):
            return true
        case (.heading, .heading):
            return true
        default:
            return false
        }
    }

    /// Applies a block format to every line the selection touches. Lines that all have it already
    /// lose it; otherwise each gets it, replacing any other block marker. Headings cycle
    /// H1 → H2 → H3 → plain.
    static func prefixingLines(_ text: String, _ selection: NSRange, format: TaskNoteFormat) -> TaskNoteEdit {
        let ns = text as NSString
        var block = ns.lineRange(for: selection)
        if block.length > 0, ns.character(at: block.location + block.length - 1) == 0x0A {
            block.length -= 1
        }
        let lines = ns.substring(with: block).components(separatedBy: "\n")
        let infos = lines.map(LineInfo.init)
        let filled = infos.enumerated().filter { !lines[$0.offset].allSatisfy(\.isWhitespace) }.map(\.element)
        let targets = filled.isEmpty ? infos : filled
        let removing = format != .heading && targets.allSatisfy { matches($0.kind, format) }

        var headingLevel = 1
        if format == .heading, let first = targets.first, case let .heading(level) = first.kind {
            headingLevel = level >= 3 ? 0 : level + 1
        }

        var number = 1
        if format == .numberedList, block.location > 0 {
            let previous = ns.substring(with: contentLineRange(ns, at: block.location - 1))
            let info = LineInfo(previous)
            if case let .numbered(previousNumber, _) = info.kind { number = previousNumber + 1 }
        }

        var output: [String] = []
        var firstPrefixDelta = 0
        for (index, line) in lines.enumerated() {
            let info = infos[index]
            if lines.count > 1, line.allSatisfy(\.isWhitespace) {
                output.append(line)
                continue
            }
            let prefix: String
            if removing {
                prefix = ""
            } else {
                switch format {
                case .heading: prefix = headingLevel == 0 ? "" : String(repeating: "#", count: headingLevel) + " "
                case .bulletList: prefix = "- "
                case .numberedList:
                    prefix = "\(number). "
                    number += 1
                case .checklist: prefix = "- [ ] "
                case .quote: prefix = "> "
                default: prefix = ""
                }
            }
            let rebuilt = info.indent + prefix + info.content
            if index == 0 {
                firstPrefixDelta = ((info.indent + prefix) as NSString).length - info.prefixLength
            }
            output.append(rebuilt)
        }
        let replacement = output.joined(separator: "\n")
        let updated = ns.replacingCharacters(in: block, with: replacement)

        let newSelection: NSRange
        if selection.length == 0, lines.count == 1 {
            let contentStart = block.location + infos[0].prefixLength + firstPrefixDelta
            newSelection = NSRange(location: max(contentStart, selection.location + firstPrefixDelta), length: 0)
        } else {
            newSelection = NSRange(location: block.location, length: (replacement as NSString).length)
        }
        return TaskNoteEdit(text: updated, selection: newSelection)
    }
}
