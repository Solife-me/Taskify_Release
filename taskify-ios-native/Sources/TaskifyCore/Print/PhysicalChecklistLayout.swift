import Foundation

public enum PhysicalChecklistPaper: String, Codable, CaseIterable, Sendable {
    case letter
    case a4
    case a6

    public var displayName: String {
        switch self {
        case .letter: "Letter"
        case .a4: "A4"
        case .a6: "A6"
        }
    }

    public var sizeMM: (width: Double, height: Double) {
        switch self {
        case .letter: (215.9, 279.4)
        case .a4: (210, 297)
        case .a6: (105, 148)
        }
    }
}

public struct PhysicalChecklistSubtask: Codable, Equatable, Sendable {
    public var title: String
    public var completed: Bool

    public init(title: String, completed: Bool = false) {
        self.title = title
        self.completed = completed
    }

    private enum CodingKeys: String, CodingKey {
        case title, completed
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        completed = try container.decodeIfPresent(Bool.self, forKey: .completed) ?? false
    }
}

public struct PhysicalChecklistItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var section: String?
    public var filled: Bool
    /// The compact line under the title: due date/time and/or the start of the note.
    public var detail: String?
    public var subtasks: [PhysicalChecklistSubtask]
    /// How many photo thumbnails the detailed row reserves space for.
    public var photoCount: Int

    /// Printing only: the thumbnails themselves and where to decrypt them from. Never encoded,
    /// so synced manifests and the saved-job cache stay small.
    public var photos: [Data] = []
    public var photoSources: [String] = []
    public var photoBoardID: String?
    /// Printing only: the board is holding this task back until a future date.
    public var upcoming: Bool = false

    public init(
        id: String,
        title: String,
        section: String? = nil,
        filled: Bool = false,
        detail: String? = nil,
        subtasks: [PhysicalChecklistSubtask] = [],
        photoCount: Int = 0
    ) {
        self.id = id
        self.title = title
        self.section = section
        self.filled = filled
        self.detail = detail
        self.subtasks = subtasks
        self.photoCount = photoCount
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, section, filled, detail, subtasks, photoCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        section = try container.decodeIfPresent(String.self, forKey: .section)
        filled = try container.decodeIfPresent(Bool.self, forKey: .filled) ?? false
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        subtasks = try container.decodeIfPresent([PhysicalChecklistSubtask].self, forKey: .subtasks) ?? []
        photoCount = try container.decodeIfPresent(Int.self, forKey: .photoCount) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encodeIfPresent(section, forKey: .section)
        try container.encode(filled, forKey: .filled)
        try container.encodeIfPresent(detail, forKey: .detail)
        if !subtasks.isEmpty { try container.encode(subtasks, forKey: .subtasks) }
        if photoCount > 0 { try container.encode(photoCount, forKey: .photoCount) }
    }
}

/// What the native print chooser asks for, mirroring the PWA's print options.
public struct PhysicalChecklistPrintOptions: Equatable, Sendable {
    public var includeUpcoming: Bool
    public var includeCompleted: Bool
    public var includeNotes: Bool
    public var includeDue: Bool
    public var includeSubtasks: Bool
    public var includePhotos: Bool

    public init(
        includeUpcoming: Bool = false,
        includeCompleted: Bool = false,
        includeNotes: Bool = false,
        includeDue: Bool = false,
        includeSubtasks: Bool = false,
        includePhotos: Bool = false
    ) {
        self.includeUpcoming = includeUpcoming
        self.includeCompleted = includeCompleted
        self.includeNotes = includeNotes
        self.includeDue = includeDue
        self.includeSubtasks = includeSubtasks
        self.includePhotos = includePhotos
    }

    public static let `default` = PhysicalChecklistPrintOptions()

    public var isDetailed: Bool { includeSubtasks || includePhotos }

    public var layoutVersion: String {
        isDetailed ? BoardPrintContract.detailVersion : BoardPrintContract.version
    }
}

public struct PhysicalChecklistJob: Codable, Equatable, Identifiable, Sendable {
    public enum Format: String, Codable, Sendable {
        case taskList
        case bibleChapters
    }

    public var id: String
    public var ownerID: String
    public var title: String
    public var createdAt: Date
    public var paper: PhysicalChecklistPaper
    public var format: Format
    public var items: [PhysicalChecklistItem]
    /// Optional so jobs saved before detailed sheets still decode; those are all v3.
    public var layoutVersion: String?

    public var effectiveLayoutVersion: String {
        layoutVersion ?? BoardPrintContract.version
    }

