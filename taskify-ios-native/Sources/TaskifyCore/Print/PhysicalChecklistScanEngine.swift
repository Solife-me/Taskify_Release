import Foundation

/// Reads a photographed physical checklist after locating its four printed alignment markers.
///
/// Geometry and mark classification live in TaskifyCore so iOS can be tested with camera-like
/// A6 images instead of relying on VisionKit to crop every page at exactly the same coordinates.
public enum PhysicalChecklistScanEngine {
    private struct Point {
        var x: Double
        var y: Double
    }

    private struct Component {
        var minX: Int
        var minY: Int
        var maxX: Int
        var maxY: Int
        var area: Int

        var width: Int { maxX - minX + 1 }
        var height: Int { maxY - minY + 1 }
        var center: Point {
            Point(x: Double(minX + maxX) / 2, y: Double(minY + maxY) / 2)
        }
        var boxArea: Double { Double(width * height) }
    }

    private struct MarkerSet {
        var topLeft: Point
        var topRight: Point
        var bottomRight: Point
        var bottomLeft: Point

        var corners: [Point] { [topLeft, topRight, bottomRight, bottomLeft] }
    }

    private struct ScanContext {
        let image: PhysicalChecklistGrayImage
        /// Projective transform from physical page millimeters to image pixels.
        let matrix: [Double]
    }

    // Document-scanner cleanup and toner fading can leave a valid marker around 170 luma even
    // against a near-white page. The contrast and print-code checks still reject ordinary text.
    private static let maximumMarkerLuma = 210.0
    private static let minimumMarkerContrast = 32.0

    public static func scan(
        images: [PhysicalChecklistGrayImage],
        job: PhysicalChecklistJob,
        requiresMatchingJobCode: Bool = true
    ) -> PhysicalChecklistScanResult {
        var detected = Set<String>()
        var recognized = Set<Int>()
        var mismatchedJobs = 0
        var unreadablePageIDs = 0

        for image in images {
            var recognizedImage = false
            var mismatchedImage = false
            var unreadableImage = false
            for paper in [job.paper] + PhysicalChecklistPaper.allCases.filter({ $0 != job.paper }) {
                var scopedJob = job
                scopedJob.paper = paper
                let layout = PhysicalChecklistLayout.build(job: scopedJob)
                guard let context = buildContext(image: image, layout: layout) else { continue }
                let markerMedian = sampleMarkerMedian(context: context, layout: layout)
                let backgroundMedian = samplePageBackground(context: context, layout: layout)
                guard markerMedian <= maximumMarkerLuma,
                      backgroundMedian - markerMedian >= minimumMarkerContrast else { continue }

                if requiresMatchingJobCode, !jobCodeMatches(
                    context: context,
                    layout: layout,
                    jobID: job.id,
                    backgroundMedian: backgroundMedian,
                    markerMedian: markerMedian
                ) {
                    mismatchedImage = true
                    continue
                }

                guard let pageIndex = pageIndex(
                    context: context,
                    layout: layout,
                    backgroundMedian: backgroundMedian,
                    markerMedian: markerMedian
                ) else {
                    unreadableImage = true
                    continue
                }
                recognized.insert(pageIndex)

                for row in layout.pages[pageIndex].rows {
                    guard case let .item(item) = row.kind, let center = row.circleCenterMM else { continue }
                    if markIsFilledOrChecked(
                        context: context,
                        center: Point(x: center.x, y: center.y),
                        circleSizeMM: layout.circleSizeMM,
                        backgroundMedian: backgroundMedian,
                        markerMedian: markerMedian
                    ) {
                        detected.insert(item.id)
                    }
                }
                recognizedImage = true
                break
            }
            if !recognizedImage {
                if unreadableImage {
                    unreadablePageIDs += 1
                } else if mismatchedImage {
                    mismatchedJobs += 1
                }
            }
        }

        return PhysicalChecklistScanResult(
            detectedIDs: detected.sorted(),
            recognizedPages: recognized.count,
            mismatchedJobs: mismatchedJobs,
            unreadablePageIDs: unreadablePageIDs
        )
    }

