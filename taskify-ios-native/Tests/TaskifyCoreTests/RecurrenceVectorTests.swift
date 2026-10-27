import Foundation
import XCTest
@testable import TaskifyCore

/// Every client must compute the same next due date and occurrence id for a recurring task, or
/// two devices completing the same instance create two different next tasks. The vectors are
/// shared with taskify-core's Node tests (`tests/recurrence-core.test.ts`).
final class RecurrenceVectorTests: XCTestCase {
    private struct VectorFile: Decodable {
        let vectors: [Vector]
    }

    private struct Vector: Decodable {
        let name: String
        let currentISO: String
        let rule: TaskRecurrence
        let dueTimeEnabled: Bool
        let timeZone: String
        let seriesId: String
        let expectedNextISO: String?
        let expectedInstanceId: String?
    }

    private static let vectorsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // TaskifyCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // taskify-ios-native
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("taskify-core/fixtures/recurrence-vectors.json")

    private static func parseISO(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try XCTUnwrap(formatter.date(from: value), "Unparseable ISO date \(value)")
    }

    func testRecurrenceMatchesSharedVectors() throws {
        let data = try Data(contentsOf: Self.vectorsURL)
        let file = try JSONDecoder().decode(VectorFile.self, from: data)
        XCTAssertFalse(file.vectors.isEmpty)

        for vector in file.vectors {
            let current = try Self.parseISO(vector.currentISO)
            let next = vector.rule.nextOccurrence(
                after: current,
                dueTimeEnabled: vector.dueTimeEnabled,
                timeZoneIdentifier: vector.timeZone
            )
            guard let expectedISO = vector.expectedNextISO else {
                XCTAssertNil(next, vector.name)
                continue
            }
            let expected = try Self.parseISO(expectedISO)
            let actual = try XCTUnwrap(next, vector.name)
            XCTAssertEqual(actual.timeIntervalSince1970, expected.timeIntervalSince1970, accuracy: 0.001, vector.name)
            XCTAssertEqual(
                TaskifySnapshot.recurringInstanceID(
                    seriesID: vector.seriesId,
                    dueDate: actual,
                    recurrence: vector.rule,
                    timeZoneIdentifier: vector.timeZone
                ),
                vector.expectedInstanceId,
                vector.name
            )
        }
    }
}
