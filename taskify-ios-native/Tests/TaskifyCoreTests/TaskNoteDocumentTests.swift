import Foundation
import Testing
@testable import TaskifyCore

// The same cases run against the PWA's port in taskify-pwa/tests/noteDocument.test.ts.

@Test func canonicalNotesRoundTripUnchanged() {
    let note = """
    # Plan
    Buy **milk** and *eggs*, then ~~skip~~ `code` [site](https://example.com)

    - one
      - nested
    1. first
    2. second
    - [ ] open
    - [x] done
    > quoted
    ---
    ```
    code *stays* raw
    ```
    snake_case stays
    """
    #expect(TaskNoteDocument.markdown(from: TaskNoteDocument.lines(fromMarkdown: note)) == note)
}

@Test func documentLinesCarryKindsDepthsAndMarks() {
    let lines = TaskNoteDocument.lines(fromMarkdown: "## Title\n  - [x] **Done** item\n\n3. third")
    #expect(lines.map(\.kind) == [.heading(2), .checklist(checked: true), .paragraph, .numbered(3)])
    #expect(lines[1].depth == 1)
    #expect(lines[1].runs == [TaskNoteRun("Done", marks: .bold), TaskNoteRun(" item")])
}

@Test func typedTextThatLooksLikeSyntaxIsEscaped() {
    func paragraph(_ text: String) -> String {
        TaskNoteDocument.markdown(from: [TaskNoteLine(runs: [TaskNoteRun(text)])])
    }
    #expect(paragraph("- not a list") == "\\- not a list")
    #expect(paragraph("1. not numbered") == "1\\. not numbered")
    #expect(paragraph("# not a heading") == "\\# not a heading")
    #expect(paragraph("a*b [c] `d` \\e") == "a\\*b \\[c\\] \\`d\\` \\\\e")
    #expect(paragraph("snake_case and _edge_") == "snake_case and \\_edge\\_")
    // And they read back as typed.
    for text in ["- not a list", "1. not numbered", "a*b [c] `d` \\e", "snake_case and _edge_"] {
        #expect(TaskNoteDocument.lines(fromMarkdown: paragraph(text)).first?.text == text)
    }
}

@Test func overlappingMarksNestAndKeepSpacesOutside() {
    let runs = [
        TaskNoteRun("bold ", marks: .bold),
        TaskNoteRun("both", marks: [.bold, .italic]),
        TaskNoteRun(" plain"),
    ]
    #expect(TaskNoteDocument.inlineMarkdown(runs) == "**bold *both*** plain")
    #expect(TaskNoteDocument.inlineMarkdown([TaskNoteRun("go", marks: .bold, link: "https://a.b/c d")])
        == "[**go**](https://a.b/c%20d)")
    #expect(TaskNoteDocument.inlineMarkdown([TaskNoteRun("a`b", marks: .code)]) == "``a`b``")
}

@Test func numberedRunsRenumberFromTheirFirstItem() {
    let lines = [
        TaskNoteLine(kind: .numbered(3), runs: [TaskNoteRun("c")]),
        TaskNoteLine(kind: .numbered(1), runs: [TaskNoteRun("d")]),
        TaskNoteLine(),
        TaskNoteLine(kind: .numbered(1), runs: [TaskNoteRun("a")]),
    ]
    #expect(TaskNoteDocument.markdown(from: lines) == "3. c\n4. d\n\n1. a")
}
