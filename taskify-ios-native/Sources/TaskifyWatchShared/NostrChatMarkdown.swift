import Foundation

public struct NostrChatMarkdownDocument: Equatable, Sendable {
    public var blocks: [NostrChatMarkdownBlock]

    public init(blocks: [NostrChatMarkdownBlock]) {
        self.blocks = blocks
    }
}

public enum NostrChatMarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, content: String)
    case unorderedListItem(depth: Int, content: String)
    case orderedListItem(depth: Int, number: Int, content: String)
    case blockQuote(depth: Int, content: String)
    case codeBlock(language: String?, content: String)
    case thematicBreak
}

public enum NostrChatMarkdown {
    private static let copyScheme = "taskify-copy-code"
    private static let copyHost = "inline"

    public static func document(_ markdown: String) -> NostrChatMarkdownDocument {
        var parser = Parser(markdown: markdown)
        return NostrChatMarkdownDocument(blocks: parser.parse())
    }

    public static func inlineAttributedString(_ markdown: String) -> AttributedString {
        do {
            return try AttributedString(
                markdown: markdown,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
            )
        } catch {
            return AttributedString(markdown)
        }
    }

    public static func copyURL(for code: String) -> URL? {
        guard !code.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = copyScheme
        components.host = copyHost
        components.queryItems = [URLQueryItem(name: "value", value: code)]
        return components.url
    }

    public static func copiedCode(from url: URL) -> String? {
        guard url.scheme?.lowercased() == copyScheme,
              url.host?.lowercased() == copyHost,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        return components.queryItems?.first { $0.name == "value" }?.value
    }
}

private extension NostrChatMarkdown {
    struct Fence {
        var marker: Character
        var count: Int
        var language: String?
    }

    struct Parser {
        private let lines: [String]
        private var blocks: [NostrChatMarkdownBlock] = []
        private var paragraphLines: [String] = []
        private var index = 0

        init(markdown: String) {
            let normalized = markdown
                .replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\r", with: "\n")
            lines = normalized.components(separatedBy: "\n")
        }

        mutating func parse() -> [NostrChatMarkdownBlock] {
            while index < lines.count {
                let line = lines[index]
                if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    flushParagraph()
                    index += 1
                    continue
                }
                if let fence = Self.openingFence(in: line) {
                    flushParagraph()
                    parseCodeBlock(opening: fence)
                    continue
                }
                if Self.isThematicBreak(line) {
                    flushParagraph()
                    blocks.append(.thematicBreak)
                    index += 1
                    continue
                }
                if let heading = Self.heading(in: line) {
                    flushParagraph()
                    blocks.append(.heading(level: heading.level, content: heading.content))
                    index += 1
                    continue
                }
                if let quote = Self.blockQuote(in: line) {
                    flushParagraph()
                    blocks.append(.blockQuote(depth: quote.depth, content: quote.content))
                    index += 1
                    continue
                }
                if let item = Self.unorderedListItem(in: line) {
                    flushParagraph()
                    blocks.append(.unorderedListItem(depth: item.depth, content: item.content))
                    index += 1
                    continue
                }
                if let item = Self.orderedListItem(in: line) {
                    flushParagraph()
                    blocks.append(.orderedListItem(
                        depth: item.depth,
                        number: item.number,
                        content: item.content
                    ))
                    index += 1
                    continue
                }
                paragraphLines.append(line.trimmingCharacters(in: .whitespaces))
                index += 1
            }
            flushParagraph()
            return blocks
        }

        private mutating func parseCodeBlock(opening fence: Fence) {
            index += 1
            var codeLines: [String] = []
            while index < lines.count {
                let line = lines[index]
                if Self.isClosingFence(line, for: fence) {
                    index += 1
                    break
                }
                codeLines.append(line)
                index += 1
            }
            blocks.append(.codeBlock(
                language: fence.language,
                content: codeLines.joined(separator: "\n")
            ))
        }

