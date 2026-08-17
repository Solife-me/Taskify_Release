import Foundation

/// One time-stamped word (or punctuation fragment) reported by a speech recognizer.
///
/// Keeping this small value type in `TaskifyCore` makes the transcript-merging behavior testable
/// without importing Speech or requiring a microphone.
public struct SpeechTranscriptSegment: Equatable, Sendable {
    public var text: String
    public var timestamp: TimeInterval
    public var duration: TimeInterval

    public init(text: String, timestamp: TimeInterval, duration: TimeInterval) {
        self.text = text
        self.timestamp = timestamp
        self.duration = duration
    }

    fileprivate var endTime: TimeInterval {
        timestamp + max(duration, 0)
    }
}

/// Builds a monotonic transcript from Speech framework snapshots.
///
/// `SFSpeechRecognizer` normally returns the whole current hypothesis on every callback. After a
/// natural pause, however, some on-device recognizers return only a newer time range. Treating that
/// callback as the whole transcript makes everything spoken before the pause disappear. This
/// accumulator replaces words only in the time range covered by the newest snapshot and preserves
/// the rest, so ordinary recognition corrections still work without allowing a pause to erase text.
public struct SpeechTranscriptAccumulator: Equatable, Sendable {
    private var segments: [SpeechTranscriptSegment] = []
    private var fallbackTranscript = ""

    public init() {}

    public var transcript: String {
        guard !segments.isEmpty else { return fallbackTranscript }
        return Self.render(segments)
    }

    /// Incorporates the recognizer's newest snapshot and returns the full retained transcript.
    /// `fallbackText` is used only on the unlikely callback where Speech supplies no segments.
    @discardableResult
    public mutating func update(
        segments incomingSegments: [SpeechTranscriptSegment],
        fallbackText: String = ""
    ) -> String {
        let incoming = incomingSegments
            .map {
                SpeechTranscriptSegment(
                    text: $0.text.trimmingCharacters(in: .whitespacesAndNewlines),
                    timestamp: max(0, $0.timestamp),
                    duration: max(0, $0.duration)
                )
            }
            .filter { !$0.text.isEmpty }

        guard !incoming.isEmpty else {
            mergeFallback(fallbackText)
            return transcript
        }

        let incomingStart = incoming.map(\.timestamp).min() ?? 0
        let incomingEnd = incoming.map(\.endTime).max() ?? incomingStart
        // Speech occasionally shifts a word timestamp by a few hundredths of a second while
        // revising it. A small tolerance ensures the old version is replaced, not duplicated.
        let timestampTolerance: TimeInterval = 0.08

        segments.removeAll { existing in
            existing.timestamp >= incomingStart - timestampTolerance
                && existing.timestamp <= incomingEnd + timestampTolerance
        }
        segments.append(contentsOf: incoming)
        segments.sort {
            if abs($0.timestamp - $1.timestamp) < 0.001 {
                return $0.endTime < $1.endTime
            }
            return $0.timestamp < $1.timestamp
        }

        // A segment-based callback is authoritative. Retaining fallback text as well would repeat
        // the same words when a recognizer briefly omitted segments on an earlier callback.
        fallbackTranscript = ""
        return transcript
    }

    public mutating func reset() {
        segments.removeAll(keepingCapacity: true)
        fallbackTranscript = ""
    }

    private mutating func mergeFallback(_ text: String) {
        let incoming = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incoming.isEmpty else { return }

        if fallbackTranscript.isEmpty || incoming.hasPrefix(fallbackTranscript) {
            fallbackTranscript = incoming
            return
        }
        if fallbackTranscript.hasPrefix(incoming) {
            // A temporary shorter hypothesis must not make already-visible speech disappear.
            return
        }

        let oldWords = fallbackTranscript.split(whereSeparator: \Character.isWhitespace).map(String.init)
        let newWords = incoming.split(whereSeparator: \Character.isWhitespace).map(String.init)
        let overlap = Self.longestSuffixPrefixOverlap(oldWords, newWords)
        fallbackTranscript = (oldWords + newWords.dropFirst(overlap)).joined(separator: " ")
    }

    private static func longestSuffixPrefixOverlap(_ left: [String], _ right: [String]) -> Int {
        let limit = min(left.count, right.count)
        guard limit > 0 else { return 0 }

        for count in stride(from: limit, through: 1, by: -1) {
            let suffix = left.suffix(count).map { $0.lowercased() }
            let prefix = right.prefix(count).map { $0.lowercased() }
            if suffix == prefix { return count }
        }
        return 0
    }

    private static func render(_ segments: [SpeechTranscriptSegment]) -> String {
        var output = ""
        let punctuationWithoutLeadingSpace = CharacterSet(charactersIn: ".,!?;:%)]}")
        let openingPunctuation = CharacterSet(charactersIn: "([{\"")

        for segment in segments {
            let fragment = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !fragment.isEmpty else { continue }

            let firstScalar = fragment.unicodeScalars.first
            let lastScalar = output.unicodeScalars.last
            let attachesToPrevious = firstScalar.map(punctuationWithoutLeadingSpace.contains) ?? false
            let followsOpeningPunctuation = lastScalar.map(openingPunctuation.contains) ?? false

            if output.isEmpty || attachesToPrevious || followsOpeningPunctuation {
                output += fragment
            } else {
                output += " " + fragment
            }
        }
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