    /// Unknown print manifests are common when the printing and scanning devices use different
    /// identities. Pair a circle with the OCR line on that physical row before resolving its ID.
    public static func scanBoardPage(
        image: PhysicalChecklistGrayImage,
        lines: [PhysicalChecklistOCRLine],
        catalog: PhysicalChecklistJob
    ) -> PhysicalChecklistScanResult {
        let defaultLayout = PhysicalChecklistLayout.build(job: catalog)
        let ignored = PhysicalChecklistScanResult(
            detectedIDs: [], recognizedPages: 0, mismatchedJobs: 0, unreadablePageIDs: 0
        )
        guard !lines.isEmpty, image.width > 0, image.height > 0,
              image.pixels.count == image.width * image.height,
              let markers = detectMarkers(image: image, layout: defaultLayout) else { return ignored }

        let boardTitle = normalizedTitle(catalog.title)
        let titles = catalog.items.map { ($0.id, normalizedTitle($0.title)) }
        let readLines = lines.map { ($0, normalizedTitle($0.text)) }
        var best: (quality: Double, ids: [String])?
        for paper in PhysicalChecklistPaper.allCases {
            var pageJob = catalog
            pageJob.items = []
            pageJob.paper = paper
            let layout = PhysicalChecklistLayout.build(job: pageJob)
            guard let context = buildContext(image: image, layout: layout, markers: markers),
                  let inverse = solveHomography(
                    source: markers.corners,
                    target: markerCenters(layout: layout)
                  ) else { continue }
            let headerMatches = readLines.contains { line, title in
                guard title == boardTitle || title == "\(boardTitle) print" else { return false }
                let point = lineStart(line, image: image, inverse: inverse)
                return abs(point.x - PhysicalChecklistLayout.marginMM) <= 4
                    && (layout.headerTopMM - 3..<layout.contentTopMM).contains(point.y)
            }
            guard headerMatches else { continue }

            let pageBackground = samplePageBackground(context: context, layout: layout)
            let markerMedian = sampleMarkerMedian(context: context, layout: layout)
            guard markerMedian <= maximumMarkerLuma,
                  pageBackground - markerMedian >= minimumMarkerContrast else { continue }

            let margin = PhysicalChecklistLayout.marginMM + (paper == .a6 ? BoardPrintContract.a6BindingMarginMM : 0)
            let circleSize = layout.circleSizeMM
            let circleX = margin + circleSize / 2
            let titleX = margin + circleSize + BoardPrintContract.circleTextGapMM
            var rows: [String: [(center: Point, marked: Bool)]] = [:]
            var quality = 0.0
            for (line, title) in readLines {
                let point = lineStart(line, image: image, inverse: inverse)
                guard (layout.contentTopMM - 2..<paper.sizeMM.height - margin).contains(point.y),
                      (margin - 2...titleX + 5).contains(point.x) else { continue }
                // OCR can include a circle in the text box and read it as a leading O.
                let normalized = point.x < titleX - 2 && (title.hasPrefix("o ") || title.hasPrefix("0 "))
                    ? String(title.dropFirst(2)) : title
                guard let id = uniqueTaskID(for: normalized, titles: titles) else { continue }

                let expectedCenter = Point(x: circleX, y: point.y)
                guard let circle = locateCircle(
                    context: context,
                    expectedCenter: expectedCenter,
                    circleSizeMM: circleSize,
                    minimumContrast: max(9, (pageBackground - markerMedian) * 0.085),
                    searchSteps: 4
                ) else { continue }

                // Box fitting is independent of ink in the center. Pick the paper geometry
                // supported by the printed circles, including empty ones.
                quality += circle.score
                let marked = circleHasInteriorInk(context: context, circle: circle, markerMedian: markerMedian)
                rows[id, default: []].append((circle.center, marked))
            }
            guard !rows.isEmpty, quality > (best?.quality ?? 0) else { continue }
            let ids = rows.compactMap { id, matches -> String? in
                guard let first = matches.first,
                      matches.allSatisfy({ distance(first.center, $0.center) < circleSize / 2 }),
                      matches.contains(where: \.marked) else { return nil }
                return id
            }
            best = (quality, ids.sorted())
        }
        guard let best else { return ignored }
        return PhysicalChecklistScanResult(
            detectedIDs: best.ids, recognizedPages: 1, mismatchedJobs: 0, unreadablePageIDs: 0
        )
    }

