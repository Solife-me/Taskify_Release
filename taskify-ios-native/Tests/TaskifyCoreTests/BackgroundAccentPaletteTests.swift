import XCTest
@testable import TaskifyCore

final class BackgroundAccentPaletteTests: XCTestCase {
    func testPaletteExtractionFindsDistinctDominantColors() {
        let pixels = Array(repeating: TaskifyRGBColor(red: 220, green: 45, blue: 55), count: 700)
            + Array(repeating: TaskifyRGBColor(red: 35, green: 175, blue: 85), count: 600)
            + Array(repeating: TaskifyRGBColor(red: 45, green: 90, blue: 220), count: 500)

        let accents = TaskifyBackgroundPaletteExtractor.suggestedAccents(from: pixels)

        XCTAssertEqual(accents.count, 3)
        XCTAssertEqual(Set(accents).count, 3)
        XCTAssertTrue(accents.allSatisfy { $0.relativeLuminance > 0.10 })
    }

    func testPaletteExtractionIsDeterministic() {
        var pixels: [TaskifyRGBColor] = []
        pixels.reserveCapacity(2_600)
        for index in 0..<2_600 {
            pixels.append(TaskifyRGBColor(
                red: UInt8((index * 17) % 256),
                green: UInt8((index * 31) % 256),
                blue: UInt8((index * 47) % 256)
            ))
        }

        XCTAssertEqual(
            TaskifyBackgroundPaletteExtractor.suggestedAccents(from: pixels),
            TaskifyBackgroundPaletteExtractor.suggestedAccents(from: pixels)
        )
    }

    func testDarkBackgroundColorIsNormalizedForControls() throws {
        let accent = try XCTUnwrap(TaskifyBackgroundPaletteExtractor.suggestedAccents(
            from: Array(repeating: TaskifyRGBColor(red: 10, green: 22, blue: 45), count: 400)
        ).first)

        XCTAssertGreaterThan(accent.relativeLuminance, 0.15)
        XCTAssertTrue(accent.hex.hasPrefix("#"))
        XCTAssertEqual(accent.hex.count, 7)
    }

    func testRequestedCountAndEmptyInputAreHandled() {
        XCTAssertTrue(TaskifyBackgroundPaletteExtractor.suggestedAccents(
            from: [TaskifyRGBColor(red: 10, green: 20, blue: 30)],
            count: 0
        ).isEmpty)
        XCTAssertEqual(
            TaskifyBackgroundPaletteExtractor.suggestedAccents(from: []).count,
            1
        )
    }
}
