import Foundation

/// Selection state for a physical checklist scan. Review state is intentionally independent of
/// the live task store so multiple scanned pages can be verified before any completion is applied.
public struct PhysicalChecklistScanReview: Equatable, Sendable {
    public private(set) var itemIDs: [String]
    public private(set) var selectedIDs: Set<String>

    public init() {
        itemIDs = []
        selectedIDs = []
    }

    /// Merge a page into the review. Only newly detected, incomplete items are selected by
    /// default; completed items stay visible but are never selected or applied.
    public mutating func merge(detectedIDs: [String], items: [PhysicalChecklistItem]) {
        let knownIDs = Set(items.map(\.id))
        let completedIDs = Set(items.lazy.filter(\.filled).map(\.id))
        let detected = Set(detectedIDs).intersection(knownIDs)
        let previousIDs = Set(itemIDs)
        let newlyDetected = detected.subtracting(previousIDs)

        itemIDs = previousIDs.union(detected).sorted()
        selectedIDs.formUnion(newlyDetected.subtracting(completedIDs))
        selectedIDs.subtract(completedIDs)
    }

    public mutating func toggle(itemID: String, items: [PhysicalChecklistItem]) {
        guard let item = items.first(where: { $0.id == itemID }), !item.filled else { return }
        if selectedIDs.contains(itemID) {
            selectedIDs.remove(itemID)
        } else {
            selectedIDs.insert(itemID)
        }
    }

    public mutating func selectAll(items: [PhysicalChecklistItem]) {
        let reviewedIDs = Set(itemIDs)
        selectedIDs = Set(items.lazy.filter { reviewedIDs.contains($0.id) && !$0.filled }.map(\.id))
    }

    public mutating func clearSelection() {
        selectedIDs.removeAll()
    }

    public func reviewedItems(from items: [PhysicalChecklistItem]) -> [PhysicalChecklistItem] {
        let reviewedIDs = Set(itemIDs)
        return items.filter { reviewedIDs.contains($0.id) }
    }

    public func applyableIDs(from items: [PhysicalChecklistItem]) -> [String] {
        items.lazy
            .filter { selectedIDs.contains($0.id) && !$0.filled }
            .map(\.id)
    }
}