    private static func lineStart(
        _ line: PhysicalChecklistOCRLine,
        image: PhysicalChecklistGrayImage,
        inverse: [Double]
    ) -> Point {
        applyHomography(Point(
            x: line.x * Double(image.width),
            y: (line.y + line.height / 2) * Double(image.height)
        ), matrix: inverse)
    }

    private static func uniqueTaskID(for observed: String, titles: [(String, String)]) -> String? {
        let exact = titles.filter { !$0.1.isEmpty && $0.1 == observed }
        if !exact.isEmpty { return exact.count == 1 ? exact[0].0 : nil }

        let observedWords = Set(observed.split(separator: " "))
        guard observedWords.count >= 3 else { return nil }
        let ranked = titles.map { id, title in
            let words = Set(title.split(separator: " "))
            let matched = words.intersection(observedWords).count
            let similarity = Double(matched * 2) / Double(words.count + observedWords.count)
            return (id: id, score: matched >= 3 ? similarity : 0)
        }.sorted { $0.score > $1.score }
        guard let best = ranked.first, best.score >= 0.75,
              best.score - (ranked.dropFirst().first?.score ?? 0) >= 0.12 else { return nil }
        return best.id
    }

    private static func normalizedTitle(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? Character(String($0)) : " " }
            .reduce(into: "") { $0.append($1) }
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    // MARK: - Page alignment

    private static func buildContext(
        image: PhysicalChecklistGrayImage,
        layout: PhysicalChecklistLayout
    ) -> ScanContext? {
        guard image.width > 0, image.height > 0,
              image.pixels.count == image.width * image.height,
              let markers = detectMarkers(image: image, layout: layout) else { return nil }
        return buildContext(image: image, layout: layout, markers: markers)
    }

    private static func buildContext(
        image: PhysicalChecklistGrayImage,
        layout: PhysicalChecklistLayout,
        markers: MarkerSet
    ) -> ScanContext? {
        guard let matrix = solveHomography(source: markerCenters(layout: layout), target: markers.corners)
        else { return nil }
        return ScanContext(image: image, matrix: matrix)
    }

    private static func markerCenters(layout: PhysicalChecklistLayout) -> [Point] {
        let rects = layout.markerRectsMM()
        // A homography walks the corners clockwise.
        return [rects[0], rects[1], rects[3], rects[2]].map {
            Point(x: $0.x + $0.width / 2, y: $0.y + $0.height / 2)
        }
    }

