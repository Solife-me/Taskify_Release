import XCTest
@testable import TaskifyCore

final class MultiPhotoCaptureSelectionTests: XCTestCase {
    func testSelectionStopsAtTheChatAttachmentLimit() {
        var selection = MultiPhotoCaptureSelection()
        XCTAssertEqual(selection.maximumCount, 10)
        for index in 1...10 {
            XCTAssertTrue(selection.add(), "photo \(index) should fit")
            XCTAssertEqual(selection.count, index)
        }
        XCTAssertFalse(selection.canCapture)
        XCTAssertFalse(selection.add())
        XCTAssertEqual(selection.count, 10)
    }

    func testRemainingSlotsAccountForAttachmentsAlreadyStaged() {
        var selection = MultiPhotoCaptureSelection(maximumCount: 3)
        XCTAssertEqual(selection.remainingCount, 3)
        XCTAssertTrue(selection.add())
        XCTAssertEqual(selection.remainingCount, 2)
        XCTAssertTrue(selection.remove(at: 0))
        XCTAssertEqual(selection.remainingCount, 3)
        XCTAssertFalse(selection.remove(at: 4))
    }

    func testZeroOrOversizedCapacityIsClamped() {
        var zero = MultiPhotoCaptureSelection(maximumCount: 0)
        XCTAssertFalse(zero.canCapture)
        XCTAssertFalse(zero.add())
        XCTAssertEqual(zero.remainingCount, 0)

        let oversized = MultiPhotoCaptureSelection(maximumCount: 100)
        XCTAssertEqual(oversized.maximumCount, MultiPhotoCaptureSelection.maximumCount)
    }

    func testRemoveLastAndEmptyState() {
        var selection = MultiPhotoCaptureSelection(maximumCount: 2)
        XCTAssertTrue(selection.isEmpty)
        XCTAssertFalse(selection.removeLast())
        XCTAssertTrue(selection.add())
        XCTAssertTrue(selection.add())
        XCTAssertTrue(selection.removeLast())
        XCTAssertEqual(selection.count, 1)
        XCTAssertEqual(selection.remainingCount, 1)
    }
}
