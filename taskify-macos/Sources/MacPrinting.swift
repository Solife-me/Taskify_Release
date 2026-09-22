import AppKit
import SwiftUI
import TaskifyCore

struct MacPrintChecklistSheet: View {
    let board: Board
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var paper = PhysicalChecklistPaper.letter
    @State private var includeCompleted = false
    @State private var error: String?

    private var items: [PhysicalChecklistItem] {
        let columns: [BoardColumn] = board.kind == .week
            ? WeekdayColumn.ordered(startingAt: model.weekStart).compactMap { day in board.columns.first { $0.id == day.rawValue } }
            : board.columns.sorted { $0.order < $1.order }
        return columns.flatMap { column in
            model.tasks(boardID: board.id, columnID: column.id, includeCompleted: includeCompleted)
                .map { PhysicalChecklistItem(id: $0.id, title: $0.title, section: column.name, filled: $0.completed) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Print Checklist").font(.title2.bold())
            Text(board.name).foregroundStyle(.secondary)
            Picker("Paper", selection: $paper) {
                ForEach(PhysicalChecklistPaper.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            Toggle("Include Completed Tasks", isOn: $includeCompleted)
            if items.isEmpty {
                Text("No tasks to print yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("\(items.count) task\(items.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
            Spacer()
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Print…") { printChecklist() }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(items.isEmpty)
            }
        }.padding(26).frame(width: 380, height: 280)
    }

    private func printChecklist() {
        let job = PhysicalChecklistJob(ownerID: model.identityPublicKey, title: board.name, paper: paper, format: .taskList, items: items)
        let view = MacPhysicalChecklistPrintView(job: job)
        let pointsPerMM = 72.0 / 25.4
        let sizeMM = paper.sizeMM
        let printInfo = NSPrintInfo()
        printInfo.paperSize = NSSize(width: sizeMM.width * pointsPerMM, height: sizeMM.height * pointsPerMM)
        printInfo.topMargin = 0
        printInfo.bottomMargin = 0
        printInfo.leftMargin = 0
        printInfo.rightMargin = 0
        printInfo.horizontalPagination = .fit
        printInfo.verticalPagination = .fit
        printInfo.isVerticallyCentered = false
        printInfo.isHorizontallyCentered = false
        let operation = NSPrintOperation(view: view, printInfo: printInfo)
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        guard operation.run() else {
            error = "Printing could not start. Choose a printer or PDF destination and try again."
            return
        }
        dismiss()
    }
}

/// Mirrors `PhysicalChecklistPDFRenderer` (iOS, `BibleTrackerView.swift`) drawing operation for
/// operation, using the identical `PhysicalChecklistLayout` millimeter geometry and the same page-ID
/// marker encoding (`page.index + 1` as a 6-bit pattern of filled/outlined squares), so a page
/// printed from Mac stays readable by the iOS scan-back-in flow. Pages stack vertically in one tall
/// view, AppKit's classic custom-pagination technique: `knowsPageRange`/`rectForPage` slice the
/// print job, `draw(_:)` renders whichever page(s) fall in the requested rect.
final class MacPhysicalChecklistPrintView: NSView {
    private let job: PhysicalChecklistJob
    private let layout: PhysicalChecklistLayout
    private static let pointsPerMM = 72.0 / 25.4
    private let pageWidthPoints: CGFloat
    private let pageHeightPoints: CGFloat

    init(job: PhysicalChecklistJob) {
        self.job = job
        layout = PhysicalChecklistLayout.build(job: job)
        let size = job.paper.sizeMM
        pageWidthPoints = size.width * Self.pointsPerMM
        pageHeightPoints = size.height * Self.pointsPerMM
        super.init(frame: NSRect(x: 0, y: 0, width: pageWidthPoints, height: pageHeightPoints * CGFloat(max(1, layout.pages.count))))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }

    override func knowsPageRange(_ range: NSRangePointer) -> Bool {
        range.pointee = NSRange(location: 1, length: max(1, layout.pages.count))
        return true
    }

    override func rectForPage(_ page: Int) -> NSRect {
        NSRect(x: 0, y: CGFloat(page - 1) * pageHeightPoints, width: pageWidthPoints, height: pageHeightPoints)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        dirtyRect.fill()
        for (index, page) in layout.pages.enumerated() {
            let yOffset = CGFloat(index) * pageHeightPoints
            guard dirtyRect.intersects(NSRect(x: 0, y: yOffset, width: pageWidthPoints, height: pageHeightPoints)) else { continue }
            drawMarkers(yOffset: yOffset)
            drawHeader(page: page, yOffset: yOffset)
            drawRows(page.rows, yOffset: yOffset)
        }
    }

    private func rectMM(_ x: Double, _ y: Double, _ width: Double, _ height: Double, yOffset: CGFloat) -> NSRect {
        NSRect(x: x * Self.pointsPerMM, y: y * Self.pointsPerMM + yOffset, width: width * Self.pointsPerMM, height: height * Self.pointsPerMM)
    }

    private func drawMarkers(yOffset: CGFloat) {
        for (index, marker) in layout.markerRectsMM().enumerated() {
            let rect = rectMM(marker.x, marker.y, marker.width, marker.height, yOffset: yOffset)
            if index < 2 {
                NSColor.black.setStroke()
                let outer = NSBezierPath(rect: rect)
                outer.lineWidth = 1.2
                outer.stroke()
                NSColor.black.setFill()
                NSBezierPath(rect: rect.insetBy(dx: rect.width * 0.32, dy: rect.height * 0.32)).fill()
            } else {
                NSColor.black.setFill()
                NSBezierPath(rect: rect).fill()
            }
        }
    }

    private func drawHeader(page: PhysicalChecklistPage, yOffset: CGFloat) {
        let size = job.paper.sizeMM
        let titleRect = rectMM(PhysicalChecklistLayout.marginMM, layout.headerTopMM, size.width * 0.62, 7, yOffset: yOffset)
        (job.title as NSString).draw(in: titleRect, withAttributes: [
            .font: NSFont.systemFont(ofSize: job.format == .bibleChapters ? 13 : 15, weight: .bold),
            .foregroundColor: NSColor.black,
        ])
        let subtitle = "Fill circles with a dark pen \u{2022} Page \(page.index + 1) of \(layout.pages.count)"
        (subtitle as NSString).draw(
            in: rectMM(PhysicalChecklistLayout.marginMM, layout.headerTopMM + 7, size.width * 0.72, 5, yOffset: yOffset),
            withAttributes: [.font: NSFont.systemFont(ofSize: 7), .foregroundColor: NSColor.darkGray]
        )

        let bits = page.index + 1
        for (bit, center) in layout.pageIDBitCentersMM().enumerated() {
            let side = PhysicalChecklistLayout.pageIDSizeMM
            let rect = rectMM(center.x - side / 2, center.y - side / 2, side, side, yOffset: yOffset)
            let path = NSBezierPath(rect: rect)
            if bits & (1 << bit) != 0 {
                NSColor.black.setFill()
                path.fill()
            } else {
                NSColor.black.setStroke()
                path.lineWidth = 0.7
                path.stroke()
            }
        }
    }

    private func drawRows(_ rows: [PhysicalChecklistRow], yOffset: CGFloat) {
        for row in rows {
            switch row.kind {
            case let .section(section):
                (section.uppercased() as NSString).draw(
                    in: rectMM(row.xMM, row.yMM + 1.0, row.widthMM, 4.5, yOffset: yOffset),
                    withAttributes: [.font: NSFont.systemFont(ofSize: 7.2, weight: .bold), .foregroundColor: NSColor.darkGray]
                )
            case let .item(item):
                guard let center = row.circleCenterMM else { continue }
                let side = layout.circleSizeMM
                let circleRect = rectMM(center.x - side / 2, center.y - side / 2, side, side, yOffset: yOffset)
                let circle = NSBezierPath(ovalIn: circleRect)
                NSColor.black.setStroke()
                circle.lineWidth = 0.85
                circle.stroke()
                if item.filled {
                    NSColor.black.setFill()
                    circle.fill()
                }
                let textX = center.x + side / 2 + (layout.circleSizeMM < 4 ? 1.2 : 2.4)
                let textY = row.yMM + (layout.circleSizeMM < 4 ? 0.9 : 1.35)
                (item.title as NSString).draw(
                    in: rectMM(textX, textY, max(1, row.xMM + row.widthMM - textX), 4.6, yOffset: yOffset),
                    withAttributes: [.font: NSFont.systemFont(ofSize: layout.circleSizeMM < 4 ? 6.4 : 8.2), .foregroundColor: NSColor.black]
                )
            }
        }
    }
}
