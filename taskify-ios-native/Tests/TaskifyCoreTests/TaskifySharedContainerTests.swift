import Foundation
import XCTest
@testable import TaskifyCore

/// Stands in for a real App Group container by pointing the lookup at a temp directory, so the
/// migration can be exercised without the capability being provisioned.
private final class StubFileManager: FileManager {
    var groupURL: URL?
    let supportURL: URL

    init(groupURL: URL?, supportURL: URL) {
        self.groupURL = groupURL
        self.supportURL = supportURL
        super.init()
    }

    override func containerURL(forSecurityApplicationGroupIdentifier id: String) -> URL? {
        groupURL
    }

    override func urls(for directory: FileManager.SearchPathDirectory, in domainMask: FileManager.SearchPathDomainMask) -> [URL] {
        directory == .applicationSupportDirectory ? [supportURL] : super.urls(for: directory, in: domainMask)
    }
}

final class TaskifySharedContainerTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("shared-container-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeManager(withGroup: Bool) throws -> (StubFileManager, URL, URL) {
        let group = root.appendingPathComponent("group", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        if withGroup {
            try FileManager.default.createDirectory(at: group, withIntermediateDirectories: true)
        }
        return (StubFileManager(groupURL: withGroup ? group : nil, supportURL: support), group, support)
    }

    private func writeStore(_ contents: String, in directory: URL) throws {
        let dir = directory.appendingPathComponent("TaskifyNative", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try contents.write(
            to: dir.appendingPathComponent(TaskifySharedContainer.storeFilename),
            atomically: true,
            encoding: .utf8
        )
    }

    private func readStore(in directory: URL) -> String? {
        try? String(
            contentsOf: directory
                .appendingPathComponent("TaskifyNative", isDirectory: true)
                .appendingPathComponent(TaskifySharedContainer.storeFilename),
            encoding: .utf8
        )
    }

    // MARK: - Location

    func testUsesTheGroupContainerWhenAvailable() throws {
        let (manager, group, _) = try makeManager(withGroup: true)
        XCTAssertEqual(
            TaskifySharedContainer.storeDirectory(fileManager: manager),
            group.appendingPathComponent("TaskifyNative", isDirectory: true)
        )
    }

    /// The app has to keep working before the capability is enabled, just without widget data.
    func testFallsBackToThePrivateDirectoryWithoutTheGroup() throws {
        let (manager, _, support) = try makeManager(withGroup: false)
        XCTAssertEqual(
            TaskifySharedContainer.storeDirectory(fileManager: manager),
            support.appendingPathComponent("TaskifyNative", isDirectory: true)
        )
        XCTAssertFalse(TaskifySharedContainer.isAvailable(fileManager: manager))
    }

    // MARK: - Migration

    func testCopiesAnExistingStoreIntoTheGroupContainer() throws {
        let (manager, group, support) = try makeManager(withGroup: true)
        try writeStore("{\"boards\":[]}", in: support)

        XCTAssertTrue(TaskifySharedContainer.migrateIfNeeded(fileManager: manager))
        XCTAssertEqual(readStore(in: group), "{\"boards\":[]}")
        // Left in place: if anything went wrong the original is still where the app used to read it.
        XCTAssertEqual(readStore(in: support), "{\"boards\":[]}")
    }

    /// Running again must not clobber newer shared data with the stale private copy.
    func testDoesNotOverwriteAStoreAlreadyInTheGroupContainer() throws {
        let (manager, group, support) = try makeManager(withGroup: true)
        try writeStore("old", in: support)
        try writeStore("current", in: group)

        XCTAssertFalse(TaskifySharedContainer.migrateIfNeeded(fileManager: manager))
        XCTAssertEqual(readStore(in: group), "current")
    }

    func testDoesNothingWhenThereIsNoPreviousStore() throws {
        let (manager, group, _) = try makeManager(withGroup: true)
        XCTAssertFalse(TaskifySharedContainer.migrateIfNeeded(fileManager: manager))
        XCTAssertNil(readStore(in: group))
    }

    func testDoesNothingWithoutTheGroup() throws {
        let (manager, _, support) = try makeManager(withGroup: false)
        try writeStore("data", in: support)
        XCTAssertFalse(TaskifySharedContainer.migrateIfNeeded(fileManager: manager))
    }
}
