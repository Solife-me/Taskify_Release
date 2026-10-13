import SwiftUI
import TaskifyCore
#if os(iOS)
import UIKit
typealias NoteFont = UIFont
typealias NoteColor = UIColor
typealias NoteImage = UIImage
typealias NoteFontDescriptor = UIFontDescriptor
#else
import AppKit
typealias NoteFont = NSFont
typealias NoteColor = NSColor
typealias NoteImage = NSImage
typealias NoteFontDescriptor = NSFontDescriptor
#endif

// The rich note editor's text model, shared by the iOS and Mac apps (see
// taskify-macos/Scripts/generate-project.py). Formatting lives on the text as attributes, never as
// Markdown syntax, so typing and deleting can't break it; Markdown is produced only on save
// (TaskNoteDocument).
//
// Each line's kind is stored on every character of the line, its newline included. Lines with a
// visual marker (bullet, number, checkbox, quote bar, rule) start with one U+FFFC attachment
// character that draws it; deleting that character is how a list item turns back into text,
// which is what backspace at the start of an item does, as in Apple Notes.

extension NSAttributedString.Key {
    /// The line's style as a `TaskNoteLineStyle.token`.
    static let taskNoteLine = NSAttributedString.Key("taskify.note.line")
    /// Marks the marker attachment character at the start of a marker line.
    static let taskNoteMarker = NSAttributedString.Key("taskify.note.marker")
    /// `TaskNoteRun.Marks` raw value.
    static let taskNoteMarks = NSAttributedString.Key("taskify.note.marks")
    /// A link's URL string.
    static let taskNoteLink = NSAttributedString.Key("taskify.note.link")
}

struct TaskNoteLineStyle: Equatable {
    var kind: TaskNoteLine.Kind
    var depth: Int

    static let paragraph = TaskNoteLineStyle(kind: .paragraph, depth: 0)

    var hasMarker: Bool {
        switch kind {
        case .bullet, .numbered, .checklist, .quote, .rule: true
        case .paragraph, .heading, .code: false
        }
    }

    var token: String {
        switch kind {
        case .paragraph: "p"
        case .heading(let level): "h:\(level)"
        case .bullet: "b:\(depth)"
        case .numbered(let number): "n:\(depth):\(number)"
        case .checklist(let checked): "c:\(depth):\(checked ? 1 : 0)"
        case .quote: "q"
        case .code: "code"
        case .rule: "rule"
        }
    }

    init(kind: TaskNoteLine.Kind, depth: Int) {
        self.kind = kind
        self.depth = depth
    }

    init(token: String?) {
        let parts = (token ?? "p").split(separator: ":").map(String.init)
        let depth = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        switch parts.first {
        case "h": self.init(kind: .heading(depth == 0 ? 1 : depth), depth: 0)
        case "b": self.init(kind: .bullet, depth: depth)
        case "n": self.init(kind: .numbered(parts.count > 2 ? Int(parts[2]) ?? 1 : 1), depth: depth)
        case "c": self.init(kind: .checklist(checked: parts.count > 2 && parts[2] == "1"), depth: depth)
        case "q": self.init(kind: .quote, depth: 0)
        case "code": self.init(kind: .code, depth: 0)
        case "rule": self.init(kind: .rule, depth: 0)
        default: self.init(kind: .paragraph, depth: 0)
        }
    }

    /// Whether `other` is the same kind of block, ignoring checked state, numbers and depth:
    /// what the toolbar's list buttons toggle.
    func sameFamily(as other: TaskNoteLineStyle) -> Bool {
        switch (kind, other.kind) {
        case (.paragraph, .paragraph), (.heading, .heading), (.bullet, .bullet), (.numbered, .numbered),
             (.checklist, .checklist), (.quote, .quote), (.code, .code), (.rule, .rule):
            true
        default:
            false
        }
    }
}

/// Look and feel of the editor's text. iOS uses Taskify's dark theme; the Mac follows the system.
struct TaskNoteRichTextTheme {
    var bodySize: CGFloat
    var text: NoteColor
    var secondary: NoteColor
    var accent: NoteColor
    var codeBackground: NoteColor

    static var current: TaskNoteRichTextTheme {
        #if os(iOS)
        TaskNoteRichTextTheme(
            bodySize: NoteFont.preferredFont(forTextStyle: .body).pointSize,
            text: .label,
            secondary: .secondaryLabel,
            accent: UIColor(TaskifyTheme.accent),
            codeBackground: UIColor.white.withAlphaComponent(0.1)
        )
        #else
        TaskNoteRichTextTheme(
            bodySize: NSFont.systemFontSize + 1,
            text: .labelColor,
            secondary: .secondaryLabelColor,
            accent: .controlAccentColor,
            codeBackground: NSColor.labelColor.withAlphaComponent(0.08)
        )
        #endif
    }
}

