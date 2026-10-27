import Foundation
import XCTest
@testable import TaskifyCore

/// C7-5: the store keeps one file per area, written only when it changed.
final class TaskifyStoreSplitTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var legacyURL: URL { directory.appendingPathComponent(TaskifySharedContainer.storeFilename) }
    private var splitDirectory: URL { directory.appendingPathComponent(JSONTaskStore.splitDirectoryName, isDirectory: true) }
    private func areaURL(_ area: TaskifyStoreArea) -> URL { splitDirectory.appendingPathComponent("\(area.rawValue).json") }
    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
    private func contents(_ url: URL) -> Data? { FileManager.default.contents(atPath: url.path) }

    private func message(_ number: Int) -> NostrDirectMessage {
        NostrDirectMessage(
            rumorEventID: "rumor-\(number)", wrapEventID: "wrap-\(number)",
            peerPublicKey: String(repeating: "a", count: 64), senderPublicKey: String(repeating: "b", count: 64),
            content: "Message \(number): see you at the usual place after work", createdAt: 1_790_000_000 + number,
            isIncoming: number % 2 == 0
        )
    }

    private func populated() -> TaskifySnapshot {
        var snapshot = TaskifySnapshot.empty
        snapshot.tasks = [TaskItem(id: "t1", boardID: snapshot.selectedBoardID, title: "Buy milk")]
        snapshot.directMessages = [message(1), message(2)]
        snapshot.directMessageReadAt = ["peer": 10]
        snapshot.directMessageBlockedPeers = ["blocked"]
        snapshot.contactsListUpdatedAt = 42
        snapshot.contactsListExtraTags = [["t", "x"]]
        snapshot.recurringTaskSeriesCutoffs = ["board": ["series": Date(timeIntervalSince1970: 1_790_000_000)]]
        return snapshot
    }

    func testEverySnapshotFieldBelongsToExactlyOneArea() {
        let snapshotFields = Set(Mirror(reflecting: TaskifySnapshot.empty).children.compactMap(\.label))
        let areas = TaskifySnapshotAreas(.empty)
        let areaFields = [
            Mirror(reflecting: areas.tasks).children.compactMap(\.label),
            Mirror(reflecting: areas.chat).children.compactMap(\.label),
            Mirror(reflecting: areas.inbox).children.compactMap(\.label),
        ]
        XCTAssertEqual(Set(areaFields.joined()), snapshotFields, "a new snapshot field needs an area")
        XCTAssertEqual(areaFields.joined().count, snapshotFields.count, "no field may be in two areas")
    }

    func testChangedAreasNameOnlyWhatChanged() {
        let base = populated()
        var chat = base
        chat.directMessageArchivedAt = ["peer": 5]
        XCTAssertEqual(chat.changedAreas(from: base), [.chat])
        var task = base
        task.tasks[0].title = "Buy bread"
        XCTAssertEqual(task.changedAreas(from: base), [.tasks])
        var contacts = base
        contacts.contactsListUpdatedAt = 99
        XCTAssertEqual(contacts.changedAreas(from: base), [.inbox])
        XCTAssertEqual(base.changedAreas(from: base), [])
    }

    func testASnapshotRoundTripsThroughTheSplitStore() async throws {
        let store = JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true)
        let snapshot = populated()
        try await store.save(snapshot)
        XCTAssertTrue(exists(areaURL(.tasks)) && exists(areaURL(.chat)) && exists(areaURL(.inbox)))
        XCTAssertFalse(exists(legacyURL))
        let reloaded = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(reloaded, snapshot)
    }

    func testTheAppSplitsALegacyStoreAtLoad() async throws {
        let snapshot = populated()
        try JSONEncoder().encode(snapshot).write(to: legacyURL)
        let loaded = try await JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true).load()
        XCTAssertEqual(loaded, snapshot)
        XCTAssertFalse(exists(legacyURL), "removed only after the split store is complete")
        let readAgain = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(readAgain, snapshot)
    }

    func testAnInterruptedSplitLeavesTheLegacyStoreInCharge() async throws {
        let snapshot = populated()
        try JSONEncoder().encode(snapshot).write(to: legacyURL)
        // Area files written, but the marker never was: the split did not finish.
        try FileManager.default.createDirectory(at: splitDirectory, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: areaURL(.tasks))
        let loaded = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(loaded, snapshot)
        let migrated = try await JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true).load()
        XCTAssertEqual(migrated, snapshot)
        let readAgain = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(readAgain, snapshot)
    }

    func testAnExtensionKeepsWritingTheLegacyStoreUntilTheAppSplitsIt() async throws {
        try JSONEncoder().encode(populated()).write(to: legacyURL)
        let widget = JSONTaskStore(fileURL: legacyURL)
        var snapshot = try await widget.load(areas: [.tasks])
        XCTAssertEqual(snapshot.directMessages?.count, 2, "the legacy file holds every area")
        snapshot.tasks[0].completed = true
        try await widget.save(snapshot)
        XCTAssertFalse(exists(splitDirectory))
        let reloaded = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(reloaded.tasks[0].completed, true)
        XCTAssertEqual(reloaded.directMessages?.count, 2)
    }

    func testOnlyChangedAreasAreWritten() async throws {
        let app = JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true)
        var snapshot = populated()
        try await app.save(snapshot)
        let chatBefore = try XCTUnwrap(contents(areaURL(.chat)))

        snapshot.tasks[0].title = "Buy oat milk"
        let afterTaskEdit = try await app.save(snapshot)
        XCTAssertEqual(afterTaskEdit, [.tasks])

        snapshot.directMessages?.append(message(3))
        let afterMessage = try await app.save(snapshot)
        XCTAssertEqual(afterMessage, [.chat])
        XCTAssertNotEqual(contents(areaURL(.chat)), chatBefore)

        let unchanged = try await app.save(snapshot)
        XCTAssertEqual(unchanged, [])
    }

    func testAProcessThatLoadedOnlyTasksNeverWritesTheOtherAreas() async throws {
        let app = JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true)
        var appSnapshot = populated()
        try await app.save(appSnapshot)

        let widget = JSONTaskStore(fileURL: legacyURL)
        var widgetSnapshot = try await widget.load(areas: [.tasks])
        XCTAssertNil(widgetSnapshot.directMessages)
        // The app receives a message meanwhile.
        appSnapshot.directMessages?.append(message(3))
        try await app.save(appSnapshot)

        widgetSnapshot.tasks[0].completed = true
        let written = try await widget.save(widgetSnapshot)
        XCTAssertEqual(written, [.tasks])
        let reloaded = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(reloaded.tasks[0].completed, true)
        XCTAssertEqual(reloaded.directMessages?.count, 3, "the widget's save left the app's new message alone")
    }

    /// C10-3: the widgets and the notification service read without attachments.
    func testReadingForDisplayLeavesAttachmentsOnDisk() async throws {
        let store = JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true)
        var snapshot = populated()
        // 20 MB of task images: about what a widget or notification service may hold in total.
        snapshot.tasks = (0..<20).map { index in
            var task = TaskItem(id: "t\(index)", boardID: snapshot.selectedBoardID, title: "Photo \(index)")
            task.images = ["data:image/jpeg;base64," + Data(repeating: UInt8(index), count: 750_000).base64EncodedString()]
            return task
        }
        try await store.save(snapshot)
        func attachmentBytes(_ snapshot: TaskifySnapshot) -> Int {
            snapshot.tasks.reduce(0) { $0 + ($1.images ?? []).reduce(0) { $0 + $1.utf8.count } }
        }

        let before = Self.footprint()
        let loaded = try await JSONTaskStore(fileURL: legacyURL).load(areas: [.tasks])
        let afterLoad = Self.footprint()
        let read = try await JSONTaskStore(fileURL: legacyURL).read(areas: [.tasks])
        let afterRead = Self.footprint()
        print("C10-3 load(.tasks): \(attachmentBytes(loaded)) attachment bytes, footprint +\((afterLoad - before) >> 20) MB")
        print("C10-3 read(.tasks): \(attachmentBytes(read)) attachment bytes, footprint +\((afterRead - afterLoad) >> 20) MB")
        XCTAssertGreaterThan(attachmentBytes(loaded), 19_000_000)
        XCTAssertLessThan(attachmentBytes(read), 2_000, "only the references")
        XCTAssertEqual(read.tasks.map(\.title), loaded.tasks.map(\.title))

        // The notification service needs chat and contacts, not tasks.
        let preview = try await JSONTaskStore(fileURL: legacyURL).read(areas: [.chat, .inbox])
        XCTAssertTrue(preview.tasks.isEmpty)
        XCTAssertEqual(preview.directMessageBlockedPeers, ["blocked"])
        XCTAssertEqual(preview.directMessages?.count, 2)

        // Reading changes nothing a later save of a full load writes.
        let full = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(attachmentBytes(full), attachmentBytes(loaded))
    }

    private static func footprint() -> Int {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int(info.phys_footprint) : 0
    }

    func testLargeInlineAttachmentsAreKeptAsFiles() async throws {
        let store = JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true)
        var snapshot = populated()
        let image = "data:image/png;base64," + Data(repeating: 7, count: 20_000).base64EncodedString()
        snapshot.tasks[0].images = [image, "https://files.example/remote.png"]
        snapshot.tasks[0].documents = [TaskDocument(
            id: "d1", name: "Notes.pdf", mimeType: "application/pdf", kind: "pdf",
            dataURL: "data:application/pdf;base64," + Data(repeating: 9, count: 20_000).base64EncodedString()
        )]
        try await store.save(snapshot)

        let tasksFile = try XCTUnwrap(contents(areaURL(.tasks)))
        XCTAssertLessThan(tasksFile.count, 5_000, "the file refers to the attachments instead of holding them")
        let attachments = splitDirectory.appendingPathComponent("attachments")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: attachments.path).count, 2)

        let reloaded = try await JSONTaskStore(fileURL: legacyURL).load()
        XCTAssertEqual(reloaded, snapshot, "values are inline again in memory")

        snapshot.tasks[0].images = nil
        snapshot.tasks[0].documents = nil
        try await store.save(snapshot)
        try await store.removeUnusedAttachments(minimumAge: 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: attachments.path).count, 0)
    }

    /// Records the cost of a save after one task edit, with 2,000 tasks and 5,000 messages:
    /// the single file before C7-5, the tasks file now.
    func testBenchmarkASaveAfterOneTaskEdit() async throws {
        var snapshot = TaskifySnapshot.empty
        let boardID = snapshot.selectedBoardID
        snapshot.tasks = (0..<2_000).map { index in
            var task = TaskItem(id: "task-\(index)", boardID: boardID, title: "Task number \(index) with a title")
            task.note = "A note of a typical length for a task, written once and rarely changed."
            task.dueDate = Date(timeIntervalSince1970: 1_790_000_000 + Double(index) * 3_600)
            return task
        }
        snapshot.directMessages = (0..<5_000).map(message)

        let legacyEncoder = JSONEncoder()
        legacyEncoder.outputFormatting = [.sortedKeys]
        let legacyStart = Date()
        let legacyData = try legacyEncoder.encode(snapshot)
        try legacyData.write(to: directory.appendingPathComponent("legacy-benchmark.json"), options: .atomic)
        let legacySeconds = Date().timeIntervalSince(legacyStart)

        let store = JSONTaskStore(fileURL: legacyURL, migratesLegacyStore: true)
        try await store.save(snapshot)
        snapshot.tasks[1_000].title = "Edited"
        let splitStart = Date()
        let written = try await store.save(snapshot)
        let splitSeconds = Date().timeIntervalSince(splitStart)
        let tasksBytes = try XCTUnwrap(contents(areaURL(.tasks))).count

        XCTAssertEqual(written, [.tasks])
        XCTAssertLessThan(tasksBytes, legacyData.count / 2)
        print(String(
            format: "[store benchmark] one task edit: single file %d bytes, %.1f ms; split store %d bytes, %.1f ms",
            legacyData.count, legacySeconds * 1000, tasksBytes, splitSeconds * 1000
        ))
    }
}
