import Foundation

public struct TaskifyWatchSpokenTaskBatch: Equatable, Sendable {
    public let titles: [String]
    public let omittedCount: Int

    public init(titles: [String], omittedCount: Int) {
        self.titles = titles
        self.omittedCount = omittedCount
    }
}

/// Splits one Siri value into several task titles without asking for every item separately.
///
/// A collection parameter makes Siri resolve the collection interactively, which is awkward on
/// Apple Watch. The shortcut therefore captures one free-form value and separates it locally.
/// Quoted conjunctions remain one title: `"Research and Development", planning` is two tasks.
public enum TaskifyWatchSpokenTaskBatchParser {
    public static let maximumTaskCount = 20

    public static func parse(_ input: String) -> TaskifyWatchSpokenTaskBatch {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        text = replacing(
            "(?i)^(?:these|the following|multiple|several)\\s+tasks?\\s*(?::|are)?\\s*",
            in: text,
            with: ""
        )
        let allTitles = splitOutsideQuotes(text)
            .map(cleanItem)
            .filter { !$0.isEmpty }
        return TaskifyWatchSpokenTaskBatch(
            titles: Array(allTitles.prefix(maximumTaskCount)),
            omittedCount: max(0, allTitles.count - maximumTaskCount)
        )
    }

    private static func splitOutsideQuotes(_ input: String) -> [String] {
        var result: [String] = []
        var current = ""
        var quote: Character?
        var index = input.startIndex

        func finishItem() {
            let item = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !item.isEmpty { result.append(item) }
            current = ""
        }

        while index < input.endIndex {
            let character = input[index]
            if let activeQuote = quote {
                if closes(character, quote: activeQuote) {
                    quote = nil
                } else {
                    current.append(character)
                }
                index = input.index(after: index)
                continue
            }
            if isOpeningQuote(character) {
                quote = character
                index = input.index(after: index)
                continue
            }
            if character == "," || character == ";" || character.isNewline {
                finishItem()
                index = input.index(after: index)
                continue
            }
            if let separatorEnd = conjunctionEnd(in: input, from: index) {
                finishItem()
                index = separatorEnd
                continue
            }
            current.append(character)
            index = input.index(after: index)
        }
        finishItem()
        return result
    }

    private static func conjunctionEnd(in input: String, from index: String.Index) -> String.Index? {
        let rest = input[index...]
        for word in ["and then", "then add", "next task", "also add", "and", "then"]
        where rest.lowercased().hasPrefix(word) {
            let end = input.index(index, offsetBy: word.count)
            let beforeIsBoundary = index == input.startIndex || !input[input.index(before: index)].isLetter
            let afterIsBoundary = end == input.endIndex || !input[end].isLetter
            if beforeIsBoundary && afterIsBoundary { return end }
        }
        return nil
    }

    private static func cleanItem(_ input: String) -> String {
        let edgeCharacters = CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: "-•"))
        var item = input.trimmingCharacters(in: edgeCharacters)
        item = replacing(
            "(?i)^(?:(?:first|second|third|fourth|fifth|next|finally)|\\d{1,2}[.)])\\s*",
            in: item,
            with: ""
        )
        item = replacing(
            "(?i)^(?:add|create|make|put)\\s+(?:(?:a|another|the)\\s+)?(?:new\\s+)?(?:task\\s+)?",
            in: item,
            with: ""
        )
        let punctuation = CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: ",;:.!?\"'“”‘’"))
        return item.trimmingCharacters(in: punctuation)
    }

    private static func isOpeningQuote(_ character: Character) -> Bool {
        ["\"", "“", "‘"].contains(character)
    }

    private static func closes(_ character: Character, quote: Character) -> Bool {
        switch quote {
        case "“": character == "”"
        case "‘": character == "’"
        default: character == quote
        }
    }

    private static func replacing(_ pattern: String, in input: String, with replacement: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return input }
        return expression.stringByReplacingMatches(
            in: input,
            range: NSRange(input.startIndex..<input.endIndex, in: input),
            withTemplate: replacement
        )
    }
}
