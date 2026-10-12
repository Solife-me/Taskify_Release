import Foundation
import Testing
@testable import TaskifyCore

// The same cases run against the PWA's port in taskify-pwa/tests/noteMarkdown.test.ts.

private func edit(_ format: TaskNoteFormat, _ text: String, _ location: Int, _ length: Int = 0) -> TaskNoteEdit {
    TaskNoteMarkdown.applying(format, to: text, selection: NSRange(location: location, length: length))
}

@Test func noteBlocksParseListsChecklistsAndHeadings() {
    let note = "# Plan\nBuy milk\nthen bread\n\n- one\n  - nested\n1. first\n- [ ] open\n- [x] done\n> quoted\n---"
    #expect(TaskNoteMarkdown.blocks(note) == [
        .heading(level: 1, content: "Plan"),
        .paragraph("Buy milk\nthen bread"),
        .spacer(lines: 1),
        .bulletItem(depth: 0, content: "one"),
        .bulletItem(depth: 1, content: "nested"),
        .numberedItem(depth: 0, number: 1, content: "first"),
        .checklistItem(depth: 0, checked: false, content: "open", line: 7),
        .checklistItem(depth: 0, checked: true, content: "done", line: 8),
        .quote("quoted"),
        .thematicBreak,
    ])
}

@Test func noteBlocksKeepSkippedRowsBetweenBlocksOnly() {
    #expect(TaskNoteMarkdown.blocks("\n\nFirst\n\n\n\nSecond\n- item\n \n\n") == [
        .paragraph("First"),
        .spacer(lines: 3),
        .paragraph("Second"),
        .bulletItem(depth: 0, content: "item"),
    ])
    #expect(TaskNoteMarkdown.blocks("```\na\n\nb\n```") == [.code("a\n\nb")])
    #expect(TaskNoteMarkdown.previewText("One\n\n\nTwo") == "One\nTwo")
}

@Test func noteBlocksIgnoreChecklistsInsideCodeAndHashtags() {
    let note = "#nostr tag\n```\n- [ ] not an item\n```\n- [ ] real"
    #expect(TaskNoteMarkdown.blocks(note) == [
        .paragraph("#nostr tag"),
        .code("- [ ] not an item"),
        .checklistItem(depth: 0, checked: false, content: "real", line: 4),
    ])
}

@Test func togglingChecklistItemFlipsOnlyThatBox() {
    let note = "- [ ] a\r\n- [X] b\n```\n- [ ] code\n```"
    #expect(TaskNoteMarkdown.togglingChecklistItem(in: note, line: 0) == "- [x] a\r\n- [X] b\n```\n- [ ] code\n```")
    #expect(TaskNoteMarkdown.togglingChecklistItem(in: note, line: 1) == "- [ ] a\r\n- [ ] b\n```\n- [ ] code\n```")
    #expect(TaskNoteMarkdown.togglingChecklistItem(in: note, line: 3) == nil)
    #expect(TaskNoteMarkdown.togglingChecklistItem(in: note, line: 99) == nil)
}

@Test func extractingChecklistMovesItemsToSubtasks() {
    let note = "Intro\n\n- [ ] **Milk**\n- [x] Eggs\n- [ ]\n\nOutro"
    let result = TaskNoteMarkdown.extractingChecklist(from: note)
    #expect(result.note == "Intro\n\nOutro")
    #expect(result.subtasks.map(\.title) == ["Milk", "Eggs"])
    #expect(result.subtasks.map(\.completed) == [false, true])
    #expect(TaskNoteMarkdown.extractingChecklist(from: "- [ ] only").note == "")
}

@Test func previewTextStripsSyntaxAndMarksItems() {
    let note = "## Shopping\n- [ ] **milk**\n- [x] [eggs](https://example.com)\n* bread\n\n\n> calm _down_"
    #expect(TaskNoteMarkdown.previewText(note) == "Shopping\n☐ milk\n☑ eggs\n• bread\ncalm down")
}

