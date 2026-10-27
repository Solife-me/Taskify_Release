import Foundation
import XCTest
@testable import TaskifyCore

/// C10-6: the share sheet saves a task as a draft for the app.
final class ShareTaskDraftTests: XCTestCase {
    func testTitleAndNoteFromSharedText() {
        var split = ShareTaskDraft.titleAndNote(text: "https://example.com/article", pageTitle: "A good article")
        XCTAssertEqual(split.title, "A good article")
        XCTAssertEqual(split.note, "https://example.com/article")

        split = ShareTaskDraft.titleAndNote(text: "https://example.com/a\nRead this later\nIt is long", pageTitle: nil)
        XCTAssertEqual(split.title, "Read this later")
        XCTAssertEqual(split.note, "https://example.com/a\nIt is long")

        split = ShareTaskDraft.titleAndNote(text: "https://example.com/only", pageTitle: " ")
        XCTAssertEqual(split.title, "https://example.com/only")
        XCTAssertEqual(split.note, "")

        split = ShareTaskDraft.titleAndNote(text: "", pageTitle: nil, fileNames: ["Receipt 2026.pdf"])
        XCTAssertEqual(split.title, "Receipt 2026")
    }

    func testDraftsRoundTripWithTheirFiles() throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let source = parent.appendingPathComponent("photo.jpg")
        try Data([1, 2, 3]).write(to: source)

        let first = ShareTaskDraft(account: "a", title: "First", note: "", boardName: "Errands",
                                   createdAt: Date(timeIntervalSince1970: 1))
        let second = ShareTaskDraft(account: "a", title: "Second", note: "", boardName: nil,
                                    createdAt: Date(timeIntervalSince1970: 2))
        try ShareTaskDraftStore.save(second, files: [], in: parent)
        let saved = try ShareTaskDraftStore.save(first, files: [(source, "Photo.jpg", "image/jpeg")], in: parent)

        let drafts = ShareTaskDraftStore.all(in: parent)
        XCTAssertEqual(drafts.map(\.title), ["First", "Second"])
        XCTAssertEqual(drafts[0], saved)
        let file = try XCTUnwrap(drafts[0].files.first)
        XCTAssertEqual(file.name, "Photo.jpg")
        XCTAssertEqual(try Data(contentsOf: ShareTaskDraftStore.fileURL(file, of: drafts[0], in: parent)), Data([1, 2, 3]))
        XCTAssertTrue(drafts[0].taskID.hasPrefix("share-"))

        ShareTaskDraftStore.remove(drafts[0], in: parent)
        XCTAssertEqual(ShareTaskDraftStore.all(in: parent).map(\.title), ["Second"])
    }

    func testAnOlderAccountFileStillDecodes() throws {
        let json = #"{"publicKey":"a","recipients":[],"server":{"url":"https://x.example","type":"originless"},"senderRelays":[]}"#
        let account = try JSONDecoder().decode(ShareAccount.self, from: Data(json.utf8))
        XCTAssertNil(account.taskBoards)
    }
}
