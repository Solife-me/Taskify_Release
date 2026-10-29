import Testing
@testable import TaskifyCore

private let reviewItems = [
    PhysicalChecklistItem(id: "a", title: "First"),
    PhysicalChecklistItem(id: "completed", title: "Already done", filled: true),
    PhysicalChecklistItem(id: "b", title: "Second"),
]

@Test func physicalChecklistReviewMergesPagesAndSelectsOnlyIncompleteItems() {
    var review = PhysicalChecklistScanReview()

    review.merge(detectedIDs: ["a", "completed"], items: reviewItems)
    review.merge(detectedIDs: ["a", "b", "completed"], items: reviewItems)

    #expect(review.itemIDs == ["a", "b", "completed"])
    #expect(review.selectedIDs == ["a", "b"])
    #expect(review.applyableIDs(from: reviewItems) == ["a", "b"])
}

@Test func physicalChecklistReviewSupportsManualVerificationControls() {
    var review = PhysicalChecklistScanReview()
    review.merge(detectedIDs: ["a", "b", "completed", "unknown"], items: reviewItems)

    review.toggle(itemID: "a", items: reviewItems)
    review.toggle(itemID: "completed", items: reviewItems)
    #expect(review.selectedIDs == ["b"])

    review.selectAll(items: reviewItems)
    #expect(review.selectedIDs == ["a", "b"])

    review.clearSelection()
    #expect(review.applyableIDs(from: reviewItems).isEmpty)
}