    private static func detectMarkers(
        image: PhysicalChecklistGrayImage,
        layout: PhysicalChecklistLayout
    ) -> MarkerSet? {
        let pixelCount = image.width * image.height
        guard pixelCount > 0 else { return nil }
        let otsu = otsuThreshold(image.pixels)
        let minimumArea = max(12, Int(Double(pixelCount) * 0.00002))
        let maximumArea = max(minimumArea, Int(Double(pixelCount) * 0.03))
        // A single global threshold fails when a corner lies in a deep camera shadow: the
        // shaded paper and marker merge into one oversized component. Darker passes separate
        // the actual ink while the ordinary Otsu pass still handles evenly lit pages.
        let thresholds = Set([
            min(190, max(45, otsu + 8)),
            min(190, max(32, otsu - 12)),
        ])
        var candidates = thresholds.flatMap {
            markerComponents(
                image: image,
                threshold: $0,
                minimumArea: minimumArea,
                maximumArea: maximumArea
            )
        }

        guard candidates.count >= 4 else { return nil }
        candidates.sort { lhs, rhs in
            if lhs.boxArea != rhs.boxArea { return lhs.boxArea > rhs.boxArea }
            return lhs.area > rhs.area
        }
        var unique: [Component] = []
        for candidate in candidates {
            let duplicate = unique.contains { existing in
                distance(candidate.center, existing.center) <= 2.5 &&
                    abs(candidate.width - existing.width) <= 4 &&
                    abs(candidate.height - existing.height) <= 4
            }
            if !duplicate { unique.append(candidate) }
            if unique.count == 64 { break }
        }
        candidates = unique

        let centerX = Double(image.width) / 2
        let centerY = Double(image.height) / 2
        let topLeft = candidates.filter { $0.center.x < centerX && $0.center.y < centerY }
        let topRight = candidates.filter { $0.center.x >= centerX && $0.center.y < centerY }
        let bottomLeft = candidates.filter { $0.center.x < centerX && $0.center.y >= centerY }
        let bottomRight = candidates.filter { $0.center.x >= centerX && $0.center.y >= centerY }
        guard !topLeft.isEmpty, !topRight.isEmpty, !bottomLeft.isEmpty, !bottomRight.isEmpty else { return nil }

        let expectedRatio = layout.paper.sizeMM.width / layout.paper.sizeMM.height
        let diagonal = hypot(Double(image.width), Double(image.height))
        var best: (score: Double, components: [Component])?

        for tl in cornerCandidates(topLeft, corner: Point(x: 0, y: 0), diagonal: diagonal) {
            for tr in cornerCandidates(topRight, corner: Point(x: Double(image.width), y: 0), diagonal: diagonal) {
                for bl in cornerCandidates(bottomLeft, corner: Point(x: 0, y: Double(image.height)), diagonal: diagonal) {
                    for br in cornerCandidates(bottomRight, corner: Point(x: Double(image.width), y: Double(image.height)), diagonal: diagonal) {
                        let topWidth = distance(tl.center, tr.center)
                        let bottomWidth = distance(bl.center, br.center)
                        let leftHeight = distance(tl.center, bl.center)
                        let rightHeight = distance(tr.center, br.center)
                        let minimumSide = Double(min(image.width, image.height)) * 0.25
                        guard min(topWidth, bottomWidth, leftHeight, rightHeight) >= minimumSide else { continue }
                        let ratio = ((topWidth + bottomWidth) / 2) / max(1, (leftHeight + rightHeight) / 2)
                        guard abs(ratio - expectedRatio) <= 0.32 else { continue }

                        let boxes = [tl.boxArea, tr.boxArea, bl.boxArea, br.boxArea]
                        let sizePenalty = log(max(1, boxes.max()! / max(1, boxes.min()!)))
                        let cornerPenalty = [
                            distance(tl.center, Point(x: 0, y: 0)),
                            distance(tr.center, Point(x: Double(image.width), y: 0)),
                            distance(bl.center, Point(x: 0, y: Double(image.height))),
                            distance(br.center, Point(x: Double(image.width), y: Double(image.height))),
                        ].reduce(0, +) / diagonal
                        let oppositePenalty = abs(topWidth - bottomWidth) / max(topWidth, bottomWidth) +
                            abs(leftHeight - rightHeight) / max(leftHeight, rightHeight)
                        let score = abs(ratio - expectedRatio) * 5 + sizePenalty * 1.6 +
                            cornerPenalty * 0.65 + oppositePenalty
                        if best == nil || score < best!.score {
                            best = (score, [tl, tr, br, bl])
                        }
                    }
                }
            }
        }

        guard let components = best?.components else { return nil }
        var resolved = MarkerSet(
            topLeft: components[0].center,
            topRight: components[1].center,
            bottomRight: components[2].center,
            bottomLeft: components[3].center
        )

        let finders = components.map { isFinderMarker(image: image, component: $0) }
        if finders.filter({ $0 }).count == 2 {
            if finders[3] && finders[2] { // bottom-left + bottom-right
                resolved = MarkerSet(
                    topLeft: resolved.bottomRight,
                    topRight: resolved.bottomLeft,
                    bottomRight: resolved.topLeft,
                    bottomLeft: resolved.topRight
                )
            } else if finders[1] && finders[2] { // right edge
                resolved = MarkerSet(
                    topLeft: resolved.topRight,
                    topRight: resolved.bottomRight,
                    bottomRight: resolved.bottomLeft,
                    bottomLeft: resolved.topLeft
                )
            } else if finders[0] && finders[3] { // left edge
                resolved = MarkerSet(
                    topLeft: resolved.bottomLeft,
                    topRight: resolved.topLeft,
                    bottomRight: resolved.topRight,
                    bottomLeft: resolved.bottomRight
                )
            }
        }
        return resolved
    }

