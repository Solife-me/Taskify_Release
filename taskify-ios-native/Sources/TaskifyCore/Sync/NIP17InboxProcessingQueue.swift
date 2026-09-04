import Foundation

/// Keeps live arrivals ahead of recovery without discarding history or sorting by the
/// gift wrap's randomized timestamp. Crypto is drained in small, independently applied batches.
public struct NIP17InboxProcessingQueue: Sendable {
    private var live: [NostrEvent] = []
    private var history: [NostrEvent] = []
    private var liveOffset = 0
    private var historyOffset = 0
    private var queuedIDs: Set<String> = []
    private var knownIDs: Set<String>
    private var recentProcessedIDs: [String] = []

    public init(knownEventIDs: Set<String> = []) {
        knownIDs = knownEventIDs
    }

    public var isEmpty: Bool { liveOffset == live.count && historyOffset == history.count }

    public mutating func enqueue(_ events: [NostrEvent], isHistory: Bool) {
        for event in events where !knownIDs.contains(event.id) {
            guard queuedIDs.insert(event.id).inserted else { continue }
            if isHistory { history.append(event) } else { live.append(event) }
        }
    }

    public mutating func nextBatch(maximumCount: Int = 8) -> [NostrEvent] {
        let limit = max(1, maximumCount)
        var result: [NostrEvent] = []
        // Leave one slot for recovery so sustained live traffic cannot starve older messages.
        let liveLimit = historyOffset < history.count ? max(1, limit - 1) : limit
        while result.count < liveLimit, liveOffset < live.count {
            let event = live[liveOffset]
            liveOffset += 1
            queuedIDs.remove(event.id)
            if !knownIDs.contains(event.id) { result.append(event) }
        }
        while result.count < limit, historyOffset < history.count {
            let event = history[historyOffset]
            historyOffset += 1
            queuedIDs.remove(event.id)
            if !knownIDs.contains(event.id) { result.append(event) }
        }
        if liveOffset == live.count { live.removeAll(keepingCapacity: true); liveOffset = 0 }
        if historyOffset == history.count { history.removeAll(keepingCapacity: true); historyOffset = 0 }
        return result
    }

    public mutating func recordProcessed(_ eventIDs: [String]) {
        for id in eventIDs where knownIDs.insert(id).inserted { recentProcessedIDs.append(id) }
        if recentProcessedIDs.count > 5_000 {
            let overflow = recentProcessedIDs.count - 5_000
            knownIDs.subtract(recentProcessedIDs.prefix(overflow))
            recentProcessedIDs.removeFirst(overflow)
        }
    }
}

public extension TaskifySnapshot {
    /// Skip crypto for saved ordinary messages. Payment-bearing messages must still replay:
    /// their wallet journal may need to recover from an earlier disk/write failure.
    func savedNonPaymentInboxEventIDs() -> Set<String> {
        var result = Set((directMessages ?? []).compactMap { message -> String? in
            guard message.isIncoming || message.deliveryState == .sent,
                  CashuPaymentRequestContract.paymentPayloadJSON(from: message.content) == nil,
                  CashuPaymentRequestContract.extractReceivableToken(from: message.content) == nil else {
                return nil
            }
            return message.wrapEventID
        })
        result.formUnion((directMessageReactions ?? []).map(\.wrapEventID))
        result.formUnion((sharedInboxItems ?? []).map(\.wrapEventID))
        result.formUnion((sharedContactInboxItems ?? []).map(\.wrapEventID))
        result.formUnion((sharedCalendarInviteItems ?? []).map(\.wrapEventID))
        result.formUnion((sharedBoardInboxItems ?? []).map(\.wrapEventID))
        return result
    }
}
