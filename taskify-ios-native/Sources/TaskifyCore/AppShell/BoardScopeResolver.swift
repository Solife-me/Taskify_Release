import Foundation

public enum BoardScopeResolver {
    /// Mirrors the PWA's boardScopeIds behavior for the native board model.
    /// Compound boards include their own ID plus every linked child board ID.
    public static func scopedBoardIDs(
        currentBoardId: String,
        kind: String?,
        childBoardIDs: [String]
    ) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []

        func append(_ value: String) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return }
            ordered.append(trimmed)
        }

        append(currentBoardId)

        if kind == "compound" {
            for childBoardID in childBoardIDs {
                append(childBoardID)
            }
        }

        return ordered
    }
}