    private static func markerComponents(
        image: PhysicalChecklistGrayImage,
        threshold: Int,
        minimumArea: Int,
        maximumArea: Int
    ) -> [Component] {
        let pixelCount = image.width * image.height
        let mask = image.pixels.map { $0 <= threshold }
        var visited = [Bool](repeating: false, count: pixelCount)
        var components: [Component] = []
        var stack: [Int] = []

        for start in 0..<pixelCount where mask[start] && !visited[start] {
            visited[start] = true
            stack.removeAll(keepingCapacity: true)
            stack.append(start)
            var component = Component(
                minX: image.width,
                minY: image.height,
                maxX: 0,
                maxY: 0,
                area: 0
            )

            while let current = stack.popLast() {
                let x = current % image.width
                let y = current / image.width
                component.minX = min(component.minX, x)
                component.minY = min(component.minY, y)
                component.maxX = max(component.maxX, x)
                component.maxY = max(component.maxY, y)
                component.area += 1

                if x > 0 { appendNeighbor(current - 1, mask: mask, visited: &visited, stack: &stack) }
                if x + 1 < image.width { appendNeighbor(current + 1, mask: mask, visited: &visited, stack: &stack) }
                if y > 0 { appendNeighbor(current - image.width, mask: mask, visited: &visited, stack: &stack) }
                if y + 1 < image.height { appendNeighbor(current + image.width, mask: mask, visited: &visited, stack: &stack) }
            }

            guard component.area >= minimumArea, component.area <= maximumArea,
                  component.width >= 4, component.height >= 4 else { continue }
            let aspect = Double(component.width) / Double(component.height)
            let fill = Double(component.area) / component.boxArea
            guard aspect >= 0.55, aspect <= 1.55, fill >= 0.10 else { continue }
            components.append(component)
        }
        return components
    }

    private static func appendNeighbor(
        _ index: Int,
        mask: [Bool],
        visited: inout [Bool],
        stack: inout [Int]
    ) {
        guard mask[index], !visited[index] else { return }
        visited[index] = true
        stack.append(index)
    }

    private static func cornerCandidates(
        _ components: [Component],
        corner: Point,
        diagonal: Double
    ) -> [Component] {
        Array(components.sorted { lhs, rhs in
            let lhsScore = distance(lhs.center, corner) / diagonal - log(max(1, lhs.boxArea)) * 0.035
            let rhsScore = distance(rhs.center, corner) / diagonal - log(max(1, rhs.boxArea)) * 0.035
            return lhsScore < rhsScore
        }.prefix(8))
    }

    private static func isFinderMarker(
        image: PhysicalChecklistGrayImage,
        component: Component
    ) -> Bool {
        let center = component.center
        let radius = Double(min(component.width, component.height)) / 2
        guard radius >= 2 else { return false }
        let centerLuma = sample(image: image, x: center.x, y: center.y, radius: max(1, radius * 0.08))
        let middleLuma = median([
            sample(image: image, x: center.x - radius * 0.30, y: center.y, radius: 1),
            sample(image: image, x: center.x + radius * 0.30, y: center.y, radius: 1),
            sample(image: image, x: center.x, y: center.y - radius * 0.30, radius: 1),
            sample(image: image, x: center.x, y: center.y + radius * 0.30, radius: 1),
        ])
        let edgeLuma = median([
            sample(image: image, x: center.x - radius * 0.43, y: center.y, radius: 1),
            sample(image: image, x: center.x + radius * 0.43, y: center.y, radius: 1),
            sample(image: image, x: center.x, y: center.y - radius * 0.43, radius: 1),
            sample(image: image, x: center.x, y: center.y + radius * 0.43, radius: 1),
        ])
        return middleLuma - max(centerLuma, edgeLuma) >= 30
    }

    // MARK: - Printed codes and marks

