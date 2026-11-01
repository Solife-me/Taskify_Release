import Foundation

/// Tracks the slots available to one chat camera session. Images stay in the UI layer; this model
/// owns only the limits and count so the ten-attachment rule can be tested without camera APIs.
public struct MultiPhotoCaptureSelection: Equatable, Sendable {
    public static let maximumCount = NostrDirectMessageAttachment.maximumBatchCount

    public let maximumCount: Int
    public private(set) var count: Int

    public init(maximumCount: Int = Self.maximumCount) {
        self.maximumCount = min(max(0, maximumCount), Self.maximumCount)
        count = 0
    }

    public var canCapture: Bool { count < maximumCount }
    public var remainingCount: Int { max(0, maximumCount - count) }
    public var isEmpty: Bool { count == 0 }

    @discardableResult
    public mutating func add() -> Bool {
        guard canCapture else { return false }
        count += 1
        return true
    }

    @discardableResult
    public mutating func remove(at index: Int) -> Bool {
        guard index >= 0, index < count else { return false }
        count -= 1
        return true
    }

    public mutating func removeLast() -> Bool {
        guard count > 0 else { return false }
        count -= 1
        return true
    }
}
