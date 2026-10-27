import Foundation
import XCTest
@testable import TaskifyCore

/// App-state merge vectors shared with the PWA (C7-3): Bible tracker, Scripture Memory and chat
/// state cases and the merge every client must produce. `app-state-merge-vectors.json` is
/// written by taskify-core (`tests/app-state-merge-vectors.test.ts`) from the PWA's merges.
final class AppStateMergeVectorTests: XCTestCase {
    struct ThreeWay<State: Decodable>: Decodable {
        var name: String
        var base: State?
        var local: State
        var remote: State
        var expected: State
    }

    struct TwoWay<State: Decodable>: Decodable {
        var name: String
        var a: State
        var b: State
        var expected: State
    }

    struct VectorFile: Decodable {
        var bibleTracker: [ThreeWay<BibleTrackerState>]
        var scriptureMemory: [ThreeWay<ScriptureMemoryState>]
        var chatState: [TwoWay<ChatSyncState>]
    }

    private static func load() throws -> VectorFile {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TaskifyCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // taskify-ios-native
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("taskify-core/fixtures/app-state-merge-vectors.json")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }

    func testBibleTrackerMergesMatchThePWA() throws {
        let vectors = try Self.load().bibleTracker
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(vector.local.merged(with: vector.remote, base: vector.base), vector.expected, vector.name)
        }
    }

    func testScriptureMemoryMergesMatchThePWA() throws {
        let vectors = try Self.load().scriptureMemory
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(vector.local.merged(with: vector.remote, base: vector.base), vector.expected, vector.name)
        }
    }

    func testChatStateMergesMatchThePWA() throws {
        let vectors = try Self.load().chatState
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            XCTAssertEqual(vector.a.merged(with: vector.b), vector.expected, vector.name)
            XCTAssertEqual(vector.b.merged(with: vector.a), vector.expected, vector.name)
        }
    }
}
