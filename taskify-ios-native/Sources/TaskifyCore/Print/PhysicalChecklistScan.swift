import Foundation

/// A scanned checklist page as brightness values, one byte per pixel, row by row.
public struct PhysicalChecklistGrayImage: Sendable {
    public let pixels: [UInt8]
    public let width: Int
    public let height: Int

    public init(pixels: [UInt8], width: Int, height: Int) {
        self.pixels = pixels
        self.width = width
        self.height = height
    }

    /// The mean brightness in a circle at a point given as a fraction of the image, with a radius
    /// as a fraction of the shorter side (the units the checklist layout works in).
    func mean(x: Double, y: Double, radius: Double) -> Double {
        let cx = min(max(Int(x * Double(width)), 0), width - 1)
        let cy = min(max(Int(y * Double(height)), 0), height - 1)
        let r = max(1, Int(radius * Double(min(width, height))))
        var sum = 0
        var count = 0
        for py in max(0, cy - r)...min(height - 1, cy + r) {
            for px in max(0, cx - r)...min(width - 1, cx + r) {
                let dx = px - cx
                let dy = py - cy
                guard dx * dx + dy * dy <= r * r else { continue }
                sum += Int(pixels[py * width + px])
                count += 1
            }
        }
        return count == 0 ? 255 : Double(sum) / Double(count)
    }

    /// A quarter turn clockwise. The document scanner normally straightens a page, but a sheet
    /// photographed sideways still has to be readable, so the analyzer tries every orientation.
    public func rotatedClockwise() -> PhysicalChecklistGrayImage {
        var rotated = [UInt8](repeating: 255, count: width * height)
        for y in 0..<height {
            let rowStart = y * width
            let targetX = height - 1 - y
            for x in 0..<width {
                rotated[x * height + targetX] = pixels[rowStart + x]
            }
        }
        return PhysicalChecklistGrayImage(pixels: rotated, width: height, height: width)
    }

    /// The sheet alone, for a scan that kept the darker surface around it. The document scanner
    /// normally crops to the page; when it could not, the layout's page fractions are wrong unless
    /// this trims the surrounding background first.
    public func croppedToPage() -> PhysicalChecklistGrayImage {
        guard width > 8, height > 8 else { return self }
        let threshold = otsuThreshold()

        var columnHits = [Int](repeating: 0, count: width)
        var columnCounts = [Int](repeating: 0, count: width)
        var rowHits = [Int](repeating: 0, count: height)
        var rowCounts = [Int](repeating: 0, count: height)
        for y in 0..<height {
            for x in 0..<width {
                let bright = pixels[y * width + x] > threshold
                columnCounts[x] += 1
                rowCounts[y] += 1
                if bright {
                    columnHits[x] += 1
                    rowHits[y] += 1
                }
            }
        }

        guard
            let (minX, maxX) = brightRun(hits: columnHits, counts: columnCounts),
            let (minY, maxY) = brightRun(hits: rowHits, counts: rowCounts)
        else {
            return self
        }
        let cropWidth = maxX - minX
        let cropHeight = maxY - minY
        guard cropWidth >= width / 2, cropHeight >= height / 2 else { return self }
        guard cropWidth < width - 2 || cropHeight < height - 2 else { return self }

        var cropped = [UInt8](repeating: 255, count: cropWidth * cropHeight)
        for y in 0..<cropHeight {
            let sourceRow = (minY + y) * width + minX
            let targetRow = y * cropWidth
            for x in 0..<cropWidth {
                cropped[targetRow + x] = pixels[sourceRow + x]
            }
        }
        return PhysicalChecklistGrayImage(pixels: cropped, width: cropWidth, height: cropHeight)
    }

    /// The longest run of rows or columns that are mostly bright (paper), which is the page.
    private func brightRun(hits: [Int], counts: [Int]) -> (Int, Int)? {
        var bestStart = 0
        var bestLength = 0
        var runStart = -1
        var runLength = 0
        for index in 0..<hits.count {
            let bright = counts[index] > 0 && Double(hits[index]) / Double(counts[index]) > 0.5
            if bright {
                if runStart < 0 {
                    runStart = index
                    runLength = 0
                }
                runLength += 1
                if runLength > bestLength {
                    bestLength = runLength
                    bestStart = runStart
                }
            } else {
                runStart = -1
                runLength = 0
            }
        }
        guard bestLength > 0 else { return nil }
        return (bestStart, bestStart + bestLength)
    }

