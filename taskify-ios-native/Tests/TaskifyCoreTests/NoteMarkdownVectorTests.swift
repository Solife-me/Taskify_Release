import Foundation
import Testing
@testable import TaskifyCore

/// Note Markdown must parse and edit the same on iOS and the web. The vectors are generated from
/// the PWA (`taskify-pwa/src/domains/tasks/noteMarkdown.ts`) and also run by its Vitest suite
/// (`noteMarkdownVectors.test.ts`), so drift on either side fails a test.
private struct NoteVectorFile: Decodable {
    struct Block: Decodable, Equatable {
        var type: String
        var content: String?
        var level: Int?
        var depth: Int?
        var number: Int?
        var checked: Bool?
        var line: Int?
        var lines: Int?
    }

    struct Edit: Decodable, Equatable {
        var text: String
        var selectionStart: Int
        var selectionEnd: Int
    }

    struct BlockVector: Decodable { var name: String; var note: String; var expected: [Block] }
    struct ToggleVector: Decodable { var name: String; var note: String; var line: Int; var expected: String? }
    struct ContinueVector: Decodable {
        var name: String; var text: String; var selectionStart: Int; var selectionEnd: Int; var expected: Edit?
    }
    struct FormatVector: Decodable {
        var name: String; var format: String; var text: String; var selectionStart: Int; var selectionEnd: Int; var expected: Edit
    }
    struct PreviewVector: Decodable { var name: String; var note: String; var expected: String }

    var blocks: [BlockVector]
    var toggles: [ToggleVector]
    var continueList: [ContinueVector]
    var formats: [FormatVector]
    var previews: [PreviewVector]

    static func load() throws -> NoteVectorFile {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TaskifyCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // taskify-ios-native
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("taskify-core/fixtures/note-markdown-vectors.json")
        return try JSONDecoder().decode(NoteVectorFile.self, from: Data(contentsOf: url))
    }
}

/// A Swift block in the PWA's JSON shape.
private func vectorBlock(_ block: TaskNoteBlock) -> NoteVectorFile.Block {
    switch block {
    case .paragraph(let content): return .init(type: "paragraph", content: content)
    case let .heading(level, content): return .init(type: "heading", content: content, level: level)
    case let .bulletItem(depth, content): return .init(type: "bullet", content: content, depth: depth)
    case let .numberedItem(depth, number, content):
        return .init(type: "numbered", content: content, depth: depth, number: number)
    case let .checklistItem(depth, checked, content, line):
        return .init(type: "checklist", content: content, depth: depth, checked: checked, line: line)
    case .quote(let content): return .init(type: "quote", content: content)
    case .code(let content): return .init(type: "code", content: content)
    case .thematicBreak: return .init(type: "rule")
    case .spacer(let lines): return .init(type: "spacer", lines: lines)
    }
}

private func vectorEdit(_ edit: TaskNoteEdit) -> NoteVectorFile.Edit {
    .init(text: edit.text, selectionStart: edit.selection.location, selectionEnd: edit.selection.location + edit.selection.length)
}

private func range(_ start: Int, _ end: Int) -> NSRange { NSRange(location: start, length: end - start) }

@Test func noteBlocksMatchSharedVectors() throws {
    for vector in try NoteVectorFile.load().blocks {
        #expect(TaskNoteMarkdown.blocks(vector.note).map(vectorBlock) == vector.expected, "\(vector.name)")
    }
}

@Test func checklistTogglesMatchSharedVectors() throws {
    for vector in try NoteVectorFile.load().toggles {
        #expect(TaskNoteMarkdown.togglingChecklistItem(in: vector.note, line: vector.line) == vector.expected, "\(vector.name)")
    }
}

@Test func listContinuationMatchesSharedVectors() throws {
    for vector in try NoteVectorFile.load().continueList {
        let edit = TaskNoteMarkdown.continuingList(in: vector.text, selection: range(vector.selectionStart, vector.selectionEnd))
        #expect(edit.map(vectorEdit) == vector.expected, "\(vector.name)")
    }
}

@Test func formattingMatchesSharedVectors() throws {
    for vector in try NoteVectorFile.load().formats {
        let format = try #require(TaskNoteFormat(rawValue: vector.format), "\(vector.name)")
        let edit = TaskNoteMarkdown.applying(format, to: vector.text, selection: range(vector.selectionStart, vector.selectionEnd))
        #expect(vectorEdit(edit) == vector.expected, "\(vector.name)")
    }
}

@Test func previewsMatchSharedVectors() throws {
    for vector in try NoteVectorFile.load().previews {
        #expect(TaskNoteMarkdown.previewText(vector.note) == vector.expected, "\(vector.name)")
    }
}
