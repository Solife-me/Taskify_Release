import Foundation
import Testing
@testable import TaskifyCore

private let items = [
    PhysicalChecklistItem(id: "a", title: "A", section: "Mon"),
    PhysicalChecklistItem(id: "b", title: "B", section: "Mon"),
    PhysicalChecklistItem(id: "c", title: "C", section: "Tue"),
]

private func makeJob(paper: PhysicalChecklistPaper, id: String = "print-1") -> PhysicalChecklistJob {
    PhysicalChecklistJob(id: id, ownerID: "board:test", title: "Test", paper: paper, items: items)
}

/// Draws the sheet a printer would produce: paper, corner markers (the first two in either the
/// native or the PWA finder style), the code and page bits, and a filled circle for each id.
private func renderChecklist(
    job: PhysicalChecklistJob,
    filledIDs: Set<String> = [],
    pwaFinders: Bool = false,
    quarterTurns: Int = 0
) -> PhysicalChecklistGrayImage {
    let size = job.paper.sizeMM
    let width = 480
    let height = max(1, Int((Double(width) * size.height / size.width).rounded()))
    var pixels = [UInt8](repeating: 235, count: width * height)

    func fill(xMM: Double, yMM: Double, wMM: Double, hMM: Double, value: UInt8) {
        let x0 = Int((xMM / size.width) * Double(width))
        let x1 = Int(((xMM + wMM) / size.width) * Double(width))
        let y0 = Int((yMM / size.height) * Double(height))
        let y1 = Int(((yMM + hMM) / size.height) * Double(height))
        guard x1 > x0, y1 > y0 else { return }
        for y in max(0, y0)..<min(height, y1) {
            for x in max(0, x0)..<min(width, x1) {
                pixels[y * width + x] = value
            }
        }
    }

    func fillCentered(xMM: Double, yMM: Double, wMM: Double, hMM: Double, value: UInt8 = 20) {
        fill(xMM: xMM - wMM / 2, yMM: yMM - hMM / 2, wMM: wMM, hMM: hMM, value: value)
    }

    let layout = PhysicalChecklistLayout.build(job: job)
    for (index, rect) in layout.markerRectsMM().enumerated() {
        fill(xMM: rect.x, yMM: rect.y, wMM: rect.width, hMM: rect.height, value: 20)
        if pwaFinders, index < 2 {
            let inset = rect.width * 0.275
            fill(xMM: rect.x + inset, yMM: rect.y + inset, wMM: rect.width * 0.45, hMM: rect.height * 0.45, value: 245)
        }
    }

    let jobCode = BoardPrintContract.jobCodePattern(jobID: job.id)
    for (bit, center) in layout.jobCodeBitCentersMM(jobID: job.id).enumerated() where jobCode[bit] != 0 {
        fillCentered(xMM: center.x, yMM: center.y, wMM: 2, hMM: 2)
    }

    let pageBits = BoardPrintContract.pagePattern(pageIndex: 0)
    for (bit, center) in layout.pageIDBitCentersMM().enumerated() where pageBits[bit] != 0 {
        fillCentered(xMM: center.x, yMM: center.y, wMM: 2.4, hMM: 2.4)
    }

    for page in layout.pages {
        for row in page.rows {
            guard case let .item(item) = row.kind, let center = row.circleCenterMM else { continue }
            guard filledIDs.contains(item.id) else { continue }
            fillCentered(xMM: center.x, yMM: center.y, wMM: layout.circleSizeMM, hMM: layout.circleSizeMM)
        }
    }

    var image = PhysicalChecklistGrayImage(pixels: pixels, width: width, height: height)
    for _ in 0..<quarterTurns {
        image = image.rotatedClockwise()
    }
    return image
}

/// Puts the page on a darker surface, as a scanner that kept the desk around the sheet would.
private func withBackground(_ page: PhysicalChecklistGrayImage, margin: Double = 0.12) -> PhysicalChecklistGrayImage {
    let marginX = Int(Double(page.width) * margin)
    let marginY = Int(Double(page.height) * margin)
    let width = page.width + marginX * 2
    let height = page.height + marginY * 2
    var pixels = [UInt8](repeating: 30, count: width * height)
    for y in 0..<page.height {
        for x in 0..<page.width {
            pixels[(y + marginY) * width + (x + marginX)] = page.pixels[y * page.width + x]
        }
    }
    return PhysicalChecklistGrayImage(pixels: pixels, width: width, height: height)
}