/// A line marker's image, tagged with what it shows so normalizing reuses it when unchanged.
final class TaskNoteMarkerAttachment: NSTextAttachment {
    var signature = ""
}

enum TaskNoteRichText {
    static let markerCharacter = "\u{FFFC}"
    private static let markerUnit: unichar = 0xFFFC
    private static let newlineUnit: unichar = 0x0A

    // MARK: Model conversion

    static func attributedString(fromMarkdown markdown: String, theme: TaskNoteRichTextTheme, width: CGFloat) -> NSMutableAttributedString {
        attributedString(from: TaskNoteDocument.lines(fromMarkdown: markdown), theme: theme, width: width)
    }

    static func attributedString(from lines: [TaskNoteLine], theme: TaskNoteRichTextTheme, width: CGFloat) -> NSMutableAttributedString {
        let output = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            let style = TaskNoteLineStyle(kind: line.kind, depth: line.depth)
            let token = style.token as NSString
            if style.hasMarker {
                output.append(NSAttributedString(string: markerCharacter, attributes: [
                    .taskNoteLine: token,
                    .taskNoteMarker: true,
                ]))
            }
            if style.kind != .rule {
                for run in line.runs {
                    var attributes: [NSAttributedString.Key: Any] = [
                        .taskNoteLine: token,
                        .taskNoteMarks: run.marks.rawValue,
                    ]
                    if let link = run.link { attributes[.taskNoteLink] = link }
                    output.append(NSAttributedString(string: run.text, attributes: attributes))
                }
            }
            if index < lines.count - 1 {
                output.append(NSAttributedString(string: "\n", attributes: [.taskNoteLine: token]))
            }
        }
        normalize(output, theme: theme, width: width)
        return output
    }

    static func markdown(from text: NSAttributedString) -> String {
        TaskNoteDocument.markdown(from: lines(from: text))
    }

    static func lines(from text: NSAttributedString) -> [TaskNoteLine] {
        lineRanges(in: text.string as NSString).map { range in
            let style = lineStyle(in: text, lineRange: range)
            var runs: [TaskNoteRun] = []
            text.enumerateAttributes(in: range) { attributes, runRange, _ in
                guard attributes[.taskNoteMarker] == nil else { return }
                let marks = TaskNoteRun.Marks(rawValue: (attributes[.taskNoteMarks] as? Int) ?? 0)
                let link = attributes[.taskNoteLink] as? String
                let string = (text.string as NSString).substring(with: runRange)
                    .replacingOccurrences(of: markerCharacter, with: "")
                guard !string.isEmpty else { return }
                runs.append(TaskNoteRun(string, marks: style.kind == .code ? [] : marks, link: style.kind == .code ? nil : link))
            }
            var kind = style.kind
            if case .heading = kind, runs.isEmpty { kind = .paragraph }
            return TaskNoteLine(kind: kind, depth: style.depth, runs: runs)
        }
    }

    // MARK: Lines

    /// Each line's range, without its newline. An empty document is one empty line.
    static func lineRanges(in string: NSString) -> [NSRange] {
        var ranges: [NSRange] = []
        var start = 0
        for index in 0..<string.length where string.character(at: index) == newlineUnit {
            ranges.append(NSRange(location: start, length: index - start))
            start = index + 1
        }
        ranges.append(NSRange(location: start, length: string.length - start))
        return ranges
    }

    static func lineRange(in string: NSString, containing location: Int) -> NSRange {
        let clamped = min(max(0, location), string.length)
        var start = clamped
        while start > 0, string.character(at: start - 1) != newlineUnit { start -= 1 }
        var end = clamped
        while end < string.length, string.character(at: end) != newlineUnit { end += 1 }
        return NSRange(location: start, length: end - start)
    }

    static func hasMarker(_ text: NSAttributedString, lineRange: NSRange) -> Bool {
        lineRange.length > 0
            && (text.string as NSString).character(at: lineRange.location) == markerUnit
            && text.attribute(.taskNoteMarker, at: lineRange.location, effectiveRange: nil) != nil
    }

    /// A line's style: its marker's, else its first character's or, for an empty line, its
    /// newline's. A marker style whose marker is gone (deleted, or never inserted) reads as a
    /// paragraph: that is how backspacing a bullet makes plain text.
    static func lineStyle(in text: NSAttributedString, lineRange: NSRange) -> TaskNoteLineStyle {
        let length = text.length
        let probe: Int?
        if lineRange.length > 0 {
            probe = lineRange.location
        } else if lineRange.location < length {
            probe = lineRange.location
        } else {
            probe = nil
        }
        guard let probe else { return .paragraph }
        let style = TaskNoteLineStyle(token: text.attribute(.taskNoteLine, at: probe, effectiveRange: nil) as? String)
        if style.hasMarker, !hasMarker(text, lineRange: lineRange) { return .paragraph }
        return style
    }

    /// Where a line's content starts: after its marker, if it has one.
    static func contentStart(_ text: NSAttributedString, lineRange: NSRange) -> Int {
        hasMarker(text, lineRange: lineRange) ? lineRange.location + 1 : lineRange.location
    }

    // MARK: Normalizing and styling

    /// Makes the text consistent after any edit: one style per line, markers only at line
    /// starts, numbering in sequence, and every visual attribute derived from the model ones.
    /// Returns the character ranges of stray markers it removed, so callers can do so through
    /// the text view; it removes none itself when `removeStrayMarkers` is false.
    @discardableResult
    static func normalize(
        _ text: NSMutableAttributedString,
        theme: TaskNoteRichTextTheme,
        width: CGFloat,
        removeStrayMarkers: Bool = true
    ) -> [NSRange] {
        // A marker belongs only at the start of a line whose style draws one. Undo and redo can
        // bring the character back without its attribute, so a well-placed one is repaired, and
        // any other U+FFFC is stray.
        var strayMarkers: [NSRange] = []
        let string = text.string as NSString
        for range in lineRanges(in: string) where range.length > 0 {
            for index in range.location..<NSMaxRange(range) where string.character(at: index) == markerUnit {
                let style = TaskNoteLineStyle(token: text.attribute(.taskNoteLine, at: index, effectiveRange: nil) as? String)
                if index == range.location, style.hasMarker {
                    text.addAttribute(.taskNoteMarker, value: true, range: NSRange(location: index, length: 1))
                } else {
                    strayMarkers.append(NSRange(location: index, length: 1))
                }
            }
        }
        if removeStrayMarkers {
            for range in strayMarkers.reversed() { text.deleteCharacters(in: range) }
        }

        text.beginEditing()
        defer { text.endEditing() }
        let ranges = lineRanges(in: text.string as NSString)
        var previousNumbered: (depth: Int, number: Int)?
        for range in ranges {
            let style = lineStyle(in: text, lineRange: range)
            // The line's style on all of it and its newline; a marker line that lost its marker
            // becomes a paragraph here.
            let fullRange = NSRange(location: range.location, length: min(range.length + 1, text.length - range.location))
            if fullRange.length > 0 {
                text.addAttribute(.taskNoteLine, value: style.token, range: fullRange)
            }

            var number: Int?
            if case .numbered(let start) = style.kind {
                let next = previousNumbered.flatMap { $0.depth == style.depth ? $0.number + 1 : nil } ?? start
                number = next
                previousNumbered = (style.depth, next)
            } else {
                previousNumbered = nil
            }
            restyle(text, lineRange: range, style: style, number: number, theme: theme, width: width)
        }
        return strayMarkers
    }

    private static func restyle(
        _ text: NSMutableAttributedString,
        lineRange: NSRange,
        style: TaskNoteLineStyle,
        number: Int?,
        theme: TaskNoteRichTextTheme,
        width: CGFloat
    ) {
        let fullRange = NSRange(location: lineRange.location, length: min(lineRange.length + 1, text.length - lineRange.location))
        guard fullRange.length > 0 else { return }
        let lineFont = font(for: style, marks: [], theme: theme)
        let markerWidth = (theme.bodySize * 1.6).rounded()
        let indent = CGFloat(style.depth) * (theme.bodySize * 1.25).rounded()

        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = 3
        paragraph.firstLineHeadIndent = indent
        paragraph.headIndent = style.hasMarker && style.kind != .rule ? indent + markerWidth : indent
        if case .heading = style.kind { paragraph.paragraphSpacingBefore = 6 }

        for key: NSAttributedString.Key in [.foregroundColor, .strikethroughStyle, .backgroundColor, .underlineStyle, .baselineOffset] {
            text.removeAttribute(key, range: fullRange)
        }
        text.addAttributes([.paragraphStyle: paragraph, .font: lineFont, .foregroundColor: theme.text], range: fullRange)

        let checked: Bool
        if case .checklist(let isChecked) = style.kind { checked = isChecked } else { checked = false }
        text.enumerateAttributes(in: fullRange) { attributes, range, _ in
            if attributes[.taskNoteMarker] != nil {
                let markerWidthNeeded = style.kind == .rule ? max(40, width - indent - 8) : markerWidth
                let signature = "\(style.token)|\(number ?? 0)|\(lineFont.pointSize)|\(markerWidthNeeded)"
                if (attributes[.attachment] as? TaskNoteMarkerAttachment)?.signature != signature {
                    let attachment = markerAttachment(style: style, number: number, checked: checked, font: lineFont, theme: theme, width: markerWidthNeeded, markerWidth: markerWidth)
                    attachment.signature = signature
                    text.addAttribute(.attachment, value: attachment, range: range)
                }
                return
            }
            text.removeAttribute(.attachment, range: range)
            let marks = TaskNoteRun.Marks(rawValue: (attributes[.taskNoteMarks] as? Int) ?? 0)
            var visual: [NSAttributedString.Key: Any] = [.font: font(for: style, marks: marks, theme: theme)]
            if style.kind == .quote { visual[.foregroundColor] = theme.secondary }
            if checked {
                visual[.foregroundColor] = theme.secondary
                visual[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if style.kind != .code {
                if marks.contains(.strikethrough) { visual[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if marks.contains(.code) { visual[.backgroundColor] = theme.codeBackground }
                if attributes[.taskNoteLink] != nil {
                    visual[.foregroundColor] = theme.accent
                    visual[.underlineStyle] = NSUnderlineStyle.single.rawValue
                }
            } else {
                visual[.backgroundColor] = theme.codeBackground
            }
            text.addAttributes(visual, range: range)
        }
    }

    static func font(for style: TaskNoteLineStyle, marks: TaskNoteRun.Marks, theme: TaskNoteRichTextTheme) -> NoteFont {
        let size = theme.bodySize
        if style.kind == .code || marks.contains(.code) {
            return NoteFont.monospacedSystemFont(ofSize: size - 1, weight: .regular)
        }
        var base: NoteFont
        switch style.kind {
        case .heading(let level):
            let scale: CGFloat = level == 1 ? 1.55 : level == 2 ? 1.3 : 1.12
            base = NoteFont.systemFont(ofSize: (size * scale).rounded(), weight: .bold)
        default:
            base = NoteFont.systemFont(ofSize: size, weight: marks.contains(.bold) ? .semibold : .regular)
        }
        if case .heading = style.kind, marks.contains(.bold) { base = NoteFont.systemFont(ofSize: base.pointSize, weight: .heavy) }
        let italic = marks.contains(.italic) || style.kind == .quote
        guard italic else { return base }
        #if os(iOS)
        guard let descriptor = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.traitItalic)) else { return base }
        return NoteFont(descriptor: descriptor, size: base.pointSize)
        #else
        let descriptor = base.fontDescriptor.withSymbolicTraits(base.fontDescriptor.symbolicTraits.union(.italic))
        return NoteFont(descriptor: descriptor, size: base.pointSize) ?? base
        #endif
    }

    // MARK: Markers

    private static func markerAttachment(
        style: TaskNoteLineStyle,
        number: Int?,
        checked: Bool,
        font: NoteFont,
        theme: TaskNoteRichTextTheme,
        width: CGFloat,
        markerWidth: CGFloat
    ) -> TaskNoteMarkerAttachment {
        let attachment = TaskNoteMarkerAttachment()
        let lineHeight = font.ascender - font.descender
        let size: CGSize
        if style.kind == .rule {
            size = CGSize(width: width, height: lineHeight)
        } else {
            size = CGSize(width: markerWidth, height: lineHeight)
        }
        attachment.image = markerImage(style: style, number: number, checked: checked, font: font, theme: theme, size: size)
        attachment.bounds = CGRect(x: 0, y: font.descender, width: size.width, height: size.height)
        return attachment
    }

    private static func markerImage(
        style: TaskNoteLineStyle,
        number: Int?,
        checked: Bool,
        font: NoteFont,
        theme: TaskNoteRichTextTheme,
        size: CGSize
    ) -> NoteImage {
        let draw: (CGContext) -> Void = { context in
            // Drawing happens in a top-left-origin space on both platforms (see renderImage).
            // Markers centre on the x-height above the text baseline.
            let baselineMid = size.height - (-font.descender) - font.xHeight / 2
            switch style.kind {
            case .bullet:
                let diameter = max(5, font.pointSize * 0.33)
                let rect = CGRect(x: size.width * 0.35 - diameter / 2, y: baselineMid - diameter / 2, width: diameter, height: diameter)
                context.setFillColor(theme.secondary.cgColor)
                if style.depth % 2 == 1 {
                    context.setStrokeColor(theme.secondary.cgColor)
                    context.setLineWidth(1.2)
                    context.strokeEllipse(in: rect.insetBy(dx: 0.6, dy: 0.6))
                } else {
                    context.fillEllipse(in: rect)
                }
            case .numbered:
                drawText("\(number ?? 1).", in: CGRect(origin: .zero, size: size), font: NoteFont.monospacedDigitSystemFont(ofSize: font.pointSize, weight: .medium), color: theme.secondary, context: context)
            case .checklist:
                let side = (font.pointSize * 1.05).rounded()
                let rect = CGRect(x: 1, y: baselineMid - side / 2, width: side, height: side)
                let path = CGPath(roundedRect: rect, cornerWidth: side * 0.24, cornerHeight: side * 0.24, transform: nil)
                if checked {
                    context.setFillColor(theme.accent.cgColor)
                    context.addPath(path)
                    context.fillPath()
                    context.setStrokeColor(NoteColor.white.cgColor)
                    context.setLineWidth(max(1.6, side * 0.12))
                    context.setLineCap(.round)
                    context.setLineJoin(.round)
                    context.move(to: CGPoint(x: rect.minX + side * 0.26, y: rect.midY + side * 0.02))
                    context.addLine(to: CGPoint(x: rect.minX + side * 0.43, y: rect.minY + side * 0.72))
                    context.addLine(to: CGPoint(x: rect.minX + side * 0.76, y: rect.minY + side * 0.3))
                    context.strokePath()
                } else {
                    context.setStrokeColor(theme.secondary.cgColor)
                    context.setLineWidth(1.4)
                    context.addPath(CGPath(roundedRect: rect.insetBy(dx: 0.7, dy: 0.7), cornerWidth: side * 0.24, cornerHeight: side * 0.24, transform: nil))
                    context.strokePath()
                }
            case .quote:
                context.setFillColor(theme.accent.withAlphaComponent(0.7).cgColor)
                context.fill(CGRect(x: 2, y: 0, width: 3, height: size.height))
            case .rule:
                context.setFillColor(theme.secondary.withAlphaComponent(0.5).cgColor)
                context.fill(CGRect(x: 0, y: (size.height / 2).rounded(), width: size.width, height: 1))
            case .paragraph, .heading, .code:
                break
            }
        }
        return renderImage(size: size, draw: draw)
    }

    private static func drawText(_ string: String, in rect: CGRect, font: NoteFont, color: NoteColor, context: CGContext) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .right
        let attributed = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
        let height = font.ascender - font.descender
        attributed.draw(in: CGRect(x: 0, y: rect.height - height, width: rect.width - font.pointSize * 0.35, height: height))
    }

    private static func renderImage(size: CGSize, draw: @escaping (CGContext) -> Void) -> NoteImage {
        #if os(iOS)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { draw($0.cgContext) }
        #else
        return NSImage(size: size, flipped: true) { _ in
            if let context = NSGraphicsContext.current?.cgContext { draw(context) }
            return true
        }
        #endif
    }

    // MARK: Fragments for paste and copy

    /// Pasted text as formatted lines: Markdown from Taskify or anywhere else keeps its
    /// formatting; plain text stays plain.
    static func pastedFragment(_ string: String, theme: TaskNoteRichTextTheme, width: CGFloat) -> NSMutableAttributedString {
        attributedString(fromMarkdown: string, theme: theme, width: width)
    }

    /// A selection as Markdown, so copying a checklist and pasting it elsewhere reads as one.
    static func markdown(of text: NSAttributedString, range: NSRange) -> String {
        guard range.length > 0 else { return "" }
        let selected = text.attributedSubstring(from: range)
        // A selection that starts mid-line keeps only that line's content; whole lines keep
        // their kinds.
        let string = text.string as NSString
        let line = lineRange(in: string, containing: range.location)
        if range.location > contentStart(text, lineRange: line), !(selected.string.contains("\n")) {
            return TaskNoteDocument.inlineMarkdown(lines(from: selected).first?.runs ?? [])
        }
        return markdown(from: selected)
    }
}
