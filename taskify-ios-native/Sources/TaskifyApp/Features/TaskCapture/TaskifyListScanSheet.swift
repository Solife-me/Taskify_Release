import AppIntents
import AVFoundation
import CoreImage
import PhotosUI
import SwiftUI
import TaskifyCore
import VisionKit

struct TaskifyScanListIntent: AppIntent {
    static var title: LocalizedStringResource = "Scan List"
    static var description = IntentDescription("Opens Taskify’s camera to scan a handwritten list or a printed Taskify checklist.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        TaskifyListScanRouter.shared.open()
        return .result()
    }
}

struct TaskifyListScanRequest: Identifiable {
    let id = UUID()
    let boardID: String?
    let columnID: String?
}

@MainActor
@Observable
final class TaskifyListScanRouter {
    static let shared = TaskifyListScanRouter()
    var request: TaskifyListScanRequest?

    func open(boardID: String? = nil, columnID: String? = nil) {
        request = TaskifyListScanRequest(boardID: boardID, columnID: columnID)
    }
}

struct TaskifyListScanSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var showingCamera = false
    @State private var photo: PhotosPickerItem?
    @State private var analyzing = false
    @State private var rows: [ScannedTaskList.Row] = []
    @State private var unmatchedRows: [ScannedTaskList.Row] = []
    @State private var unmatchedPages = 0
    @State private var matchedPages = 0
    @State private var markedIDs: [String] = []
    @State private var selectedIDs: Set<String> = []
    @State private var destination: Destination?
    @State private var message: String?
    @State private var reviewMessage: String?

    let request: TaskifyListScanRequest

    private struct Destination: Hashable {
        let boardID: String
        let columnID: String
    }

    private var cameraAvailable: Bool {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        return VNDocumentCameraViewController.isSupported && status != .denied && status != .restricted
    }

    private var boards: [Board] {
        TaskifyAddTaskDestination.namedBoards(in: model.tasksSnapshot)
            .filter { ($0.kind == .week || $0.kind == .list) && !$0.columns.isEmpty }
    }

    private var completionTasks: [TaskItem] {
        markedIDs.compactMap(model.task(withID:)).filter { !$0.completed && !$0.isDeleted }
    }

    private var completionIDs: [String] {
        completionTasks.map(\.id).filter(selectedIDs.contains)
    }

    var body: some View {
        NavigationStack {
            Form {
                if analyzing {
                    ProgressView("Reading list…")
                } else {
                    if let message {
                        Text(message).foregroundStyle(.secondary)
                    }
                    if let reviewMessage {
                        Text(reviewMessage).foregroundStyle(.secondary)
                    }
                    if unmatchedPages > 0 {
                        unmatchedPrintSection
                    }
                    if matchedPages > 0 {
                        completionSection
                    }
                    if !rows.isEmpty {
                        importSections
                    }
                    Section {
                        if cameraAvailable {
                            Button("Scan with Camera", systemImage: "document.viewfinder") {
                                showingCamera = true
                            }
                        }
                        PhotosPicker(selection: $photo, matching: .images) {
                            Label("Choose Photo", systemImage: "photo")
                        }
                    }
                }
            }
            .navigationTitle("Scan List")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .fullScreenCover(isPresented: $showingCamera) {
                TaskAttachmentDocumentScanner(
                    onScan: { images in
                        showingCamera = false
                        read(images)
                    },
                    onCancel: { showingCamera = false },
                    onError: { _ in
                        showingCamera = false
                        message = "Couldn’t open the scanner. Try again or choose a photo."
                    }
                )
                .ignoresSafeArea()
            }
            .task {
                chooseInitialDestination()
                if cameraAvailable {
                    showingCamera = true
                } else {
                    message = "Choose a photo of your list to scan."
                }
            }
            .task(id: photo) {
                guard let photo else { return }
                guard let data = try? await photo.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else {
                    if !Task.isCancelled { message = "Couldn’t read this photo." }
                    return
                }
                guard !Task.isCancelled else { return }
                read([image])
            }
        }
    }

    private var unmatchedPrintSection: some View {
        Section("Unmatched Taskify Checklist") {
            Text("Taskify couldn’t find a saved print job for this checklist. You can rescan the full page or review its text as new tasks.")
                .foregroundStyle(.secondary)
            if !unmatchedRows.isEmpty {
                Button("Review as New Tasks") {
                    rows += unmatchedRows
                    unmatchedRows = []
                    unmatchedPages = 0
                }
            }
        }
    }

    private var completionSection: some View {
        Section("Checklist Marks") {
            if completionTasks.isEmpty {
                Text("No marks matched an incomplete task. If a mark was missed, rescan with the full page visible.")
                    .foregroundStyle(.secondary)
            }
            ForEach(completionTasks) { task in
                Toggle(isOn: Binding(
                    get: { selectedIDs.contains(task.id) },
                    set: { isSelected in
                        if isSelected { selectedIDs.insert(task.id) } else { selectedIDs.remove(task.id) }
                    }
                )) {
                    VStack(alignment: .leading) {
                        Text(task.title)
                        if let board = model.board(withID: task.boardID) {
                            Text(board.name).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !completionTasks.isEmpty {
                Button("Complete \(completionIDs.count) Tasks") {
                    let ids = completionIDs
                    model.completeTasks(ids)
                    matchedPages = 0
                    markedIDs = []
                    selectedIDs = []
                    finish("Completed \(ids.count) tasks.")
                }
                .disabled(completionIDs.isEmpty)
            }
        }
    }

    private var importSections: some View {
        let drafts = ScannedTaskList.drafts(from: rows)
        return Group {
            Section("Add To") {
                Picker("Board", selection: Binding(
                    get: { destination?.boardID },
                    set: { boardID in
                        destination = boards.first { $0.id == boardID }.flatMap(defaultDestination)
                    }
                )) {
                    if destination == nil { Text("Choose a board").tag(nil as String?) }
                    ForEach(boards) { board in
                        Text(board.name).tag(Optional(board.id))
                    }
                }
                if let destination, let board = boards.first(where: { $0.id == destination.boardID }) {
                    Picker(board.kind == .week ? "Day" : "List", selection: Binding(
                        get: { destination.columnID },
                        set: { self.destination = Destination(boardID: board.id, columnID: $0) }
                    )) {
                        ForEach(board.columns.sorted { $0.order < $1.order }) { column in
                            Text(column.name).tag(column.id)
                        }
                    }
                }
            }
            Section("New Tasks") {
                ForEach($rows) { $row in
                    let rowID = row.id
                    HStack {
                        if row.isSubtask {
                            Image(systemName: "arrow.turn.down.right").foregroundStyle(.secondary)
                        }
                        TextField(row.isSubtask ? "Subtask" : "Task", text: $row.title, axis: .vertical)
                        if row.needsReview {
                            Image(systemName: "exclamationmark.circle")
                                .foregroundStyle(.orange)
                                .accessibilityLabel("Check this transcription")
                        }
                        Menu {
                            if row.isSubtask || rows.first?.id != rowID {
                                Button(row.isSubtask ? "Make Task" : "Make Subtask") {
                                    row.isSubtask.toggle()
                                }
                            }
                            Button("Remove", role: .destructive) {
                                rows.removeAll { $0.id == rowID }
                                if !rows.isEmpty { rows[0].isSubtask = false }
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .accessibilityLabel("Options for \(row.title)")
                    }
                }
                Button("Add \(drafts.count) Tasks") { add(drafts) }
                    .disabled(drafts.isEmpty || destination == nil)
            }
        }
    }

    private func chooseInitialDestination() {
        guard destination == nil else { return }
        if let board = boards.first(where: { $0.id == request.boardID }),
           let column = board.columns.first(where: { $0.id == request.columnID }) {
            destination = Destination(boardID: board.id, columnID: column.id)
        } else if let target = TaskifyAddTaskDestination.resolve(
            in: model.tasksSnapshot, requestedBoardName: nil
        ), let columnID = target.columnID {
            destination = Destination(boardID: target.boardID, columnID: columnID)
        }
    }

    private func defaultDestination(for board: Board) -> Destination? {
        guard let target = TaskifyAddTaskDestination.resolve(
            in: model.tasksSnapshot, requestedBoardID: board.id
        ), let column = target.columnID else { return nil }
        return Destination(boardID: board.id, columnID: column)
    }

    private func add(_ drafts: [ScannedTaskList.Draft]) {
        guard let destination,
              let board = boards.first(where: { $0.id == destination.boardID }),
              board.columns.contains(where: { $0.id == destination.columnID }) else {
            message = "Choose an available board and list."
            return
        }
        let dueDate = (board.kind == .week ? WeekdayColumn(rawValue: destination.columnID) : nil).map {
            WeekDateResolver.date(for: $0, inWeekContaining: Date(), weekStartsOn: model.weekStart)
        }
        let orderedDrafts = model.newTaskPosition == .top ? Array(drafts.reversed()) : drafts
        var createdIDs = Set<String>()
        for draft in orderedDrafts {
            let task = model.addDetailedTask(
                id: draft.id, title: draft.title, note: "", boardID: board.id,
                columnID: destination.columnID, dueDate: dueDate, dueDateEnabled: dueDate != nil,
                dueTimeEnabled: false, dueTimeZone: nil, urgent: false, priority: nil,
                subtasks: draft.subtasks, recurrence: nil, reminders: [], reminderTime: nil,
                images: [], documents: []
            )
            if task != nil { createdIDs.insert(draft.id) }
        }
        if createdIDs.count == drafts.count {
            rows = []
            finish("Added \(createdIDs.count) tasks.")
        } else {
            // Keep only the tasks that still need saving, including their own subtasks.
            var parentID: String?
            rows = rows.filter { row in
                guard !row.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
                if !row.isSubtask || parentID == nil { parentID = row.id }
                return !createdIDs.contains(parentID ?? row.id)
            }
            message = "Added \(createdIDs.count) of \(drafts.count) tasks. Check the destination and try the remaining tasks again."
        }
    }

    private func finish(_ summary: String) {
        if rows.isEmpty && matchedPages == 0 && unmatchedPages == 0 {
            dismiss()
        } else {
            reviewMessage = summary
        }
    }

    private func read(_ images: [UIImage]) {
        let pages = images.compactMap(PhysicalChecklistCapturedPage.init)
        guard !analyzing, !pages.isEmpty else { return }
        let manifests = Array(PhysicalChecklistJobStore.loadAll(defaults: model.accountDefaults).values)
        analyzing = true
        message = nil
        reviewMessage = nil

        Task {
            let result = await Task.detached(priority: .userInitiated) {
                TaskifyListScanResult.read(pages, manifests: manifests)
            }.value
            rows = result.rows
            unmatchedRows = result.unmatchedRows
            unmatchedPages = result.unmatchedPages
            matchedPages = result.matchedPages
            markedIDs = result.markedIDs
            selectedIDs = Set(result.markedIDs)
            if result.skippedPages > 0 {
                message = "No tasks could be read on \(result.skippedPages) page(s). Try scanning again in even light."
            }
            if result.biblePages > 0 {
                reviewMessage = "To apply marks from a Bible checklist, scan it from the Bible tracker."
            }
            analyzing = false
        }
    }
}

private struct TaskifyListScanResult: Sendable {
    var rows: [ScannedTaskList.Row] = []
    var unmatchedRows: [ScannedTaskList.Row] = []
    var matchedPages = 0
    var unmatchedPages = 0
    var skippedPages = 0
    var biblePages = 0
    var markedIDs: [String] = []

    static func read(
        _ pages: [PhysicalChecklistCapturedPage],
        manifests: [PhysicalChecklistJob]
    ) -> Self {
        let context = CIContext()
        var result = Self()
        var markedIDs = Set<String>()
        for page in pages {
            let lines = page.readText()
            let header = ScannedTaskList.printSubtitle(in: lines)
            let gray = page.grayImage(using: context)
            let hasMarkers = gray.map { PhysicalChecklistScanEngine.hasPrintedMarkers(image: $0) } ?? false
            let token = ScannedTaskList.printID(in: lines)
            guard header != nil || hasMarkers else {
                let recognized = ScannedTaskList.rows(from: page.readHandwriting(using: context))
                result.rows += recognized
                if recognized.isEmpty { result.skippedPages += 1 }
                continue
            }

            let matches: [PhysicalChecklistJob]
            if let token {
                matches = manifests.filter { $0.id.prefix(8).lowercased() == token }
            } else if hasMarkers, let gray {
                let titles = Set(lines.filter { $0.y < 0.20 }.map {
                    $0.text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                })
                matches = manifests.filter {
                    let title = $0.title.lowercased()
                    return (titles.contains(title) || titles.contains("\(title) print")) &&
                        PhysicalChecklistScanEngine.hasMatchingPrintCode(image: gray, job: $0)
                }
            } else {
                matches = []
            }
            if matches.count == 1, let job = matches.first, let gray {
                if job.format == .bibleChapters {
                    result.biblePages += 1
                } else {
                    let marks = PhysicalChecklistScanEngine.scanBoardPage(image: gray, lines: lines, catalog: job)
                    result.matchedPages += 1
                    result.markedIDs += job.items.map(\.id).filter { id in
                        marks.detectedIDs.contains(id) && markedIDs.insert(id).inserted
                    }
                }
            } else {
                result.unmatchedPages += 1
                let body = header.map { header in lines.filter { $0.y > header.y + header.height / 2 } } ?? lines
                result.unmatchedRows += ScannedTaskList.rows(from: body)
            }
        }
        return result
    }
}
