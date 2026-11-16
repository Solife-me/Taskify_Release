import Foundation
import CoreGraphics

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

    /// Renders a camera image into the scanner's top-left-origin grayscale buffer.
    ///
    /// `CGContext` bitmap storage starts at the image's lower edge. Drawing directly into the
    /// buffer gives the scanner display-order rows; flipping the context here would turn the sheet
    /// upside down and make none of the four printed markers line up.
    public static func from(cgImage: CGImage, targetWidth: Int = 900) -> Self? {
        guard targetWidth > 0, cgImage.width > 0, cgImage.height > 0 else { return nil }
        let targetHeight = max(
            1,
            Int((Double(targetWidth) * Double(cgImage.height) / Double(cgImage.width)).rounded())
        )
        var pixels = [UInt8](repeating: 255, count: targetWidth * targetHeight)
        let rendered = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: targetWidth,
                height: targetHeight,
                bitsPerComponent: 8,
                bytesPerRow: targetWidth,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.interpolationQuality = .high
            context.draw(
                cgImage,
                in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight)
            )
            return true
        }
        return rendered ? Self(pixels: pixels, width: targetWidth, height: targetHeight) : nil
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

public struct PhysicalChecklistScanMatch: Sendable {
    public var job: PhysicalChecklistJob?
    public var result: PhysicalChecklistScanResult

    public init(job: PhysicalChecklistJob?, result: PhysicalChecklistScanResult) {
        self.job = job
        self.result = result
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
    }

    public static func scan(
        images: [PhysicalChecklistGrayImage],
        job: PhysicalChecklistJob
    ) -> PhysicalChecklistScanResult {
        var detected = Set<String>()
        var recognized = Set<Int>()
        var mismatchedJobs = 0
        var unreadablePageIDs = 0

        for image in images {
            var candidate = image
            var fallback = Outcome.ignored
            var recognizedImage = false
            for _ in 0..<4 {
                for paper in paperOrder(startingWith: job.paper) {
                    var scopedJob = job
                    scopedJob.paper = paper
                    let result = PhysicalChecklistScanEngine.scan(images: [candidate], job: scopedJob)
                    if result.recognizedPages > 0 {
                        recognized.formUnion(0..<result.recognizedPages)
                        detected.formUnion(result.detectedIDs)
                        recognizedImage = true
                        break
                    }
                    if result.unreadablePageIDs > 0 {
                        fallback = .unreadablePageID
                    } else if result.mismatchedJobs > 0, fallback == .ignored {
                        fallback = .mismatchedJob
                    }
                }
                if recognizedImage { break }
                candidate = candidate.rotatedClockwise()
            }
            guard !recognizedImage else { continue }
            switch fallback {
            case .mismatchedJob: mismatchedJobs += 1
            case .unreadablePageID: unreadablePageIDs += 1
            case .ignored: break
            }
        }

        return PhysicalChecklistScanResult(
            detectedIDs: detected.sorted(),
            recognizedPages: recognized.count,
            mismatchedJobs: mismatchedJobs,
            unreadablePageIDs: unreadablePageIDs
        )
    }

    /// Tries every compatible print manifest and lets the page's encoded print job select the
    /// correct mapping. PWA boards can arrive under a local owner key or a different UUID casing;
    /// the job code remains the authority on which cached manifest belongs to this sheet.
    public static func match(
        images: [PhysicalChecklistGrayImage],
        jobs: [PhysicalChecklistJob]
    ) -> PhysicalChecklistScanMatch {
        var mismatchedJobs = 0
        var unreadablePageIDs = 0
        for job in jobs {
            let result = scan(images: images, job: job)
            if result.recognizedPages > 0 {
                return PhysicalChecklistScanMatch(job: job, result: result)
            }
            mismatchedJobs = max(mismatchedJobs, result.mismatchedJobs)
            unreadablePageIDs = max(unreadablePageIDs, result.unreadablePageIDs)
        }
        return PhysicalChecklistScanMatch(
            job: nil,
            result: PhysicalChecklistScanResult(
                detectedIDs: [],
                recognizedPages: 0,
                mismatchedJobs: mismatchedJobs,
                unreadablePageIDs: unreadablePageIDs
            )
        )
    }

    private static func paperOrder(startingWith paper: PhysicalChecklistPaper) -> [PhysicalChecklistPaper] {
        [paper] + PhysicalChecklistPaper.allCases.filter { $0 != paper }
    }

    /// A photographed bit can read wrong. Accept up to two bit differences, matching the PWA
    /// scanner, instead of rejecting an otherwise matching sheet.
    static func jobCodeMatches(_ observed: Int, _ expected: Int) -> Bool {
        let differences = (observed ^ expected).nonzeroBitCount
        return differences <= max(1, BoardPrintContract.jobCodeBits / 5)
    }
}