    public init(
        id: String = UUID().uuidString,
        ownerID: String,
        title: String,
        createdAt: Date = Date(),
        paper: PhysicalChecklistPaper = .letter,
        format: Format = .taskList,
        items: [PhysicalChecklistItem],
        layoutVersion: String? = BoardPrintContract.version
    ) {
        self.id = id
        self.ownerID = ownerID
        self.title = title
        self.createdAt = createdAt
        self.paper = paper
        self.format = format
        self.items = items
        self.layoutVersion = layoutVersion
    }
}

/// Wire representation stored in the encrypted account backup so any Taskify client can scan
/// the latest sheet printed for a board. Dates use epoch seconds for TypeScript compatibility.
public struct NostrPrintJobManifest: Codable, Equatable, Sendable {
    public var version = 1
    public var layoutVersion: String
    public var id: String
    public var ownerID: String
    public var title: String
    public var createdAt: Int
    public var paper: PhysicalChecklistPaper
    public var format: PhysicalChecklistJob.Format
    public var items: [PhysicalChecklistItem]

    public init(job: PhysicalChecklistJob) {
        layoutVersion = job.effectiveLayoutVersion
        id = job.id
        ownerID = job.ownerID
        title = job.title
        createdAt = Int(job.createdAt.timeIntervalSince1970)
        paper = job.paper
        format = job.format
        items = job.items
    }

    public var job: PhysicalChecklistJob? {
        guard version == 1, BoardPrintContract.isSupportedVersion(layoutVersion),
              !id.isEmpty, !ownerID.isEmpty else { return nil }
        return PhysicalChecklistJob(
            id: id,
            ownerID: ownerID,
            title: title,
            createdAt: Date(timeIntervalSince1970: TimeInterval(createdAt)),
            paper: paper,
            format: format,
            items: items,
            layoutVersion: layoutVersion
        )
    }

    private enum CodingKeys: String, CodingKey {
        case version, layoutVersion, id, ownerID = "ownerId", title, createdAt, paper, format, items
    }

    public static func merged(
        remote: [NostrPrintJobManifest],
        local: [NostrPrintJobManifest],
        limit: Int = 20
    ) -> [NostrPrintJobManifest] {
        var newest: [String: NostrPrintJobManifest] = [:]
        for manifest in remote + local where manifest.version == 1 && !manifest.ownerID.isEmpty {
            guard let current = newest[manifest.ownerID] else {
                newest[manifest.ownerID] = manifest
                continue
            }
            if manifest.createdAt > current.createdAt
                || (manifest.createdAt == current.createdAt && manifest.id > current.id) {
                newest[manifest.ownerID] = manifest
            }
        }
        return Array(newest.values)
            .sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.ownerID < $1.ownerID }
            .prefix(limit)
            .map { $0 }
    }
}

/// Device-local cache for the most recent printable manifest per logical owner.
///
/// The cache lives in TaskifyCore because both the iOS and macOS app targets use the
/// shared `AppModel` account-backup integration, while their presentation sources differ.
public enum PhysicalChecklistJobStore {
    private static let key = "taskify.physical-checklist.latest-jobs.v1"

    public static func save(_ job: PhysicalChecklistJob, defaults: UserDefaults = .standard) {
        var jobs = loadAll(defaults: defaults)
        jobs[job.ownerID] = job
        persist(jobs, defaults: defaults)
    }

    public static func load(
        ownerID: String,
        defaults: UserDefaults = .standard
    ) -> PhysicalChecklistJob? {
        loadAll(defaults: defaults)[ownerID]
    }

    public static func loadAll(defaults: UserDefaults = .standard) -> [String: PhysicalChecklistJob] {
        guard let data = defaults.data(forKey: key),
              let jobs = try? JSONDecoder().decode([String: PhysicalChecklistJob].self, from: data) else {
            return [:]
        }
        return jobs
    }

    public static func merge(
        _ manifests: [NostrPrintJobManifest],
        defaults: UserDefaults = .standard
    ) {
        var jobs = loadAll(defaults: defaults)
        for manifest in manifests {
            guard let job = manifest.job else { continue }
            if let current = jobs[job.ownerID], current.createdAt > job.createdAt { continue }
            jobs[job.ownerID] = job
        }
        persist(jobs, defaults: defaults)
    }

    private static func persist(
        _ jobs: [String: PhysicalChecklistJob],
        defaults: UserDefaults
    ) {
        guard let data = try? JSONEncoder().encode(jobs) else { return }
        defaults.set(data, forKey: key)
    }
}