    private static func jobCodeMatches(
        context: ScanContext,
        layout: PhysicalChecklistLayout,
        jobID: String,
        backgroundMedian: Double,
        markerMedian: Double
    ) -> Bool {
        let threshold = markerMedian + max(18, (backgroundMedian - markerMedian) * 0.35)
        let expected = BoardPrintContract.jobCodePattern(jobID: jobID)
        let observed = layout.jobCodeBitCentersMM(jobID: jobID).map { center in
            samplePage(context: context, point: Point(x: center.x, y: center.y), radiusMM: 0.65) < threshold ? 1 : 0
        }
        guard observed.count == expected.count else { return false }
        let errors = zip(observed, expected).reduce(0) { $0 + ($1.0 == $1.1 ? 0 : 1) }
        return errors <= max(1, BoardPrintContract.jobCodeBits / 5)
    }

    private static func pageIndex(
        context: ScanContext,
        layout: PhysicalChecklistLayout,
        backgroundMedian: Double,
        markerMedian: Double
    ) -> Int? {
        if layout.pages.count == 1 { return 0 }
        let threshold = (backgroundMedian + markerMedian) / 2
        let observed = layout.pageIDBitCentersMM().map { center in
            samplePage(context: context, point: Point(x: center.x, y: center.y), radiusMM: 0.8) < threshold ? 1 : 0
        }
        var matches: [(index: Int, errors: Int)] = layout.pages.map { page in
            let expected = BoardPrintContract.pagePattern(pageIndex: page.index)
            let errors = zip(observed, expected).reduce(0) { $0 + ($1.0 == $1.1 ? 0 : 1) }
            return (page.index, errors)
        }
        matches.sort { $0.errors < $1.errors }
        guard let best = matches.first,
              best.errors <= max(1, BoardPrintContract.pageIDBits / 4),
              matches.count == 1 || matches[1].errors != best.errors else { return nil }
        return best.index
    }

    /// Counts solid fills as well as deliberate check and X strokes inside the printed outline.
    private static func markIsFilledOrChecked(
        context: ScanContext,
        center: Point,
        circleSizeMM: Double,
        backgroundMedian: Double,
        markerMedian: Double
    ) -> Bool {
        let circle = locateCircle(
            context: context,
            expectedCenter: center,
            circleSizeMM: circleSizeMM,
            minimumContrast: max(9, (backgroundMedian - markerMedian) * 0.085),
            searchSteps: 3
        ) ?? LocatedCircle(center: center, radius: circleSizeMM / 2, background: backgroundMedian, score: 0)
        return circleHasInteriorInk(context: context, circle: circle, markerMedian: markerMedian)
    }

    /// Fits the circle from changes in brightness around its perimeter. Looking for the same
    /// edge in opposing directions keeps a dark arc from an empty ring out of the sampled core.
    private struct LocatedCircle {
        var center: Point
        var radius: Double
        var background: Double
        var score: Double
    }

    private static let circleDirections = (0..<16).map { index in
        let angle = Double(index) * .pi / 8
        return Point(x: cos(angle), y: sin(angle))
    }

    private static func locateCircle(
        context: ScanContext,
        expectedCenter: Point,
        circleSizeMM: Double,
        minimumContrast: Double,
        searchSteps: Int
    ) -> LocatedCircle? {
        var best: LocatedCircle?
        for dx in -searchSteps...searchSteps {
            for dy in -searchSteps...searchSteps {
                let center = Point(
                    x: expectedCenter.x + Double(dx) * 0.5,
                    y: expectedCenter.y + Double(dy) * 0.5
                )
                for scale in [0.9, 1.0, 1.1] {
                    let radius = circleSizeMM / 2 * scale
                    let outside = circleDirections.map {
                        circleSample(context: context, center: center, direction: $0, offset: radius * 1.38)
                    }
                    let contrast = zip(circleDirections, outside).map { direction, paper in
                        let edge = min(
                            circleSample(context: context, center: center, direction: direction, offset: radius * 0.88),
                            circleSample(context: context, center: center, direction: direction, offset: radius)
                        )
                        return paper - edge
                    }
                    let oppositeEdges = (0..<8).map { min(contrast[$0], contrast[$0 + 8]) }
                    let supported = oppositeEdges.filter { $0 >= minimumContrast }
                    guard supported.count >= 5 else { continue }

                    let score = Double(supported.count) + supported.reduce(0) { sum, contrast in
                        sum + min(contrast / minimumContrast, 5) / 12
                    } - hypot(Double(dx), Double(dy)) * 0.06
                    if score > (best?.score ?? 0) {
                        best = LocatedCircle(center: center, radius: radius, background: median(outside), score: score)
                    }
                }
            }
        }
        return best
    }

