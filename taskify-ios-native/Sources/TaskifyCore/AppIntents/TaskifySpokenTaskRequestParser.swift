import Foundation

public struct TaskifySpokenTaskRequest: Equatable, Sendable {
    public var title: String
    public var requestedBoardName: String?

    public init(title: String, requestedBoardName: String?) {
        self.title = title
        self.requestedBoardName = requestedBoardName
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
        let input = removingTaskifyInvocationSuffix(
            from: input.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let explicitBoard = nonempty(explicitlyRequestedBoardName)

        // A board supplied by a structured Shortcuts field must always win. We still unwrap a
        // naturally spoken quoted title, but never reinterpret the requested destination.
        if let explicitBoard {
            return TaskifySpokenTaskRequest(
                title: spokenTitleWithoutDestination(from: input, boardName: nil),
                requestedBoardName: explicitBoard
            )
        }

        let matchedBoard = visibleBoardNames
            .compactMap(nonempty)
            .sorted { $0.count > $1.count }
            .first { containsBoardName($0, in: input) }

        return TaskifySpokenTaskRequest(
            title: spokenTitleWithoutDestination(from: input, boardName: matchedBoard),
            requestedBoardName: matchedBoard
        )
    }

    private static func spokenTitleWithoutDestination(
        from input: String,
        boardName: String?
    ) -> String {
        if let quoted = firstQuotedValue(in: input), beginsLikeTaskCommand(input) {
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
                    return unwrapQuotes(capture)
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
                    return unwrapQuotes(capture)
                }
            }
        }

        return unwrapQuotes(input)
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
            pattern: "(?i)\\s+(?:in|using|with)\\s+taskify[.!?]*\\s*$"
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