@Test func scanReadsFilledCirclesOnTheSheetsOwnPaper() {
    let job = makeJob(paper: .a6)
    let result = PhysicalChecklistScanAnalyzer.scan(images: [renderChecklist(job: job, filledIDs: ["b"])], job: job)

    #expect(result.detectedIDs == ["b"])
    #expect(result.recognizedPages == 1)
    #expect(result.mismatchedJobs == 0)
    #expect(result.unreadablePageIDs == 0)
}

@Test func scanFindsASheetPrintedOnADifferentPaperThanTheJobRemembers() {
    let printJob = makeJob(paper: .a6)
    let scanJob = makeJob(paper: .letter)
    let result = PhysicalChecklistScanAnalyzer.scan(images: [renderChecklist(job: printJob, filledIDs: ["a"])], job: scanJob)

    #expect(result.detectedIDs == ["a"])
    #expect(result.recognizedPages == 1)
    #expect(result.mismatchedJobs == 0)
}

@Test func scanFindsASidewaysPage() {
    let job = makeJob(paper: .a6)
    let result = PhysicalChecklistScanAnalyzer.scan(
        images: [renderChecklist(job: job, filledIDs: ["c"], quarterTurns: 1)],
        job: job
    )

    #expect(result.detectedIDs == ["c"])
    #expect(result.recognizedPages == 1)
}

@Test func scanRejectsAnotherPrintsCode() {
    let printed = makeJob(paper: .a6, id: "the-printed-job")
    let scanner = makeJob(paper: .a6, id: "a-different-job")
    let result = PhysicalChecklistScanAnalyzer.scan(images: [renderChecklist(job: printed, filledIDs: [])], job: scanner)

    #expect(result.detectedIDs.isEmpty)
    #expect(result.recognizedPages == 0)
    #expect(result.mismatchedJobs == 1)
}

@Test func scanCropsTheSurfaceAroundTheSheet() {
    let job = makeJob(paper: .a6)
    let page = withBackground(renderChecklist(job: job, filledIDs: ["b"]))
    let cropped = page.croppedToPage()
    #expect(cropped.width == 480)
    #expect(cropped.height == 677)
    let result = PhysicalChecklistScanAnalyzer.scan(images: [page], job: job)

    #expect(result.detectedIDs == ["b"])
    #expect(result.recognizedPages == 1)
    #expect(result.mismatchedJobs == 0)
}

@Test func scanReadsThePwaFinderMarkers() {
    let job = makeJob(paper: .a6)
    let result = PhysicalChecklistScanAnalyzer.scan(
        images: [renderChecklist(job: job, filledIDs: ["b"], pwaFinders: true)],
        job: job
    )

    #expect(result.detectedIDs == ["b"])
    #expect(result.recognizedPages == 1)
}

@Test func scanReadsADetailedSheetWithVariableRows() {
    let job = PhysicalChecklistJob(
        id: "detail-print",
        ownerID: "board:test",
        title: "Test",
        paper: .a6,
        items: [
            PhysicalChecklistItem(
                id: "a",
                title: "A",
                section: "Mon",
                detail: "Sep 4, 2026 · a note",
                subtasks: [
                    PhysicalChecklistSubtask(title: "Buy stamps"),
                    PhysicalChecklistSubtask(title: "Post letter", completed: true),
                ],
                photoCount: 1
            ),
            PhysicalChecklistItem(id: "b", title: "B", section: "Mon"),
        ],
        layoutVersion: BoardPrintContract.detailVersion
    )
    let result = PhysicalChecklistScanAnalyzer.scan(
        images: [renderChecklist(job: job, filledIDs: ["b"])],
        job: job
    )

    #expect(result.detectedIDs == ["b"])
    #expect(result.recognizedPages == 1)
    #expect(result.mismatchedJobs == 0)
}
