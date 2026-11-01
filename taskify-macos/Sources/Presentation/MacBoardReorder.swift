import Foundation

/// Computes the final index for a board dragged before or after another board.
public enum MacBoardReorder {
    public static func finalIndex(
        orderedBoardIDs: [String],
        movingBoardID: String,
        targetBoardID: String,
        placeAfter: Bool
    ) -> Int? {
        guard orderedBoardIDs.count == Set(orderedBoardIDs).count,
              let sourceIndex = orderedBoardIDs.firstIndex(of: movingBoardID),
              let targetIndex = orderedBoardIDs.firstIndex(of: targetBoardID) else {
            return nil
        }
        guard sourceIndex != targetIndex else { return sourceIndex }

        let adjustedTarget = targetIndex - (sourceIndex < targetIndex ? 1 : 0)
        let requestedIndex = adjustedTarget + (placeAfter ? 1 : 0)
        return min(max(requestedIndex, 0), orderedBoardIDs.count - 1)
    }
}
