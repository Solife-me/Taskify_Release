import Foundation

/// Shared physical-board contract, mirrored by `taskify-core/src/boardPrintContract.ts`.
/// Page numbering and the print-job code are checked by scanners so a sheet from another print or
/// board cannot silently complete unrelated tasks.
public enum BoardPrintContract {
    public static let version = "v3"
    public static let maxPages = (1 << 6) - 1
    public static let baseMarginMM = 10.0
    public static let a6BindingMarginMM = 4.0
    public static let markerSizeMM = 6.0
    public static let markerGapMM = 2.0
    public static let headerHeightMM = 11.0
    public static let headerGapMM = 3.5
    public static let rowHeightMM = 7.0
    public static let circleSizeMM = 4.2
    public static let circleTextGapMM = 2.4
    public static let pageIDMarkerSizeMM = 2.4
    public static let pageIDMarkerGapMM = 1.2
    public static let pageIDBits = 6
    public static let jobCodeMarkerSizeMM = 2.0
    public static let jobCodeMarkerGapMM = 1.0
    public static let jobCodeBits = 10

    public static func hash32(_ value: String) -> UInt32 {
        var hash: UInt32 = 0x811c9dc5
        for byte in value.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return hash
    }

    public static func jobCode(jobID: String) -> Int {
        let value = Int(hash32("taskify-board-print:\(version):\(jobID)") & ((1 << UInt32(jobCodeBits)) - 1))
        return value == 0 ? 1 : value
    }

    public static func jobCodePattern(jobID: String) -> [Int] {
        let code = jobCode(jobID: jobID)
        return (0..<jobCodeBits).map { bit in (code >> bit) & 1 }
    }

    public static func pagePattern(pageIndex: Int) -> [Int] {
        let value = max(0, pageIndex) + 1
        return (0..<pageIDBits).map { bit in (value >> bit) & 1 }
    }

    public static func isSupportedVersion(_ value: String) -> Bool {
        value == version || value == "v1" || value == "v2"
    }
}