public struct PhysicalChecklistRow: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case section(String)
        case item(PhysicalChecklistItem)
    }

    public var kind: Kind
    public var xMM: Double
    public var yMM: Double
    public var widthMM: Double
    public var heightMM: Double
    public var titleBandMM: Double
    public var circleCenterMM: (x: Double, y: Double)?

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.kind == rhs.kind && lhs.xMM == rhs.xMM && lhs.yMM == rhs.yMM &&
            lhs.widthMM == rhs.widthMM && lhs.heightMM == rhs.heightMM &&
            lhs.titleBandMM == rhs.titleBandMM &&
            lhs.circleCenterMM?.x == rhs.circleCenterMM?.x &&
            lhs.circleCenterMM?.y == rhs.circleCenterMM?.y
    }
}

public struct PhysicalChecklistPage: Equatable, Sendable {
    public var index: Int
    public var rows: [PhysicalChecklistRow]
}

public struct PhysicalChecklistLayout: Equatable, Sendable {
    public static let version = BoardPrintContract.version
    public static let marginMM = BoardPrintContract.baseMarginMM
    public static let markerSizeMM = BoardPrintContract.markerSizeMM
    public static let circleSizeMM = BoardPrintContract.circleSizeMM
    public static let rowHeightMM = BoardPrintContract.rowHeightMM
    public static let pageIDBitCount = BoardPrintContract.pageIDBits
    public static let pageIDSizeMM = BoardPrintContract.pageIDMarkerSizeMM
    public static let pageIDGapMM = BoardPrintContract.pageIDMarkerGapMM

    public static let detailLineMM = 3.4
    public static let subtaskLineMM = 3.6
    public static let subtaskMax = 6
    public static let photoSizeMM = 13.0
    public static let photoMax = 3
    private static let photoBlockMM = photoSizeMM + 2

    public var layoutVersion: String
    public var detailed: Bool
    public var paper: PhysicalChecklistPaper
    public var pages: [PhysicalChecklistPage]
    public var headerTopMM: Double
    public var contentTopMM: Double
    public var circleSizeMM: Double

    public static func build(job: PhysicalChecklistJob) -> Self {
        let size = job.paper.sizeMM
        let leftMargin = marginMM + (job.paper == .a6 ? 4 : 0)
        let headerTop = marginMM + markerSizeMM + BoardPrintContract.markerGapMM
        let contentTop = headerTop + BoardPrintContract.headerHeightMM + BoardPrintContract.headerGapMM
        let contentHeight = size.height - marginMM - contentTop
        let compact = job.format == .bibleChapters
        let detailed = !compact && job.effectiveLayoutVersion == BoardPrintContract.detailVersion
        let rowHeight = compact ? 5.5 : rowHeightMM
        let circleSize = compact ? 3.4 : circleSizeMM
        let columnCount = compact ? (job.paper == .a6 ? 2 : 3) : 1
        let columnGap = compact ? 4.0 : 0
        let rowsPerColumn = max(1, Int(floor(contentHeight / rowHeight)))
        let rowsPerPage = rowsPerColumn * columnCount
        let availableWidth = size.width - leftMargin - marginMM
        let width = (availableWidth - Double(columnCount - 1) * columnGap) / Double(columnCount)

        var logicalRows: [PhysicalChecklistRow.Kind] = []
        var activeSection: String?
        for item in job.items {
            let section = item.section?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let section, !section.isEmpty, section != activeSection {
                logicalRows.append(.section(section))
                activeSection = section
            } else if section == nil || section?.isEmpty == true {
                activeSection = nil
            }
            logicalRows.append(.item(item))
        }

        func itemHeight(_ item: PhysicalChecklistItem) -> Double {
            guard detailed else { return rowHeight }
            let subtaskCount = item.subtasks.filter {
                !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }.count
            let subtaskLines = min(subtaskCount, subtaskMax) + (subtaskCount > subtaskMax ? 1 : 0)
            let hasDetail = !(item.detail ?? "").isEmpty
            let extra =
                (hasDetail ? detailLineMM : 0) +
                Double(subtaskLines) * subtaskLineMM +
                (item.photoCount > 0 ? photoBlockMM : 0)
            return rowHeight + extra + (extra > 0 ? 1 : 0)
        }

        func heightForRow(_ kind: PhysicalChecklistRow.Kind) -> Double {
            switch kind {
            case .section: rowHeight
            case let .item(item): itemHeight(item)
            }
        }

        var slots: [(pageIndex: Int, yMM: Double, heightMM: Double)] = []
        if detailed {
            var pageIndex = 0
            var usedMM = 0.0
            for kind in logicalRows {
                let height = heightForRow(kind)
                if usedMM > 0, usedMM + height > contentHeight {
                    pageIndex += 1
                    usedMM = 0
                }
                slots.append((pageIndex, contentTop + usedMM, height))
                usedMM += height
            }
        } else {
            for (index, _) in logicalRows.enumerated() {
                slots.append((
                    index / rowsPerPage,
                    contentTop + Double(index % rowsPerPage) * rowHeight,
                    rowHeight
                ))
            }
        }

        let pageCount = detailed
            ? max(1, (slots.map(\.pageIndex).max() ?? 0) + 1)
            : max(1, Int(ceil(Double(logicalRows.count) / Double(rowsPerPage))))
        var pages = (0..<pageCount).map { PhysicalChecklistPage(index: $0, rows: []) }
        for (index, kind) in logicalRows.enumerated() {
            guard slots.indices.contains(index) else { continue }
            let slot = slots[index]
            guard pages.indices.contains(slot.pageIndex) else { continue }
            let x: Double
            if detailed {
                x = leftMargin
            } else {
                let indexInPage = index % rowsPerPage
                let columnIndex = indexInPage / rowsPerColumn
                x = leftMargin + Double(columnIndex) * (width + columnGap)
            }
            let y = slot.yMM
            let center: (x: Double, y: Double)?
            switch kind {
            case .section:
                center = nil
            case .item:
                center = (x + circleSize / 2, y + rowHeight / 2)
            }
            pages[slot.pageIndex].rows.append(PhysicalChecklistRow(
                kind: kind,
                xMM: x,
                yMM: y,
                widthMM: width,
                heightMM: slot.heightMM,
                titleBandMM: rowHeight,
                circleCenterMM: center
            ))
        }

        return Self(
            layoutVersion: job.effectiveLayoutVersion,
            detailed: detailed,
            paper: job.paper,
            pages: pages,
            headerTopMM: headerTop,
            contentTopMM: contentTop,
            circleSizeMM: circleSize
        )
    }

