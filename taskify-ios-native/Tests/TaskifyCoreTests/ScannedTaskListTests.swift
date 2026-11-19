import Testing
@testable import TaskifyCore

@Test func scannedNotebookCreatesTasksAndIndentedSubtasksInReadingOrder() {
    let rows = ScannedTaskList.rows(from: [
        line("- Wipes", x: 0.20, y: 0.33, confidence: 0.47),
        line("To-do list", x: 0.12, y: 0.05),
        line("- toothbrushes", x: 0.21, y: 0.38),
        line("1. Go to the store", x: 0.11, y: 0.15),
        line("☐ Get gas", x: 0.11, y: 0.21),
        line("- Order Airbnb supplies", x: 0.12, y: 0.27),
    ])

    let drafts = ScannedTaskList.drafts(from: rows)
    #expect(drafts.map(\.title) == ["Go to the store", "Get gas", "Order Airbnb supplies"])
    #expect(drafts.last?.subtasks.map(\.title) == ["Wipes", "toothbrushes"])
    #expect(rows.filter(\.needsReview).map(\.title) == ["Wipes"])
}

@Test func editingOrRemovingTheFirstParentKeepsItsRemainingLines() {
    var rows = ScannedTaskList.rows(from: [
        line("Order supplies", x: 0.10, y: 0.20),
        line("- Wipes", x: 0.20, y: 0.30),
        line("- Toothbrushes", x: 0.20, y: 0.40),
    ])
    rows[0].title = " "
    rows[1].title = "Sanitizing wipes"

    let drafts = ScannedTaskList.drafts(from: rows)
    #expect(drafts.map(\.title) == ["Sanitizing wipes"])
    #expect(drafts.first?.subtasks.map(\.title) == ["Toothbrushes"])
}

@Test func printSubtitlesRecognizeNativeAndWebFormats() {
    for subtitle in [
        "Page 1 of 2 • Layout taskify-2 • Print 4F097BCA",
        "8 tasks | Printed Nov 16 | Layout taskify-2 | Print 4F097BCA",
    ] {
        let lines = [line(subtitle, x: 0.08, y: 0.10)]
        #expect(ScannedTaskList.printSubtitle(in: lines)?.text == subtitle)
        #expect(ScannedTaskList.printID(in: lines) == "4f097bca")
    }
    let mac = [line("Fill, check, or X circles • Page 1 of 2 • Print 2", x: 0.08, y: 0.10)]
    #expect(ScannedTaskList.printSubtitle(in: mac) != nil)
    #expect(ScannedTaskList.printID(in: mac) == nil)
    let ordinary = [line("Print 4F097BCA", x: 0.08, y: 0.10)]
    #expect(ScannedTaskList.printSubtitle(in: ordinary) == nil)
    #expect(ScannedTaskList.printID(in: ordinary) == nil)
}

private func line(_ text: String, x: Double, y: Double, confidence: Double = 1) -> PhysicalChecklistOCRLine {
    PhysicalChecklistOCRLine(text: text, x: x, y: y, width: 0.5, height: 0.045, confidence: confidence)
}