    private static func circleSample(
        context: ScanContext,
        center: Point,
        direction: Point,
        offset: Double
    ) -> Double {
        samplePage(
            context: context,
            point: Point(x: center.x + direction.x * offset, y: center.y + direction.y * offset),
            radiusMM: 0
        )
    }

    private static func circleHasInteriorInk(
        context: ScanContext,
        circle: LocatedCircle,
        markerMedian: Double
    ) -> Bool {
        let threshold = circle.background - max(16, (circle.background - markerMedian) * 0.20)
        let radius = circle.radius * 0.62
        let divisions = 5
        var dark = 0
        var darkCore = 0
        var sampled = 0

        for row in -divisions...divisions {
            for column in -divisions...divisions {
                guard row * row + column * column <= divisions * divisions else { continue }
                sampled += 1
                let point = Point(
                    x: circle.center.x + radius * Double(column) / Double(divisions),
                    y: circle.center.y + radius * Double(row) / Double(divisions)
                )
                if samplePage(context: context, point: point, radiusMM: 0) < threshold {
                    dark += 1
                    if row * row + column * column <= 9 { darkCore += 1 }
                }
            }
        }
        return darkCore >= 4 && Double(dark) / Double(sampled) >= 0.15
    }

    // MARK: - Sampling and math

    private static func samplePage(
        context: ScanContext,
        point: Point,
        radiusMM: Double
    ) -> Double {
        let imagePoint = applyHomography(point, matrix: context.matrix)
        if radiusMM == 0 {
            let x = min(max(imagePoint.x, 0), Double(context.image.width - 1))
            let y = min(max(imagePoint.y, 0), Double(context.image.height - 1))
            let left = Int(x)
            let top = Int(y)
            let right = min(left + 1, context.image.width - 1)
            let bottom = min(top + 1, context.image.height - 1)
            let fx = x - Double(left)
            let fy = y - Double(top)
            let upper = Double(context.image.pixels[top * context.image.width + left]) * (1 - fx)
                + Double(context.image.pixels[top * context.image.width + right]) * fx
            let lower = Double(context.image.pixels[bottom * context.image.width + left]) * (1 - fx)
                + Double(context.image.pixels[bottom * context.image.width + right]) * fx
            return upper * (1 - fy) + lower * fy
        }
        let right = applyHomography(Point(x: point.x + radiusMM, y: point.y), matrix: context.matrix)
        let down = applyHomography(Point(x: point.x, y: point.y + radiusMM), matrix: context.matrix)
        let radius = max(1, min(distance(imagePoint, right), distance(imagePoint, down)))
        return sample(image: context.image, x: imagePoint.x, y: imagePoint.y, radius: radius)
    }

    private static func sampleMarkerMedian(
        context: ScanContext,
        layout: PhysicalChecklistLayout
    ) -> Double {
        median(layout.markerRectsMM().map { rect in
            samplePage(
                context: context,
                point: Point(x: rect.x + rect.width / 2, y: rect.y + rect.height / 2),
                radiusMM: rect.width * 0.18
            )
        })
    }

    private static func samplePageBackground(
        context: ScanContext,
        layout: PhysicalChecklistLayout
    ) -> Double {
        let size = layout.paper.sizeMM
        let inset = max(3, PhysicalChecklistLayout.marginMM * 0.5)
        let points = [
            Point(x: size.width * 0.25, y: inset),
            Point(x: size.width * 0.50, y: inset),
            Point(x: size.width * 0.75, y: inset),
            Point(x: size.width * 0.25, y: size.height - inset),
            Point(x: size.width * 0.50, y: size.height - inset),
            Point(x: size.width * 0.75, y: size.height - inset),
            Point(x: inset, y: size.height * 0.40),
            Point(x: size.width - inset, y: size.height * 0.60),
        ]
        return median(points.map { samplePage(context: context, point: $0, radiusMM: 1.4) })
    }

