import Foundation
import Testing
@testable import TaskifyCore

private enum TestChecklistMark {
    case blank
    case filled
    case check
    case x
}

@Test func physicalChecklistScannerAlignsA6AndReadsFillCheckAndX() {
    let items = (0..<6).map { PhysicalChecklistItem(id: "task-\($0)", title: "Task \($0)") }
    let job = PhysicalChecklistJob(
        id: "a6-camera-regression",
        ownerID: "board",
        title: "A6 board",
        paper: .a6,
        items: items
    )
    let image = renderChecklistPhoto(
        job: job,
        marks: [
            "task-0": .filled,
            "task-1": .check,
            "task-2": .x,
        ]
    )

    let result = PhysicalChecklistScanEngine.scan(images: [image], job: job)

    #expect(result.recognizedPages == 1)
    #expect(result.mismatchedJobs == 0)
    #expect(result.unreadablePageIDs == 0)
    #expect(result.detectedIDs == ["task-0", "task-1", "task-2"])
}

@Test func physicalChecklistScannerRejectsAnotherPrintJob() {
    let items = [PhysicalChecklistItem(id: "task", title: "Task")]
    let printedJob = PhysicalChecklistJob(
        id: "printed-job",
        ownerID: "board",
        title: "A6 board",
        paper: .a6,
        items: items
    )
    let currentJob = PhysicalChecklistJob(
        id: "current-job",
        ownerID: "board",
        title: "A6 board",
        paper: .a6,
        items: items
    )

    let result = PhysicalChecklistScanEngine.scan(
        images: [renderChecklistPhoto(job: printedJob, marks: ["task": .filled])],
        job: currentJob
    )

    #expect(result.recognizedPages == 0)
    #expect(result.mismatchedJobs == 1)
    #expect(result.detectedIDs.isEmpty)
}

@Test func physicalChecklistScannerFindsAllMarkersAcrossDeepUnevenLighting() {
    let items = (0..<6).map { PhysicalChecklistItem(id: "task-\($0)", title: "Task \($0)") }
    let job = PhysicalChecklistJob(
        id: "deep-shadow-regression",
        ownerID: "board",
        title: "Personal schedule",
        paper: .a6,
        items: items
    )
    let image = renderChecklistPhoto(
        job: job,
        marks: ["task-1": .check],
        deepLowerRightShadow: true
    )

    let result = PhysicalChecklistScanEngine.scan(images: [image], job: job)

    #expect(result.recognizedPages == 1)
    #expect(result.mismatchedJobs == 0)
    #expect(result.detectedIDs == ["task-1"])
}

@Test func physicalChecklistScannerLocatesAMarkedCircleShiftedFromTheGrid() {
    let items = (0..<6).map { PhysicalChecklistItem(id: "task-\($0)", title: "Task \($0)") }
    let job = PhysicalChecklistJob(
        id: "shifted-circle-regression",
        ownerID: "board",
        title: "Personal schedule",
        paper: .a6,
        items: items
    )
    let image = renderChecklistPhoto(
        job: job,
        marks: ["task-3": .check],
        circleOffsetXMM: 1.2
    )

    let result = PhysicalChecklistScanEngine.scan(images: [image], job: job)

    #expect(result.recognizedPages == 1)
    #expect(result.detectedIDs == ["task-3"])
}

@Test func physicalChecklistScannerAcceptsFadedPrinterInk() {
    let items = (0..<6).map { PhysicalChecklistItem(id: "task-\($0)", title: "Task \($0)") }
    let job = PhysicalChecklistJob(
        id: "faded-ink-regression",
        ownerID: "board",
        title: "Personal schedule",
        paper: .a6,
        items: items
    )
    let image = renderChecklistPhoto(
        job: job,
        marks: ["task-4": .check],
        fadedInk: true
    )

    let result = PhysicalChecklistScanEngine.scan(images: [image], job: job)

    #expect(result.recognizedPages == 1)
    #expect(result.detectedIDs == ["task-4"])
}

