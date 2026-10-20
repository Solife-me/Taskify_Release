import Foundation
import XCTest
@testable import TaskifyCore

/// The equal-timestamp rule shared with the PWA (C7-3). `event-version-vectors.json` is written
/// by taskify-core (`tests/event-version-vectors.test.ts`) from `compareEventVersions`.
final class EventVersionVectorTests: XCTestCase {
    struct Vector: Decodable {
        var name: String
        var a: EventVersion
        var b: EventVersion
        var expected: Int
    }

    struct VectorFile: Decodable {
        var vectors: [Vector]
    }

    func testIOSOrdersVersionsLikeThePWA() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TaskifyCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // taskify-ios-native
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("taskify-core/fixtures/event-version-vectors.json")
        let vectors = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url)).vectors
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(EventVersion.compare(vector.a, vector.b), vector.expected, vector.name)
            XCTAssertEqual(EventVersion.compare(vector.b, vector.a), -vector.expected, vector.name)
        }
    }
}