    private static func sample(
        image: PhysicalChecklistGrayImage,
        x: Double,
        y: Double,
        radius: Double
    ) -> Double {
        let cx = min(max(Int(x.rounded()), 0), image.width - 1)
        let cy = min(max(Int(y.rounded()), 0), image.height - 1)
        let r = max(1, Int(radius.rounded()))
        var total = 0
        var count = 0
        for py in max(0, cy - r)...min(image.height - 1, cy + r) {
            for px in max(0, cx - r)...min(image.width - 1, cx + r) {
                let dx = px - cx
                let dy = py - cy
                guard dx * dx + dy * dy <= r * r else { continue }
                total += Int(image.pixels[py * image.width + px])
                count += 1
            }
        }
        return count == 0 ? 255 : Double(total) / Double(count)
    }

    private static func otsuThreshold(_ values: [UInt8]) -> Int {
        var histogram = [Int](repeating: 0, count: 256)
        for value in values { histogram[Int(value)] += 1 }
        let total = values.count
        let sum = histogram.enumerated().reduce(0.0) { $0 + Double($1.offset * $1.element) }
        var backgroundWeight = 0
        var backgroundSum = 0.0
        var maximumVariance = -1.0
        var chosen = 127
        for threshold in 0..<256 {
            backgroundWeight += histogram[threshold]
            guard backgroundWeight > 0 else { continue }
            let foregroundWeight = total - backgroundWeight
            guard foregroundWeight > 0 else { break }
            backgroundSum += Double(threshold * histogram[threshold])
            let backgroundMean = backgroundSum / Double(backgroundWeight)
            let foregroundMean = (sum - backgroundSum) / Double(foregroundWeight)
            let variance = Double(backgroundWeight * foregroundWeight) *
                pow(backgroundMean - foregroundMean, 2)
            if variance > maximumVariance {
                maximumVariance = variance
                chosen = threshold
            }
        }
        return chosen
    }

    private static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let middle = sorted.count / 2
        if sorted.count.isMultiple(of: 2) {
            return (sorted[middle - 1] + sorted[middle]) / 2
        }
        return sorted[middle]
    }

    private static func distance(_ lhs: Point, _ rhs: Point) -> Double {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }

    private static func solveHomography(source: [Point], target: [Point]) -> [Double]? {
        guard source.count == 4, target.count == 4 else { return nil }
        var augmented: [[Double]] = []
        for index in 0..<4 {
            let point = source[index]
            let destination = target[index]
            augmented.append([
                point.x, point.y, 1, 0, 0, 0,
                -destination.x * point.x, -destination.x * point.y, destination.x,
            ])
            augmented.append([
                0, 0, 0, point.x, point.y, 1,
                -destination.y * point.x, -destination.y * point.y, destination.y,
            ])
        }
        let count = 8
        for column in 0..<count {
            var pivotRow = column
            for row in (column + 1)..<count where
                abs(augmented[row][column]) > abs(augmented[pivotRow][column]) {
                pivotRow = row
            }
            guard abs(augmented[pivotRow][column]) >= 1e-10 else { return nil }
            if pivotRow != column { augmented.swapAt(pivotRow, column) }
            let pivot = augmented[column][column]
            for valueColumn in column...count { augmented[column][valueColumn] /= pivot }
            for row in 0..<count where row != column {
                let factor = augmented[row][column]
                guard factor != 0 else { continue }
                for valueColumn in column...count {
                    augmented[row][valueColumn] -= factor * augmented[column][valueColumn]
                }
            }
        }
        return augmented.map { $0[count] }
    }

    private static func applyHomography(_ point: Point, matrix: [Double]) -> Point {
        let denominator = matrix[6] * point.x + matrix[7] * point.y + 1
        guard abs(denominator) > 1e-12 else { return Point(x: 0, y: 0) }
        return Point(
            x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
            y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator
        )
    }
}