@Test func ocrAlignmentPrefersThePrintedRowsAfterAnAppCompletion() {
    let originalItems = [
        PhysicalChecklistItem(id: "before-print", title: "Completed before printing"),
        PhysicalChecklistItem(id: "after-print", title: "Completed after printing"),
        PhysicalChecklistItem(id: "marked", title: "Marked on paper"),
    ]
    let printedJob = PhysicalChecklistJob(
        id: "printed-row-set",
        ownerID: "board",
        title: "Shared board",
        paper: .a6,
        items: [originalItems[1], originalItems[2]]
    )
    let currentAppJob = PhysicalChecklistJob(
        id: "current-app-order",
        ownerID: "board",
        title: "Shared board",
        paper: .a6,
        items: [originalItems[2]]
    )
    let currentWithPostPrintCompletion = PhysicalChecklistJob(
        id: "completion-aware-order",
        ownerID: "board",
        title: "Shared board",
        paper: .a6,
        items: [originalItems[1], originalItems[2]]
    )
    let image = renderChecklistPhoto(job: printedJob, marks: ["marked": .check])
    let lines = ocrLines(for: printedJob)

    let openOnlyScore = PhysicalChecklistScanEngine.alignmentScore(
        image: image,
        job: currentAppJob,
        lines: lines
    )
    let completionAwareScore = PhysicalChecklistScanEngine.alignmentScore(
        image: image,
        job: currentWithPostPrintCompletion,
        lines: lines
    )
    let markedRowScore = PhysicalChecklistScanEngine.alignmentScore(
        image: image,
        job: currentWithPostPrintCompletion,
        lines: lines,
        restrictToItemIDs: ["marked"]
    )
    let shiftedMarkedRowScore = PhysicalChecklistScanEngine.alignmentScore(
        image: image,
        job: currentAppJob,
        lines: lines,
        restrictToItemIDs: ["marked"]
    )

    #expect(completionAwareScore > openOnlyScore)
    #expect(completionAwareScore > 0.8)
    #expect(markedRowScore > shiftedMarkedRowScore)
}

private func renderChecklistPhoto(
    job: PhysicalChecklistJob,
    marks: [String: TestChecklistMark],
    deepLowerRightShadow: Bool = false,
    circleOffsetXMM: Double = 0,
    fadedInk: Bool = false
) -> PhysicalChecklistGrayImage {
    let layout = PhysicalChecklistLayout.build(job: job)
    let paper = job.paper.sizeMM
    let width = 980
    let height = 1280
    let originX = 72.0
    let originY = 62.0
    let scaleX = 7.55
    let scaleY = 7.45
    let shear = 0.22
    let ink: UInt8 = fadedInk ? 158 : 24
    let paperLuma: UInt8 = fadedInk ? 250 : 236
    let tableLuma: UInt8 = 68
    var pixels = [UInt8](repeating: tableLuma, count: width * height)
    let markerRects = layout.markerRectsMM()
    let pagePattern = BoardPrintContract.pagePattern(pageIndex: 0)
    let pageBits = layout.pageIDBitCentersMM()
    let jobPattern = BoardPrintContract.jobCodePattern(jobID: job.id)
    let jobBits = layout.jobCodeBitCentersMM(jobID: job.id)
    let punchedHoleCentersY = [23.0, 37.0, 65.0, 83.0, 111.0, 125.0]
    let itemRows = layout.pages[0].rows.compactMap { row -> (String, Double, Double)? in
        guard case let .item(item) = row.kind, let center = row.circleCenterMM else { return nil }
        return (item.id, center.x + circleOffsetXMM, center.y)
    }

    for py in 0..<height {
        for px in 0..<width {
            let pageY = (Double(py) + 0.5 - originY) / scaleY
            let pageX = (Double(px) + 0.5 - originX - shear * pageY) / scaleX
            guard pageX >= 0, pageY >= 0, pageX <= paper.width, pageY <= paper.height else { continue }
            var value = paperLuma
            if deepLowerRightShadow,
               pageX >= paper.width * 0.54,
               pageY >= paper.height * 0.62 {
                value = 72
            }

            // Dark tabletop visible through the six holes in common ring-bound A6 inserts.
            if punchedHoleCentersY.contains(where: { hypot(pageX - 4.2, pageY - $0) <= 2.2 }) {
                value = tableLuma
            }

            for (index, rect) in markerRects.enumerated() where pointInRect(pageX, pageY, rect) {
                if index < 2 {
                    let localX = pageX - rect.x
                    let localY = pageY - rect.y
                    let edge = min(localX, localY, rect.width - localX, rect.height - localY)
                    let centerInset = rect.width * 0.32
                    if edge <= 0.48 ||
                        (localX >= centerInset && localX <= rect.width - centerInset &&
                            localY >= centerInset && localY <= rect.height - centerInset) {
                        value = ink
                    }
                } else {
                    value = ink
                }
            }

            for (bit, center) in pageBits.enumerated() {
                let side = BoardPrintContract.pageIDMarkerSizeMM
                if squareInk(
                    x: pageX,
                    y: pageY,
                    centerX: center.x,
                    centerY: center.y,
                    side: side,
                    filled: pagePattern[bit] != 0
                ) {
                    value = ink
                }
            }
            for (bit, center) in jobBits.enumerated() {
                let side = BoardPrintContract.jobCodeMarkerSizeMM
                if squareInk(
                    x: pageX,
                    y: pageY,
                    centerX: center.x,
                    centerY: center.y,
                    side: side,
                    filled: jobPattern[bit] != 0
                ) {
                    value = ink
                }
            }

            for (id, centerX, centerY) in itemRows {
                let dx = pageX - centerX
                let dy = pageY - centerY
                let radius = layout.circleSizeMM / 2
                let distanceFromCenter = hypot(dx, dy)
                if abs(distanceFromCenter - radius) <= 0.18 { value = ink }
                switch marks[id] ?? .blank {
                case .blank:
                    break
                case .filled:
                    if distanceFromCenter <= radius * 0.88 { value = ink }
                case .check:
                    if distanceToSegment(
                        x: dx, y: dy,
                        start: (-1.05, 0.05), end: (-0.28, 0.82)
                    ) <= 0.25 || distanceToSegment(
                        x: dx, y: dy,
                        start: (-0.28, 0.82), end: (1.15, -0.78)
                    ) <= 0.25 {
                        value = ink
                    }
                case .x:
                    if distanceToSegment(
                        x: dx, y: dy,
                        start: (-0.95, -0.95), end: (0.95, 0.95)
                    ) <= 0.23 || distanceToSegment(
                        x: dx, y: dy,
                        start: (-0.95, 0.95), end: (0.95, -0.95)
                    ) <= 0.23 {
                        value = ink
                    }
                }
            }
            pixels[py * width + px] = value
        }
    }
    return PhysicalChecklistGrayImage(pixels: pixels, width: width, height: height)
}

