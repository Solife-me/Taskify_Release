import Foundation

public struct TaskifySpokenTaskRequest: Equatable, Sendable {
    public var title: String
    public var requestedBoardName: String?

    public init(title: String, requestedBoardName: String?) {
        self.title = title
        self.requestedBoardName = requestedBoardName
    }
}

public struct TaskifySpokenTaskBatchRequest: Equatable, Sendable {
    public var titles: [String]
    public var requestedBoardName: String?
    /// Items beyond the bounded intent payload. Callers must reject the entire request when this
    /// is nonzero so Siri never reports success after silently dropping dictated tasks.
    public var omittedCount: Int

    public init(titles: [String], requestedBoardName: String?, omittedCount: Int = 0) {
        self.titles = titles
        self.requestedBoardName = requestedBoardName
        self.omittedCount = omittedCount
    }
}

/// Interprets the natural sentence Siri may provide after asking for a task name.
///
/// App Intents treats a String response as an opaque value. If somebody answers Siri with
/// “Add \"Buy milk\" to my Groceries board”, the entire sentence otherwise becomes the task
/// title. This parser deliberately uses the user's actual board names as anchors, so it can split
/// the sentence without guessing that ordinary words in a task title are board names.
public enum TaskifySpokenTaskRequestParser {
    public static func parse(
        _ input: String,
        explicitlyRequestedBoardName: String? = nil,
        visibleBoardNames: [String]
    ) -> TaskifySpokenTaskRequest {
        parse(
            input,
            explicitlyRequestedBoardName: explicitlyRequestedBoardName,
            visibleBoardNames: visibleBoardNames,
            preservesTaskList: false
        )
    }

    fileprivate static func parsePreservingTaskList(
        _ input: String,
        explicitlyRequestedBoardName: String? = nil,
        visibleBoardNames: [String]
    ) -> TaskifySpokenTaskRequest {
        parse(
            input,
            explicitlyRequestedBoardName: explicitlyRequestedBoardName,
            visibleBoardNames: visibleBoardNames,
            preservesTaskList: true
        )
    }

    private static func parse(
        _ input: String,
        explicitlyRequestedBoardName: String?,
        visibleBoardNames: [String],
        preservesTaskList: Bool
    ) -> TaskifySpokenTaskRequest {
        let input = removingTaskifyInvocationSuffix(
            from: input.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let explicitBoard = nonempty(explicitlyRequestedBoardName)

        // A board supplied by a structured Shortcuts field must always win. We still unwrap a
        // naturally spoken quoted title, but never reinterpret the requested destination.
        if let explicitBoard {
            return TaskifySpokenTaskRequest(
                title: spokenTitleWithoutDestination(
                    from: input,
                    boardName: nil,
                    preservesTaskList: preservesTaskList
                ),
                requestedBoardName: explicitBoard
            )
        }

        let matchedBoard = visibleBoardNames
            .compactMap(nonempty)
            .sorted { $0.count > $1.count }
            .first { containsBoardName($0, in: input) }

        return TaskifySpokenTaskRequest(
            title: spokenTitleWithoutDestination(
                from: input,
                boardName: matchedBoard,
                preservesTaskList: preservesTaskList
            ),
            requestedBoardName: matchedBoard
        )
    }

    private static func spokenTitleWithoutDestination(
        from input: String,
        boardName: String?,
        preservesTaskList: Bool
    ) -> String {
        if !preservesTaskList, let quoted = firstQuotedValue(in: input), beginsLikeTaskCommand(input) {
            return quoted
        }

        if let boardName {
            let board = NSRegularExpression.escapedPattern(for: boardName)
            let command = "(?:please\\s+)?(?:add|create|make|put)"
            let taskWords = "(?:\\s+(?:a\\s+)?(?:new\\s+)?task)?"
            let appWords = "(?:\\s+(?:in|to)\\s+taskify)?"
            let destination = "(?:to|in|on)\\s+(?:(?:my|the)\\s+)?\(board)(?:\\s+(?:board|list|tasks?))?"
            let titleLead = "(?:called|named|titled|titles)"
            let patterns = [
                // Add a task in Taskify to my Work Tasks board titled Test
                "^\\s*\(command)\(taskWords)\(appWords)\\s+\(destination)\\s+\(titleLead)\\s+(.+?)\\s*$",
                // Add Test to my Work Tasks board
                "^\\s*\(command)\(taskWords)\\s+(?:\(titleLead)\\s+)?(.+?)\\s+\(destination)\\s*$",
                // In Taskify, add Test to my Work Tasks board
                "^\\s*(?:in\\s+taskify[, ]+)?\(command)\(taskWords)\\s+(?:\(titleLead)\\s+)?(.+?)\\s+\(destination)\\s*$",
            ]

            for pattern in patterns {
                if let capture = firstCapture(in: input, pattern: pattern) {
                    return preservesTaskList ? capture : unwrapQuotes(capture)
                }
            }
        }

        // This also makes a terse follow-up such as “Add buy milk” behave naturally, while the
        // parser remains opt-in so a manually configured Shortcut can still use a literal title
        // beginning with “Add”.
        if beginsLikeTaskCommand(input) {
            let patterns = [
                "^\\s*(?:please\\s+)?(?:add|create|make|put)\\s+(?:a\\s+)?(?:new\\s+)?task\\s+(?:called|named|titled|titles)\\s+(.+?)\\s*$",
                "^\\s*(?:please\\s+)?(?:add|create|make|put)\\s+(?:a\\s+)?(?:new\\s+)?task\\s+(.+?)\\s*$",
                "^\\s*(?:please\\s+)?(?:add|create|make|put)\\s+(.+?)\\s*$",
            ]
            for pattern in patterns {
                if let capture = firstCapture(in: input, pattern: pattern) {
                    return preservesTaskList ? capture : unwrapQuotes(capture)
                }
            }
        }

        return preservesTaskList ? input.trimmingCharacters(in: .whitespacesAndNewlines) : unwrapQuotes(input)
    }

    private static func containsBoardName(_ boardName: String, in input: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: boardName)
        let pattern = "(?i)(?<![\\p{L}\\p{N}])\(escaped)(?![\\p{L}\\p{N}])"
        return firstMatch(in: input, pattern: pattern) != nil
    }

