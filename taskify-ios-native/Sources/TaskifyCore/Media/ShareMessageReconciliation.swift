import Foundation

public extension TaskifySnapshot {
    /// Prepare a receipt merge without mutating an observed snapshot for duplicates.
    /// A pending share may be inspected many times before every relay acknowledges it.
    /// Returning nil lets callers avoid view invalidation, disk writes and another
    /// share refresh when the receipt adds nothing to the current history.
    func reconcilingSharedMessages(_ messages: [NostrDirectMessage],
                                  now: Int = Int(Date().timeIntervalSince1970)) -> TaskifySnapshot? {
        guard !messages.isEmpty else { return nil }
        var updated = self
        for message in messages {
            _ = updated.ingestDirectMessage(message, now: now)
            if message.deliveryState == .sent {
                _ = updated.setDirectMessageDeliveryState(rumorEventID: message.rumorEventID, state: .sent)
            }
        }
        // Compare the resulting collections rather than trusting the ingest flag, so a
        // receipt that changes nothing never produces a write (and another refresh).
        guard updated.directMessages != directMessages ||
              updated.directMessageDeletedEventIDs != directMessageDeletedEventIDs else { return nil }
        return updated
    }
}
