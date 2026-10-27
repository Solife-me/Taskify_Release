import Foundation
import XCTest
@testable import TaskifyCore

/// The equal-timestamp rule shared with the PWA (C7-3). `event-version-vectors.json` is written
/// by taskify-core (`tests/event-version-vectors.test.ts`) from `compareEventVersions` and
/// `nextEventCreatedAt`.
final class EventVersionVectorTests: XCTestCase {
    struct Vector: Decodable {
        var name: String
        var a: EventVersion
        var b: EventVersion
        var expected: Int
    }

    struct NextCreatedAt: Decodable {
        var name: String
        var now: Int
        var previous: Int?
        var expected: Int
    }

    struct VectorFile: Decodable {
        var vectors: [Vector]
        var nextCreatedAt: [NextCreatedAt]
    }

    private func vectorFile() throws -> VectorFile {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TaskifyCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // taskify-ios-native
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("taskify-core/fixtures/event-version-vectors.json")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }

    func testIOSOrdersVersionsLikeThePWA() throws {
        let vectors = try vectorFile().vectors
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(EventVersion.compare(vector.a, vector.b), vector.expected, vector.name)
            XCTAssertEqual(EventVersion.compare(vector.b, vector.a), -vector.expected, vector.name)
        }
    }

    func testIOSStampsNewVersionsLikeThePWAAndCLI() throws {
        let vectors = try vectorFile().nextCreatedAt
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(EventVersion.nextCreatedAt(now: vector.now, previous: vector.previous), vector.expected, vector.name)
        }
    }
}