    private func otsuThreshold() -> UInt8 {
        var histogram = [Int](repeating: 0, count: 256)
        let stride = max(1, min(width, height) / 200)
        var total = 0
        var sum = 0
        for y in Swift.stride(from: 0, to: height, by: stride) {
            for x in Swift.stride(from: 0, to: width, by: stride) {
                let value = Int(pixels[y * width + x])
                histogram[value] += 1
                total += 1
                sum += value
            }
        }
        guard total > 0 else { return 128 }
        var sumB = 0.0
        var weightB = 0.0
        var bestVariance = 0.0
        var threshold = 0
        for value in 0..<256 {
            let weight = Double(histogram[value])
            if weight == 0 { continue }
            weightB += weight
            let weightF = Double(total) - weightB
            if weightF <= 0 { break }
            sumB += Double(value) * weight
            let meanB = sumB / weightB
            let meanF = (Double(sum) - sumB) / weightF
            let variance = weightB * weightF * (meanB - meanF) * (meanB - meanF)
            if variance > bestVariance {
                bestVariance = variance
                threshold = value
            }
        }
        return UInt8(threshold)
    }
}

public struct PhysicalChecklistScanResult: Sendable {
    public var detectedIDs: [String]
    public var recognizedPages: Int
    public var mismatchedJobs: Int
    public var unreadablePageIDs: Int

    public init(detectedIDs: [String], recognizedPages: Int, mismatchedJobs: Int, unreadablePageIDs: Int) {
        self.detectedIDs = detectedIDs
        self.recognizedPages = recognizedPages
        self.mismatchedJobs = mismatchedJobs
        self.unreadablePageIDs = unreadablePageIDs
    }
}

/// Reads photographed checklist pages: the paper, orientation and corner markers are worked out
/// from the sheet itself, then the print code proves it belongs to this job and the page bits name
/// the page. Every paper and orientation is tried because a sheet can be printed on one paper size
/// and scanned by a device that recorded another, or scanned sideways.
public enum PhysicalChecklistScanAnalyzer {
    private enum Outcome {
        case ignored
        case mismatchedJob
        case unreadablePageID
        case recognized(pageIndex: Int, detectedIDs: [String])
    }

    private static let markerThreshold = 185.0
    private static let bitThreshold = 170.0
    private static let fillThreshold = 168.0

    public static func scan(
        images: [PhysicalChecklistGrayImage],
        job: PhysicalChecklistJob
    ) -> PhysicalChecklistScanResult {
        let expectedJobCode = BoardPrintContract.jobCode(jobID: job.id)
        var detected = Set<String>()
        var recognized = Set<Int>()
        var mismatchedJobs = 0
        var unreadablePageIDs = 0

        for image in images {
            switch analyze(image: image, job: job, expectedJobCode: expectedJobCode) {
            case .ignored:
                continue
            case .mismatchedJob:
                mismatchedJobs += 1
            case .unreadablePageID:
                unreadablePageIDs += 1
            case let .recognized(pageIndex, detectedIDs):
                recognized.insert(pageIndex)
                detected.formUnion(detectedIDs)
            }
        }

        return PhysicalChecklistScanResult(
            detectedIDs: detected.sorted(),
            recognizedPages: recognized.count,
            mismatchedJobs: mismatchedJobs,
            unreadablePageIDs: unreadablePageIDs
        )
    }

    private static func analyze(
        image: PhysicalChecklistGrayImage,
        job: PhysicalChecklistJob,
        expectedJobCode: Int
    ) -> Outcome {
        var candidate = image
        var sawPlausibleSheet = false
        for _ in 0..<4 {
            let page = candidate.croppedToPage()
            for paper in paperOrder(startingWith: job.paper) {
                let layout = layout(job: job, paper: paper)
                guard markersPresent(page, layout: layout) else { continue }
                sawPlausibleSheet = true
                let observedCode = readJobCode(page, layout: layout, jobID: job.id)
                if observedCode == expectedJobCode {
                    return readPage(page, layout: layout)
                }
            }
            candidate = candidate.rotatedClockwise()
        }
        return sawPlausibleSheet ? .mismatchedJob : .ignored
    }