    public func pageIDBitCentersMM() -> [(x: Double, y: Double)] {
        let size = paper.sizeMM
        let totalWidth = Double(Self.pageIDBitCount) * Self.pageIDSizeMM +
            Double(Self.pageIDBitCount - 1) * Self.pageIDGapMM
        let originX = size.width - Self.marginMM - totalWidth
        return (0..<Self.pageIDBitCount).map { bit in
            (
                originX + Double(bit) * (Self.pageIDSizeMM + Self.pageIDGapMM) + Self.pageIDSizeMM / 2,
                headerTopMM + 0.4 + Self.pageIDSizeMM / 2
            )
        }
    }

    public func jobCodeBitCentersMM(jobID: String) -> [(x: Double, y: Double)] {
        let size = paper.sizeMM
        let totalWidth = Double(BoardPrintContract.jobCodeBits) * BoardPrintContract.jobCodeMarkerSizeMM +
            Double(BoardPrintContract.jobCodeBits - 1) * BoardPrintContract.jobCodeMarkerGapMM
        let originX = size.width - Self.marginMM - totalWidth
        let originY = headerTopMM + 0.4 + Self.pageIDSizeMM + 0.6
        return (0..<BoardPrintContract.jobCodeBits).map { bit in
            (
                originX + Double(bit) * (BoardPrintContract.jobCodeMarkerSizeMM + BoardPrintContract.jobCodeMarkerGapMM) +
                    BoardPrintContract.jobCodeMarkerSizeMM / 2,
                originY + BoardPrintContract.jobCodeMarkerSizeMM / 2
            )
        }
    }

    public func markerRectsMM() -> [(x: Double, y: Double, width: Double, height: Double)] {
        let size = paper.sizeMM
        return [
            (Self.marginMM, Self.marginMM, Self.markerSizeMM, Self.markerSizeMM),
            (size.width - Self.marginMM - Self.markerSizeMM, Self.marginMM, Self.markerSizeMM, Self.markerSizeMM),
            (Self.marginMM, size.height - Self.marginMM - Self.markerSizeMM, Self.markerSizeMM, Self.markerSizeMM),
            (size.width - Self.marginMM - Self.markerSizeMM, size.height - Self.marginMM - Self.markerSizeMM, Self.markerSizeMM, Self.markerSizeMM),
        ]
    }
}