@Test func inlineFormatsWrapToggleAndExpandToWord() {
    #expect(edit(.bold, "make bold", 5, 4) == TaskNoteEdit(text: "make **bold**", selection: NSRange(location: 7, length: 4)))
    #expect(edit(.bold, "make **bold**", 7, 4) == TaskNoteEdit(text: "make bold", selection: NSRange(location: 5, length: 4)))
    #expect(edit(.bold, "make **bold**", 5, 8) == TaskNoteEdit(text: "make bold", selection: NSRange(location: 5, length: 4)))
    #expect(edit(.italic, "**bold**", 2, 4) == TaskNoteEdit(text: "***bold***", selection: NSRange(location: 3, length: 4)))
    #expect(edit(.italic, "***bold***", 3, 4) == TaskNoteEdit(text: "**bold**", selection: NSRange(location: 2, length: 4)))
    #expect(edit(.strikethrough, "wo", 1) == TaskNoteEdit(text: "~~wo~~", selection: NSRange(location: 2, length: 2)))
    #expect(edit(.bold, "a ", 2) == TaskNoteEdit(text: "a ****", selection: NSRange(location: 4, length: 0)))
    #expect(edit(.code, " x ", 0, 3) == TaskNoteEdit(text: " `x` ", selection: NSRange(location: 2, length: 1)))
}

@Test func linkInsertionSelectsTheURLPlaceholder() {
    #expect(edit(.link, "see docs", 4, 4) == TaskNoteEdit(text: "see [docs](https://)", selection: NSRange(location: 11, length: 8)))
    #expect(edit(.link, "", 0) == TaskNoteEdit(text: "[](https://)", selection: NSRange(location: 1, length: 0)))
}

@Test func blockFormatsToggleAndReplaceMarkers() {
    #expect(edit(.bulletList, "milk", 4) == TaskNoteEdit(text: "- milk", selection: NSRange(location: 6, length: 0)))
    #expect(edit(.bulletList, "- milk", 6) == TaskNoteEdit(text: "milk", selection: NSRange(location: 4, length: 0)))
    #expect(edit(.checklist, "- milk", 6) == TaskNoteEdit(text: "- [ ] milk", selection: NSRange(location: 10, length: 0)))
    #expect(edit(.numberedList, "a\n\nb", 0, 4) == TaskNoteEdit(text: "1. a\n\n2. b", selection: NSRange(location: 0, length: 10)))
    #expect(edit(.numberedList, "1. a\nb", 6) == TaskNoteEdit(text: "1. a\n2. b", selection: NSRange(location: 9, length: 0)))
    #expect(edit(.heading, "Title", 0).text == "# Title")
    #expect(edit(.heading, "# Title", 0).text == "## Title")
    #expect(edit(.heading, "### Title", 0).text == "Title")
    #expect(edit(.quote, "x\ny", 0, 3).text == "> x\n> y")
    #expect(edit(.bulletList, "  - [x] keep indent", 0).text == "  - keep indent")
    #expect(edit(.bulletList, "\nmilk", 0).text == "- \nmilk")
}

@Test func returnContinuesOrEndsLists() {
    func returnKey(_ text: String) -> TaskNoteEdit? {
        TaskNoteMarkdown.continuingList(in: text, selection: NSRange(location: (text as NSString).length, length: 0))
    }
    #expect(returnKey("- [x] milk") == TaskNoteEdit(text: "- [x] milk\n- [ ] ", selection: NSRange(location: 17, length: 0)))
    #expect(returnKey("  * a") == TaskNoteEdit(text: "  * a\n  * ", selection: NSRange(location: 10, length: 0)))
    #expect(returnKey("9) a") == TaskNoteEdit(text: "9) a\n10) ", selection: NSRange(location: 9, length: 0)))
    #expect(returnKey("x\n- ") == TaskNoteEdit(text: "x\n", selection: NSRange(location: 2, length: 0)))
    #expect(returnKey("plain") == nil)
}

@Test func updateTaskNoteAppendsSubtasks() throws {
    var snapshot = TaskifySnapshot.empty
    let added = snapshot.addTask(
        title: "T",
        boardID: snapshot.selectedBoardID,
        columnID: WeekdayColumn.monday.rawValue,
        dueDate: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let task = try #require(added)
    let changed = snapshot.updateTaskNote(
        taskID: task.id,
        note: " new ",
        appendingSubtasks: [TaskSubtask(title: "Added", completed: true), TaskSubtask(title: " ")]
    )
    #expect(changed)
    let updated = try #require(snapshot.tasks.first { $0.id == task.id })
    #expect(updated.note == "new")
    #expect(updated.subtasks?.map(\.title) == ["Added"])
    #expect(updated.subtasks?.map(\.completed) == [true])
    let unchanged = snapshot.updateTaskNote(taskID: task.id, note: "new")
    #expect(!unchanged)
}