private func ocrLines(for job: PhysicalChecklistJob) -> [PhysicalChecklistOCRLine] {
    let layout = PhysicalChecklistLayout.build(job: job)
    let width = 980.0
    let height = 1280.0
    let originX = 72.0
    let originY = 62.0
    let scaleX = 7.55
    let scaleY = 7.45
    let shear = 0.22
    return layout.pages.flatMap(\.rows).compactMap { row in
        guard case let .item(item) = row.kind, let circle = row.circleCenterMM else { return nil }
        let pageX = circle.x + layout.circleSizeMM / 2 + 2.4
        let pageY = row.yMM + row.titleBandMM / 2
        let pixelX = originX + shear * pageY + pageX * scaleX
        let pixelY = originY + pageY * scaleY
        return PhysicalChecklistOCRLine(
            text: item.title,
            x: pixelX / width,
            y: (pixelY - 5) / height,
            width: 180 / width,
            height: 10 / height
        )
    }
}

private func pointInRect(
    _ x: Double,
    _ y: Double,
    _ rect: (x: Double, y: Double, width: Double, height: Double)
) -> Bool {
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

private func squareInk(
    x: Double,
    y: Double,
    centerX: Double,
    centerY: Double,
    side: Double,
    filled: Bool
) -> Bool {
    let dx = abs(x - centerX)
    let dy = abs(y - centerY)
    guard dx <= side / 2, dy <= side / 2 else { return false }
    if filled { return true }
    return max(dx, dy) >= side / 2 - 0.20
}

private func distanceToSegment(
    x: Double,
    y: Double,
    start: (Double, Double),
    end: (Double, Double)
) -> Double {
    let dx = end.0 - start.0
    let dy = end.1 - start.1
    let denominator = dx * dx + dy * dy
    let raw = denominator == 0 ? 0 : ((x - start.0) * dx + (y - start.1) * dy) / denominator
    let t = min(1, max(0, raw))
    return hypot(x - (start.0 + t * dx), y - (start.1 + t * dy))
}