    private static func beginsLikeTaskCommand(_ input: String) -> Bool {
        firstMatch(
            in: input,
            pattern: "(?i)^\\s*(?:(?:in|using)\\s+taskify[, ]+)?(?:please\\s+)?(?:add|create|make|put)\\b"
        ) != nil
    }

    private static func firstQuotedValue(in input: String) -> String? {
        firstCapture(in: input, pattern: "[\\\"“‘]([^\\\"”’]+)[\\\"”’]")
            .map(unwrapQuotes)
    }

    private static func removingTaskifyInvocationSuffix(from input: String) -> String {
        guard let expression = try? NSRegularExpression(
            pattern: "(?i)\\s+(?:in|to|on|using|with)\\s+taskify[.!?]*\\s*$"
        ) else { return input }
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        return expression.stringByReplacingMatches(
            in: input,
            range: range,
            withTemplate: ""
        )
    }

    private static func firstCapture(in input: String, pattern: String) -> String? {
        guard let match = firstMatch(in: input, pattern: "(?i)\(pattern)"),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: input) else {
            return nil
        }
        return String(input[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func firstMatch(in input: String, pattern: String) -> NSTextCheckingResult? {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return nil }
        return expression.firstMatch(
            in: input,
            range: NSRange(input.startIndex..<input.endIndex, in: input)
        )
    }

    private static func unwrapQuotes(_ value: String) -> String {
        value.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r\"'“”‘’"))
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

/// Splits the one free-form value captured by Taskify's batch Siri intent into task titles.
///
/// The batch intent is deliberately one String instead of an App Intents collection. Siri often
/// resolves a collection by asking for each value separately, which defeats voice capture such as
/// “standup, planning, and retrospective”. Because the user explicitly chose *Add Multiple Tasks*,
/// commas and conjunctions are list separators here. Quoted titles remain intact, so
/// “Research and Development” can still be one item.
public enum TaskifySpokenTaskBatchParser {
    public static let maximumTaskCount = 20

    public static func parse(
        _ input: String,
        explicitlyRequestedBoardName: String? = nil,
        visibleBoardNames: [String]
    ) -> TaskifySpokenTaskBatchRequest {
        let request = TaskifySpokenTaskRequestParser.parsePreservingTaskList(
            input,
            explicitlyRequestedBoardName: explicitlyRequestedBoardName,
            visibleBoardNames: visibleBoardNames
        )
        var text = request.title.trimmingCharacters(in: .whitespacesAndNewlines)
        text = replacing(
            "(?i)^(?:these|the following|multiple|several)\\s+tasks?\\s*(?::|are)?\\s*",
            in: text,
            with: ""
        )

        let allTitles = splitOutsideQuotes(text)
            .map(cleanItem)
            .filter { !$0.isEmpty }
        let titles = Array(allTitles.prefix(maximumTaskCount))

        return TaskifySpokenTaskBatchRequest(
            titles: titles,
            requestedBoardName: request.requestedBoardName,
            omittedCount: max(0, allTitles.count - titles.count)
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
        let words = ["and then", "then add", "next task", "also add", "and", "then"]
        for word in words where rest.lowercased().hasPrefix(word) {
            let end = input.index(index, offsetBy: word.count)
            let beforeIsBoundary = index == input.startIndex || !input[input.index(before: index)].isLetter
            let afterIsBoundary = end == input.endIndex || !input[end].isLetter
            if beforeIsBoundary && afterIsBoundary { return end }
        }
        return nil
    }

    private static func cleanItem(_ input: String) -> String {
        let leadingAndTrailing = CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: "-•"))
        var item = input.trimmingCharacters(in: leadingAndTrailing)
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
        item = item.trimmingCharacters(in: punctuation)
        return item
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

    private static func replacing(_ pattern: String, in input: String, with template: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return input }
        return expression.stringByReplacingMatches(
            in: input,
            range: NSRange(input.startIndex..<input.endIndex, in: input),
            withTemplate: template
        )
    }
}