        private mutating func flushParagraph() {
            guard !paragraphLines.isEmpty else { return }
            var content = ""
            for line in paragraphLines {
                guard !content.isEmpty else {
                    content = line
                    continue
                }
                if content.hasSuffix("  ") || content.hasSuffix("\\") {
                    content += "\n\(line)"
                } else {
                    content += " \(line)"
                }
            }
            blocks.append(.paragraph(content))
            paragraphLines.removeAll(keepingCapacity: true)
        }

        private static func openingFence(in line: String) -> Fence? {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let marker = trimmed.first, marker == "`" || marker == "~" else { return nil }
            let count = trimmed.prefix { $0 == marker }.count
            guard count >= 3 else { return nil }
            let remainder = trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces)
            return Fence(
                marker: marker,
                count: count,
                language: remainder.isEmpty ? nil : remainder
            )
        }

        private static func isClosingFence(_ line: String, for fence: Fence) -> Bool {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let count = trimmed.prefix { $0 == fence.marker }.count
            guard count >= fence.count else { return false }
            return trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces).isEmpty
        }

        private static func heading(in line: String) -> (level: Int, content: String)? {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let level = trimmed.prefix { $0 == "#" }.count
            guard (1...6).contains(level), trimmed.count > level else { return nil }
            let contentStart = trimmed.index(trimmed.startIndex, offsetBy: level)
            guard trimmed[contentStart].isWhitespace else { return nil }
            let content = trimmed[contentStart...].trimmingCharacters(in: .whitespaces)
            guard !content.isEmpty else { return nil }
            return (level, content)
        }

        private static func blockQuote(in line: String) -> (depth: Int, content: String)? {
            var remainder = line.trimmingCharacters(in: .whitespaces)
            var depth = 0
            while remainder.first == ">" {
                depth += 1
                remainder.removeFirst()
                remainder = remainder.trimmingCharacters(in: .whitespaces)
            }
            guard depth > 0 else { return nil }
            return (depth, remainder)
        }

        private static func unorderedListItem(in line: String) -> (depth: Int, content: String)? {
            let (depth, content) = indentedContent(in: line)
            guard content.count >= 2,
                  let marker = content.first,
                  marker == "-" || marker == "*" || marker == "+" else { return nil }
            let separator = content.index(after: content.startIndex)
            guard content[separator].isWhitespace else { return nil }
            return (
                depth,
                content[separator...].trimmingCharacters(in: .whitespaces)
            )
        }

        private static func orderedListItem(
            in line: String
        ) -> (depth: Int, number: Int, content: String)? {
            let (depth, content) = indentedContent(in: line)
            let digits = content.prefix { $0.isNumber }
            guard !digits.isEmpty,
                  digits.count <= 9,
                  let number = Int(digits) else { return nil }
            let markerIndex = content.index(content.startIndex, offsetBy: digits.count)
            guard markerIndex < content.endIndex,
                  content[markerIndex] == "." || content[markerIndex] == ")" else { return nil }
            let separator = content.index(after: markerIndex)
            guard separator < content.endIndex, content[separator].isWhitespace else { return nil }
            return (
                depth,
                number,
                content[separator...].trimmingCharacters(in: .whitespaces)
            )
        }

        private static func indentedContent(in line: String) -> (depth: Int, content: Substring) {
            var columns = 0
            var contentStart = line.startIndex
            while contentStart < line.endIndex, line[contentStart].isWhitespace {
                columns += line[contentStart] == "\t" ? 4 : 1
                contentStart = line.index(after: contentStart)
            }
            return (columns / 2, line[contentStart...])
        }

        private static func isThematicBreak(_ line: String) -> Bool {
            let compact = line.filter { !$0.isWhitespace }
            guard compact.count >= 3, let marker = compact.first,
                  marker == "-" || marker == "*" || marker == "_" else { return false }
            return compact.allSatisfy { $0 == marker }
        }
    }
}