    private static func paperOrder(startingWith paper: PhysicalChecklistPaper) -> [PhysicalChecklistPaper] {
        [paper] + PhysicalChecklistPaper.allCases.filter { $0 != paper }
    }

    private static func layout(job: PhysicalChecklistJob, paper: PhysicalChecklistPaper) -> PhysicalChecklistLayout {
        var scoped = job
        scoped.paper = paper
        return PhysicalChecklistLayout.build(job: scoped)
    }

    private static func markersPresent(
        _ image: PhysicalChecklistGrayImage,
        layout: PhysicalChecklistLayout
    ) -> Bool {
        let size = layout.paper.sizeMM
        let darkCount = layout.markerRectsMM().filter { rect in
            markerDarkness(image, rect: rect, paper: size) < markerThreshold
        }.count
        return darkCount >= 3
    }

    /// The darkest sample across a marker's inner area. A finder marker can be light in its exact
    /// centre (the PWA draws one that way) or only at its edge (the native one); a small grid finds
    /// the dark frame either way, and also tolerates a marker a millimetre off its expected spot.
    private static func markerDarkness(
        _ image: PhysicalChecklistGrayImage,
        rect: (x: Double, y: Double, width: Double, height: Double),
        paper: (width: Double, height: Double)
    ) -> Double {
        var darkest = 255.0
        for fx in [-0.3, 0.0, 0.3] {
            for fy in [-0.3, 0.0, 0.3] {
                let x = (rect.x + rect.width * (0.5 + fx)) / paper.width
                let y = (rect.y + rect.height * (0.5 + fy)) / paper.height
                darkest = min(darkest, image.mean(x: x, y: y, radius: 0.003))
            }
        }
        return darkest
    }

    private static func readJobCode(
        _ image: PhysicalChecklistGrayImage,
        layout: PhysicalChecklistLayout,
        jobID: String
    ) -> Int {
        let size = layout.paper.sizeMM
        var code = 0
        for (bit, center) in layout.jobCodeBitCentersMM(jobID: jobID).enumerated() {
            let value = image.mean(x: center.x / size.width, y: center.y / size.height, radius: 0.0018)
            if value < bitThreshold { code |= 1 << bit }
        }
        return code
    }

    private static func readPage(_ image: PhysicalChecklistGrayImage, layout: PhysicalChecklistLayout) -> Outcome {
        guard layout.pages.count > 1 else {
            return .recognized(pageIndex: 0, detectedIDs: filledItemIDs(image, layout: layout, pageIndex: 0))
        }

        let size = layout.paper.sizeMM
        var encodedPage = 0
        for (bit, center) in layout.pageIDBitCentersMM().enumerated() {
            let value = image.mean(x: center.x / size.width, y: center.y / size.height, radius: 0.0025)
            if value < bitThreshold { encodedPage |= 1 << bit }
        }
        let pageIndex = encodedPage - 1
        guard layout.pages.indices.contains(pageIndex) else { return .unreadablePageID }
        return .recognized(pageIndex: pageIndex, detectedIDs: filledItemIDs(image, layout: layout, pageIndex: pageIndex))
    }

    private static func filledItemIDs(
        _ image: PhysicalChecklistGrayImage,
        layout: PhysicalChecklistLayout,
        pageIndex: Int
    ) -> [String] {
        let size = layout.paper.sizeMM
        var detected: [String] = []
        for row in layout.pages[pageIndex].rows {
            guard case let .item(item) = row.kind, let center = row.circleCenterMM else { continue }
            let darkness = image.mean(
                x: center.x / size.width,
                y: center.y / size.height,
                radius: max(0.0015, layout.circleSizeMM / size.width * 0.12)
            )
            if darkness < fillThreshold {
                detected.append(item.id)
            }
        }
        return detected
    }
}
