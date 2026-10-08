import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

enum SharedInboxFilterTab: String, CaseIterable {
    case new = "New"
    case replied = "Replied"
}

struct SharedTaskInboxSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var selectedTab: SharedInboxFilterTab = .new

    private var visibleItems: [SharedInboxItem] {
        model.sharedInboxItems.filter { $0.status != .deleted }
    }

    private var filteredItems: [SharedInboxItem] {
        visibleItems.filter { item in
            switch selectedTab {
            case .new: item.status == .pending
            case .replied: item.status != .pending
            }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if filteredItems.isEmpty {
                    ContentUnavailableView(
                        selectedTab == .new ? "No new invitations" : "No replied invitations",
                        systemImage: "tray",
                        description: Text("Tasks and assignments sent to your Nostr identity will appear here.")
                    )
                    .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            if selectedTab == .new {
                                Label(
                                    "Choose a board and list when adding a task",
                                    systemImage: "arrow.down.app"
                                )
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                            }

                            ForEach(filteredItems) { item in
                                SharedTaskInboxCard(item: item)
                            }
                        }
                        .padding(18)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .frame(width: 32, height: 32)
                            .background(TaskifyTheme.raisedFill, in: Circle())
                    }
                    .accessibilityLabel("Close")
                }
                ToolbarItem(placement: .principal) {
                    Picker("Filter", selection: $selectedTab) {
                        ForEach(SharedInboxFilterTab.allCases, id: \.self) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }
}

struct SharedTaskInboxCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedInboxItem
    @State private var showDestination = false

    private var detailCount: Int {
        (item.task.subtasks?.count ?? 0) + (item.task.documents?.count ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Label(
                    item.task.isAssignment ? "ASSIGNMENT" : "SHARED TASK",
                    systemImage: item.task.isAssignment ? "person.crop.circle.badge.checkmark" : "paperplane.fill"
                )
                .font(.system(size: 10, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(TaskifyTheme.accent)

                Spacer()

                Text(item.receivedAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(item.task.title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text("From \(item.sender.displayName)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if let note = item.task.note, !note.isEmpty {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
            }

            HStack(spacing: 12) {
                if let dueDate = item.task.dueDate {
                    Label(
                        dueDate.formatted(
                            date: .abbreviated,
                            time: item.task.dueTimeEnabled == true ? .shortened : .omitted
                        ),
                        systemImage: "calendar"
                    )
                }
                if let priority = item.task.priority.flatMap(TaskPriority.init(rawValue:)) {
                    Label(priority.cardLabel, systemImage: "exclamationmark")
                        .foregroundStyle(priority.cardColor)
                }
                if detailCount > 0 {
                    Label("\(detailCount)", systemImage: "paperclip")
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(TaskifyTheme.tertiaryText)

            if item.status == .pending {
                pendingActions
            } else {
                HStack {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                    Spacer()
                    Button("Remove") {
                        withAnimation(.snappy) {
                            model.dismissSharedInboxItem(item.id)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
        }
        .padding(15)
        .taskifyGlass(cornerRadius: 19)
        .sheet(isPresented: $showDestination) {
            SharedTaskDestinationSheet(item: item)
        }
    }

    @ViewBuilder
    private var pendingActions: some View {
        if item.task.isAssignment {
            HStack(spacing: 9) {
                responseButton("Decline", status: .declined, tint: .red)
                responseButton("Maybe", status: .tentative, tint: .orange)
                responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
            }
        } else {
            HStack(spacing: 9) {
                Button {
                    withAnimation(.snappy) {
                        model.dismissSharedInboxItem(item.id)
                    }
                } label: {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                }
                .buttonStyle(.bordered)

                responseButton("Add Task", status: .accepted, tint: TaskifyTheme.accent)
            }
        }
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            if status == .accepted {
                showDestination = true
                return
            }
            withAnimation(.snappy) {
                _ = model.respondToSharedInboxItem(item.id, status: status)
            }
        } label: {
            Text(title)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
    }

    private var statusLabel: String {
        switch item.status {
        case .pending: "Pending"
        case .accepted: "Accepted"
        case .declined: "Declined"
        case .tentative: "Maybe"
        case .deleted: "Removed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .pending: "clock"
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .pending: TaskifyTheme.secondaryText
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .deleted: TaskifyTheme.tertiaryText
        }
    }
}

struct BoardSortOptionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let sortMode: UpcomingSortMode
    let sortDirection: UpcomingSortDirection
    let onSelectSort: (UpcomingSortMode) -> Void

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("SORT TASKS BY")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1)
                        .foregroundStyle(TaskifyTheme.tertiaryText)

                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(UpcomingSortMode.allCases, id: \.rawValue) { mode in
                            Button {
                                onSelectSort(mode)
                            } label: {
                                HStack(spacing: 7) {
                                    Text(mode.label)
                                    if sortMode == mode, mode.supportsDirection {
                                        Image(systemName: sortDirection == .ascending ? "arrow.up" : "arrow.down")
                                    }
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(sortMode == mode ? .white : TaskifyTheme.secondaryText)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .background(
                                    sortMode == mode ? TaskifyTheme.accent : TaskifyTheme.raisedFill,
                                    in: Capsule()
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(18)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Sort Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct BoardUpcomingView: View {
    @Environment(AppModel.self) private var model
    let board: Board

    var body: some View {
        let rows = model.boardUpcomingRows(for: board)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 9) {
                Label("Upcoming", systemImage: "calendar")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .padding(.bottom, 7)

                if rows.isEmpty {
                    Text("No upcoming items on this board.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    ForEach(rows) { row in
                        switch row {
                        case .header(let date):
                            Text(dayLabel(date).uppercased())
                                .font(.system(size: 12, weight: .bold))
                                .tracking(0.6)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                                .padding(.top, row.id == rows.first?.id ? 0 : 9)
                        case .event(_, let event):
                            TaskifyEventCard(event: event)
                        case .task(_, let task):
                            TaskCardView(task: task)
                        }
                    }
                }
            }
            .padding(16)
            .taskifyGlass(cornerRadius: 22)
            .padding(.horizontal, 18)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    private func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}

struct BoardCompletedView: View {
    @Environment(AppModel.self) private var model
    let board: Board
    let onClear: () -> Void

    var body: some View {
        let tasks = model.boardCompletedTasks(for: board)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Label("Completed", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)

                    Spacer()

                    if !tasks.isEmpty, board.clearCompletedDisabled == false {
                        Button("Clear", role: .destructive, action: onClear)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.red)
                            .buttonStyle(.plain)
                    }
                }

                if tasks.isEmpty {
                    Text("No completed tasks yet.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                } else {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(tasks) { task in
                            BoardCompletedTaskEntry(task: task)
                        }
                    }
                }
            }
            .padding(16)
            .taskifyGlass(cornerRadius: 22)
            .padding(.horizontal, 18)
            .padding(.bottom, 12)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }
}

struct BoardCompletedTaskEntry: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem
    @State private var confirmingRecurringDeletion = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            TaskCardView(task: task)

            HStack(spacing: 8) {
                Text(completionLabel)
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .lineLimit(1)

                Spacer(minLength: 4)

                Button {
                    withAnimation(.snappy) {
                        model.toggleCompletion(task.id)
                    }
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.green)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(Color.green.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)

                Button(role: .destructive) {
                    if task.recurrence?.isActive == true {
                        confirmingRecurringDeletion = true
                    } else {
                        model.deleteTask(task.id, scope: .single)
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.red)
                        .frame(width: 32, height: 32)
                        .background(Color.red.opacity(0.12), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Delete \(task.title)")
            }
            .padding(.horizontal, 6)
        }
        .confirmationDialog(
            "Delete recurring task?",
            isPresented: $confirmingRecurringDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete This Task", role: .destructive) {
                model.deleteTask(task.id, scope: .single)
            }
            Button("Delete This and Future Tasks", role: .destructive) {
                model.deleteTask(task.id, scope: .thisAndFuture)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Choose whether to delete only this occurrence or end the recurring series here.")
        }
    }

    private var completionLabel: String {
        guard let completedAt = task.completedAt else { return "Completed item" }
        return "Completed \(completedAt.formatted(date: .abbreviated, time: .shortened))"
    }
}

/// PWA-familiar board entry point: create a fresh board or join an existing share without
/// detouring through Settings. Board management remains in Settings after the board is added.
struct BoardAddSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var boardName = ""
    @State private var boardKind: BoardKind = .list
    @State private var selectedChildBoardIDs: Set<String> = []
    @State private var shareText = ""
    @State private var customSharedName = ""
    @State private var statusMessage: String?
    @State private var statusIsError = false
    @State private var showingScanner = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case boardName
        case share
    }

    private var trimmedBoardName: String {
        boardName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedShareText: String {
        shareText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var availableCompoundChildren: [Board] {
        model.visibleBoards.filter { $0.kind == .list }
    }

    private var decodedShare: BoardSharePayload? {
        BoardShareContract.decode(trimmedShareText)
    }

    private var canCreate: Bool {
        !trimmedBoardName.isEmpty && (boardKind != .compound || !selectedChildBoardIDs.isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    createCard
                    joinCard
                }
                .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Add Board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingScanner) {
            BoardQRJoinFlow(onJoined: {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            })
            .environment(model)
        }
    }

    private var createCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            cardTitle(
                "Create board",
                subtitle: "Start fresh. New boards sync through Nostr and can be shared anytime.",
                systemImage: "square.grid.2x2.fill"
            )

            TextField("New board name", text: $boardName)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .focused($focusedField, equals: .boardName)
                .onSubmit(createBoard)
                .padding(.horizontal, 15)
                .frame(height: 50)
                .background(
                    TaskifyTheme.raisedFill,
                    in: RoundedRectangle(cornerRadius: 17, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 7) {
                Text("BOARD TYPE")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                Picker("Board type", selection: $boardKind) {
                    Text("Weekly").tag(BoardKind.week)
                    Text("Lists").tag(BoardKind.list)
                    Text("Compound").tag(BoardKind.compound)
                }
                .pickerStyle(.segmented)
            }

            if boardKind == .compound {
                compoundBoardPicker
            }

            Button(action: createBoard) {
                Label("Create board", systemImage: "plus")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canCreate)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var compoundBoardPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LINKED LIST BOARDS")
                .font(.system(size: 10, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            if availableCompoundChildren.isEmpty {
                Text("Create a list board before creating a compound board.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            } else {
                ForEach(availableCompoundChildren) { board in
                    Button {
                        if selectedChildBoardIDs.contains(board.id) {
                            selectedChildBoardIDs.remove(board.id)
                        } else {
                            selectedChildBoardIDs.insert(board.id)
                        }
                    } label: {
                        HStack(spacing: 11) {
                            Image(
                                systemName: selectedChildBoardIDs.contains(board.id)
                                    ? "checkmark.circle.fill"
                                    : "circle"
                            )
                            .foregroundStyle(
                                selectedChildBoardIDs.contains(board.id)
                                    ? TaskifyTheme.accent
                                    : TaskifyTheme.secondaryText
                            )
                            Text(board.name)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Spacer()
                            Text("\(board.columns.count) lists")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 44)
                        .background(
                            TaskifyTheme.raisedFill,
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var joinCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            cardTitle(
                "Join board",
                subtitle: "Paste a Taskify board ID or share, or scan its QR code.",
                systemImage: "person.2.badge.plus"
            )

            TextField("Board ID or Taskify share", text: $shareText, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(.callout, design: .monospaced))
                .lineLimit(2...5)
                .submitLabel(.go)
                .focused($focusedField, equals: .share)
                .onSubmit(joinBoard)
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .frame(minHeight: 50)
                .background(
                    TaskifyTheme.raisedFill,
                    in: RoundedRectangle(cornerRadius: 17, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )
                .onChange(of: shareText) { _, _ in
                    statusMessage = nil
                    statusIsError = false
                }

            HStack(spacing: 10) {
                Button(action: pasteBoardShare) {
                    Label("Paste", systemImage: "doc.on.clipboard")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)

                Button {
                    focusedField = nil
                    showingScanner = true
                } label: {
                    Label("Scan QR", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)
            }

            if let decodedShare {
                sharePreview(decodedShare)
            }

            TextField("Board name (optional)", text: $customSharedName)
                .textInputAutocapitalization(.words)
                .padding(.horizontal, 15)
                .frame(height: 48)
                .background(
                    TaskifyTheme.raisedFill,
                    in: RoundedRectangle(cornerRadius: 17, style: .continuous)
                )

            if let statusMessage {
                Label(
                    statusMessage,
                    systemImage: statusIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
                )
                .font(.caption)
                .foregroundStyle(statusIsError ? Color.orange : Color.green)
            }

            Button(action: joinBoard) {
                Label("Join board", systemImage: "person.2.badge.plus")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.borderedProminent)
            .disabled(trimmedShareText.isEmpty || decodedShare == nil)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func cardTitle(_ title: String, subtitle: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
    }

    private func sharePreview(_ share: BoardSharePayload) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(share.boardName ?? "Shared Board", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
            Text(share.boardID)
                .font(.caption2.monospaced())
                .foregroundStyle(TaskifyTheme.secondaryText)
                .lineLimit(1)
            if !share.relayURLs.isEmpty {
                Text("\(share.relayURLs.count) relay\(share.relayURLs.count == 1 ? "" : "s") included")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(
            TaskifyTheme.raisedFill,
            in: RoundedRectangle(cornerRadius: 15, style: .continuous)
        )
    }

    private func createBoard() {
        guard canCreate else { return }
        let created: Bool
        switch boardKind {
        case .week:
            created = model.createWeekBoard(name: trimmedBoardName)
        case .list:
            created = model.createListBoard(name: trimmedBoardName)
        case .compound:
            let childIDs = availableCompoundChildren
                .filter { selectedChildBoardIDs.contains($0.id) }
                .map(\.id)
            created = model.createCompoundBoard(name: trimmedBoardName, childBoardIDs: childIDs)
        case .bible:
            created = false
        }
        guard created else {
            statusMessage = "The board could not be created."
            statusIsError = true
            return
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }

    private func pasteBoardShare() {
        guard let value = UIPasteboard.general.string?.trimmingCharacters(
            in: .whitespacesAndNewlines
        ), !value.isEmpty else {
            statusMessage = "The clipboard is empty."
            statusIsError = true
            return
        }
        shareText = value
        if let share = BoardShareContract.decode(value) {
            statusMessage = share.boardName.map { "Found “\($0)”." }
            statusIsError = false
        } else {
            statusMessage = "Paste a valid Taskify board share or board ID."
            statusIsError = true
        }
        focusedField = .share
    }

    private func joinBoard() {
        guard decodedShare != nil, !trimmedShareText.isEmpty else {
            statusMessage = "Enter a valid Taskify board share or board ID."
            statusIsError = true
            return
        }
        guard model.joinSharedBoard(shareText: trimmedShareText, name: customSharedName) else {
            statusMessage = model.errorMessage ?? "The board could not be joined."
            statusIsError = true
            return
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }
}

struct FloatingQuickAddBar: View {
    @Binding var draft: String
    var isFocused: FocusState<Bool>.Binding
    let focusRequest: Int
    let destinationName: String
    let onSubmit: () -> Void
    let onAddButton: () -> Void
    let onVoice: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            QuickAddTextField(
                text: $draft,
                isFocused: isFocused,
                focusRequest: focusRequest,
                accessibilityLabel: "New task in \(destinationName)",
                onSubmit: onSubmit
            )
                .padding(.horizontal, 17)
                .frame(height: 48)
                .taskifyGlassControl(
                    in: Capsule(),
                    fallbackFill: Color.black.opacity(0.32)
                )

            // Hidden while typing: the add button is the action you want in that moment, and two
            // circular buttons plus a shrinking field gets cramped on narrow screens.
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: onVoice) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                        .foregroundStyle(.white)
                        .taskifyGlassControl(
                            in: Circle(),
                            fallbackFill: Color.black.opacity(0.32)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add tasks by voice")
                .transition(.scale.combined(with: .opacity))
            }

            Button(action: onAddButton) {
                Image(systemName: "plus")
                    .font(.system(size: 19, weight: .bold))
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
                    .foregroundStyle(.white)
                    .taskifyGlassControl(
                        in: Circle(),
                        tint: TaskifyTheme.accent.opacity(0.72),
                        fallbackFill: TaskifyTheme.accent
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "Add task details to \(destinationName)"
                    : "Add task to \(destinationName) and close keyboard"
            )
        }
    }
}

struct QuickAddTextField: UIViewRepresentable {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let focusRequest: Int
    let accessibilityLabel: String
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(parent: self)
        coordinator.handledFocusRequest = focusRequest
        return coordinator
    }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.addTarget(
            context.coordinator,
            action: #selector(Coordinator.textChanged(_:)),
            for: .editingChanged
        )
        field.placeholder = "New Task"
        field.font = .preferredFont(forTextStyle: .body)
        field.textColor = .white
        field.tintColor = UIColor(TaskifyTheme.accent)
        field.backgroundColor = .clear
        field.clearButtonMode = .never
        field.autocapitalizationType = .sentences
        field.autocorrectionType = .default
        field.returnKeyType = .default
        field.enablesReturnKeyAutomatically = true
        field.accessibilityLabel = accessibilityLabel
        // Without this, the field's intrinsic width grows with its text (UITextField resists
        // compression by default), so a long title pushes the capsule wider than the screen
        // instead of scrolling its visible portion to track the cursor.
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    static func dismantleUIView(_ uiView: UITextField, coordinator: Coordinator) {
        coordinator.removeKeyboardDismissalGesture()
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        field.accessibilityLabel = accessibilityLabel
        if field.text != text {
            field.text = text
        }
        if focusRequest != context.coordinator.handledFocusRequest {
            context.coordinator.handledFocusRequest = focusRequest
            if !field.isFirstResponder {
                if field.window != nil {
                    field.becomeFirstResponder()
                } else {
                    DispatchQueue.main.async { [weak field] in field?.becomeFirstResponder() }
                }
            }
        } else if isFocused.wrappedValue {
            context.coordinator.hasSynchronizedFocus = true
            if !field.isFirstResponder {
                field.becomeFirstResponder()
            }
        } else if context.coordinator.hasSynchronizedFocus, field.isFirstResponder {
            context.coordinator.hasSynchronizedFocus = false
            field.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate, UIGestureRecognizerDelegate {
        var parent: QuickAddTextField
        var hasSynchronizedFocus = false
        var handledFocusRequest = 0
        // The floating field sits outside the task scroll views, and an empty scroll view has no
        // draggable content. Observe the active window so swipe-down works on populated and empty
        // boards.
        private weak var activeField: UITextField?
        private weak var gestureWindow: UIWindow?
        private lazy var keyboardDismissalPan: UIPanGestureRecognizer = {
            let gesture = UIPanGestureRecognizer(
                target: self,
                action: #selector(handleKeyboardDismissalPan(_:))
            )
            gesture.cancelsTouchesInView = false
            gesture.delegate = self
            return gesture
        }()

        init(parent: QuickAddTextField) {
            self.parent = parent
        }

        @objc func textChanged(_ field: UITextField) {
            parent.text = field.text ?? ""
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            parent.isFocused.wrappedValue = true
            installKeyboardDismissalGesture(for: textField)
        }

        func textFieldDidEndEditing(_ textField: UITextField) {
            parent.isFocused.wrappedValue = false
            removeKeyboardDismissalGesture()
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onSubmit()
            return false
        }

        private func installKeyboardDismissalGesture(for field: UITextField) {
            guard let window = field.window else {
                DispatchQueue.main.async { [weak self, weak field] in
                    guard let self, let field, field.isFirstResponder else { return }
                    self.installKeyboardDismissalGesture(for: field)
                }
                return
            }

            if gestureWindow === window {
                activeField = field
                return
            }

            removeKeyboardDismissalGesture()
            activeField = field
            gestureWindow = window
            window.addGestureRecognizer(keyboardDismissalPan)
        }

        func removeKeyboardDismissalGesture() {
            gestureWindow?.removeGestureRecognizer(keyboardDismissalPan)
            gestureWindow = nil
            activeField = nil
        }

        @objc private func handleKeyboardDismissalPan(_ gesture: UIPanGestureRecognizer) {
            guard gesture.state == .changed else { return }
            let translation = gesture.translation(in: gestureWindow)
            guard translation.y > 30 else { return }
            guard abs(translation.y) > abs(translation.x) else { return }

            parent.isFocused.wrappedValue = false
            activeField?.resignFirstResponder()
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard activeField?.isFirstResponder == true else { return false }
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: gestureWindow)
            return velocity.y > abs(velocity.x)
        }

        /// The gesture is on the window, so without this it also sees touches inside any sheet
        /// presented above the board — e.g. the task editor. A drag that begins on a text field
        /// anywhere (this one or a completely different field in a presented sheet) is a cursor
        /// placement or text-selection gesture, never a request to dismiss the keyboard, even if
        /// this field is still first responder in the background. Regression: that conflict made
        /// dragging to select a title in the task editor sometimes get read as a swipe-to-dismiss,
        /// resigning this field mid-interaction and leaving the editor's own focus/dismiss state
        /// out of sync — closing and reopening the sheet instead of placing the cursor.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view: UIView? = touch.view
            while let current = view {
                if current is UITextField || current is UITextView { return false }
                view = current.superview
            }
            return true
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

/// Bottom action bar shown while `TaskSelectionController.isActive`, ported from the PWA's
/// `SelectionOverlays.tsx` selection bar, including its physical checklist action.
struct SelectionActionBar: View {
    @Environment(AppModel.self) private var model
    var selection: TaskSelectionController
    let onMove: () -> Void
    let onPrint: () -> Void
    let onComplete: () -> Void
    let onDelete: () -> Void

    private var selectedCount: Int { selection.selectedCount }

    private var hasIncompleteSelected: Bool {
        selection.selectedTaskIDs.contains { model.task(withID: $0)?.completed == false }
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text(selectedCount > 0 ? "\(selectedCount) selected" : "Select items")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                Spacer()
                Button("Cancel") { selection.exit() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)

            HStack(spacing: 0) {
                SelectionBarAction(systemName: "xmark", label: "Clear", disabled: selectedCount == 0) {
                    selection.clear()
                }
                SelectionBarAction(systemName: "square.grid.2x2", label: "Move", disabled: selectedCount == 0, action: onMove)
                SelectionBarAction(systemName: "printer", label: "Print", disabled: selection.selectedTaskIDs.isEmpty, action: onPrint)
                SelectionBarAction(systemName: "checkmark", label: "Done", disabled: !hasIncompleteSelected, action: onComplete)
                SelectionBarAction(
                    systemName: "trash",
                    label: "Delete",
                    disabled: selectedCount == 0,
                    danger: true,
                    action: onDelete
                )
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 8)
        }
        .taskifyGlass(cornerRadius: 22)
    }
}

struct SelectionBarAction: View {
    let systemName: String
    let label: String
    var disabled: Bool
    var danger: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: systemName)
                    .font(.system(size: 17, weight: .semibold))
                Text(label)
                    .font(.system(size: 10, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .foregroundStyle(disabled ? TaskifyTheme.tertiaryText : (danger ? Color.red : TaskifyTheme.primaryText))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

/// Board/column picker for the selection bar's "Move" action, ported from `SelectionOverlays.tsx`.
/// List boards with more than one list, week boards (always 7 weekday columns), and compound
/// boards all drill into a column picker; a single-column list board moves directly.
struct SelectionMoveSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    var selection: TaskSelectionController
    let onMoved: () -> Void

    private struct ColumnTarget: Identifiable {
        let id: String
        let boardID: String
        let boardName: String
        let columnID: String
        let columnName: String
    }

    @State private var drilledInBoard: Board?

    private var eligibleBoards: [Board] {
        model.visibleBoards.filter { $0.kind != .bible }
    }

    var body: some View {
        NavigationStack {
            List {
                if let drilledInBoard {
                    ForEach(columnTargets(for: drilledInBoard)) { target in
                        Button {
                            move(toBoardID: target.boardID, columnID: target.columnID)
                        } label: {
                            HStack {
                                Text(target.columnName)
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                if target.boardID != drilledInBoard.id {
                                    Spacer()
                                    Text(target.boardName)
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }
                            }
                        }
                    }
                } else if selection.isEmpty {
                    Text("Select one or more items to move.")
                        .foregroundStyle(TaskifyTheme.secondaryText)
                } else {
                    ForEach(eligibleBoards) { board in
                        Button {
                            handleSelect(board)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(board.name)
                                        .foregroundStyle(TaskifyTheme.primaryText)
                                    Text(board.kind.rawValue.capitalized)
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }
                                Spacer()
                                if needsDrillIn(board) {
                                    Image(systemName: "chevron.right")
                                        .font(.caption2)
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(drilledInBoard == nil ? "Move selected items" : "Choose a list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if drilledInBoard != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back") { drilledInBoard = nil }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
        }
    }

    private func needsDrillIn(_ board: Board) -> Bool {
        switch board.kind {
        case .list: return board.columns.count > 1
        case .week, .compound: return true
        case .bible: return false
        }
    }

    private func handleSelect(_ board: Board) {
        if needsDrillIn(board) {
            drilledInBoard = board
        } else if let columnID = board.columns.first?.id {
            move(toBoardID: board.id, columnID: columnID)
        }
    }

    private func columnTargets(for board: Board) -> [ColumnTarget] {
        if board.kind == .compound {
            return model.compoundChildBoards(for: board.id).flatMap { child in
                child.columns.sorted { $0.order < $1.order }.map { column in
                    ColumnTarget(
                        id: "\(child.id)::\(column.id)",
                        boardID: child.id,
                        boardName: child.name,
                        columnID: column.id,
                        columnName: column.name
                    )
                }
            }
        }
        return board.columns
            .sorted { $0.order < $1.order }
            .map { column in
                ColumnTarget(
                    id: column.id,
                    boardID: board.id,
                    boardName: board.name,
                    columnID: column.id,
                    columnName: column.name
                )
            }
    }

    private func move(toBoardID boardID: String, columnID: String) {
        model.moveTasks(selection.selectedTaskIDs, toBoardID: boardID, columnID: columnID)
        model.moveTaskifyEvents(selection.selectedEventIDs, toBoardID: boardID, columnID: columnID)
        dismiss()
        onMoved()
    }
}

struct BoardShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    let board: Board
    let onPrint: () -> Void

    @State private var shareMode = ShareMode.board
    @State private var copied = false
    @State private var templateShare: BoardTemplateShareResult?
    @State private var templateError: String?
    @State private var isGeneratingTemplate = false
    @State private var requestedTemplate = false
    @State private var recipient = ""
    @State private var isSendingToContact = false
    @State private var sendErrorMessage: String?
    @State private var sentToRecipientName: String?

    private enum ShareMode: String, CaseIterable, Identifiable {
        case board = "Board"
        case template = "Template"
        case print = "Print"

        var id: String { rawValue }
    }

    private var activeShareBoard: Board? {
        switch shareMode {
        case .board: board
        case .template: templateShare?.board
        case .print: nil
        }
    }

    private var sharePayload: String? {
        guard shareMode != .print, let activeShareBoard else { return nil }
        return (try? BoardShareContract.encode(board: activeShareBoard))
            ?? activeShareBoard.effectiveNostrBoardID
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Picker("Share mode", selection: $shareMode) {
                        ForEach(ShareMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    if shareMode == .print {
                        printModeContent
                    } else {
                        VStack(spacing: 5) {
                            Label(
                                shareMode == .board ? "Live board" : "Independent copy",
                                systemImage: shareMode == .board
                                    ? "arrow.triangle.2.circlepath"
                                    : "square.on.square"
                            )
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TaskifyTheme.accent)
                            Text(
                                shareMode == .board
                                    ? "Changes remain synced for everyone who joins this board."
                                    : "Creates a snapshot with a new board ID. Future changes won't sync between the two boards."
                            )
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .multilineTextAlignment(.center)
                        }

                        if let sharePayload {
                            Button(action: copyBoardID) {
                                VStack(spacing: 11) {
                                    TaskifyQRCode(value: sharePayload)
                                        .frame(width: 250, height: 250)
                                        .padding(10)
                                        .background(.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))

                                    Label(copied ? "Board ID copied" : "Tap QR to copy board ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(copied ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(copied ? "Board ID copied" : "Copy board ID")
                        } else {
                            VStack(spacing: 14) {
                                if isGeneratingTemplate {
                                    ProgressView()
                                        .controlSize(.large)
                                        .tint(TaskifyTheme.accent)
                                    Text("Creating a template snapshot…")
                                } else {
                                    Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                                        .font(.system(size: 34, weight: .medium))
                                    Text(templateError ?? "The template isn't ready yet.")
                                    Button("Try again", action: generateTemplate)
                                        .buttonStyle(.bordered)
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .multilineTextAlignment(.center)
                            .frame(width: 270, height: 270)
                            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 22).stroke(TaskifyTheme.border, lineWidth: 1))
                        }

                        if let templateShare, shareMode == .template {
                            Label(
                                templateStatus(templateShare),
                                systemImage: templateShare.failedTaskCount == 0 && templateShare.failedEventCount == 0
                                    ? "checkmark.circle.fill"
                                    : "exclamationmark.triangle.fill"
                            )
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(
                                    templateShare.failedTaskCount == 0 && templateShare.failedEventCount == 0
                                        ? Color.green
                                        : Color.orange
                                )
                                .multilineTextAlignment(.center)
                        }

                        if let activeShareBoard {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(shareMode == .board ? "BOARD ID" : "TEMPLATE BOARD ID")
                                    .font(.system(size: 10, weight: .bold))
                                    .tracking(1.2)
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                                Text(activeShareBoard.effectiveNostrBoardID)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(14)
                            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 17).stroke(TaskifyTheme.border, lineWidth: 1))
                        }

                        if let sharePayload {
                            HStack(spacing: 10) {
                                Button(action: copyBoardID) {
                                    Label(copied ? "Copied" : "Copy ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                                        .frame(maxWidth: .infinity)
                                        .frame(height: 48)
                                }
                                .buttonStyle(.bordered)

                                ShareLink(
                                    item: sharePayload,
                                    subject: Text(shareSubject),
                                    preview: SharePreview(shareSubject)
                                ) {
                                    Label("Share", systemImage: "square.and.arrow.up")
                                        .frame(maxWidth: .infinity)
                                        .frame(height: 48)
                                }
                                .buttonStyle(.borderedProminent)
                            }
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Relays")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TaskifyTheme.secondaryText)
                            ForEach(board.effectiveRelayURLs, id: \.self) { relay in
                                Label(relay, systemImage: "antenna.radiowaves.left.and.right")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        if activeShareBoard != nil {
                            sendToContactCard
                        }
                    }
                }
                .padding(20)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Share \(board.name)")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: shareMode) { _, mode in
                copied = false
                sendErrorMessage = nil
                sentToRecipientName = nil
                guard mode == .template,
                      templateShare == nil,
                      !requestedTemplate else { return }
                generateTemplate()
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var printModeContent: some View {
        VStack(spacing: 18) {
            VStack(spacing: 5) {
                Label("Printable checklist", systemImage: "printer")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.accent)
                Text("Print open tasks as a paper checklist, or scan a printed sheet to mark tasks complete.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .multilineTextAlignment(.center)
            }

            Image(systemName: "printer")
                .font(.system(size: 44, weight: .medium))
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(width: 270, height: 200)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22).stroke(TaskifyTheme.border, lineWidth: 1))

            Button {
                dismiss()
                onPrint()
            } label: {
                Label("Print or scan checklist", systemImage: "printer")
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func copyBoardID() {
        guard let activeShareBoard else { return }
        // A board ID grants full access to the board; don't leave it on the clipboard (or other
        // devices' clipboards) indefinitely. Cross-device paste is kept for sharing to a Mac.
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: activeShareBoard.effectiveNostrBoardID]],
            options: [.expirationDate: Date().addingTimeInterval(600)]
        )
        withAnimation(.snappy) { copied = true }
    }

    private var shareSubject: String {
        shareMode == .board
            ? "Join \(board.name) in Taskify"
            : "Copy \(board.name) in Taskify"
    }

    private func templateStatus(_ result: BoardTemplateShareResult) -> String {
        let failures = result.failedTaskCount + result.failedEventCount
        if failures > 0 {
            return "Template ready, but \(failures) item\(failures == 1 ? "" : "s") could not be added."
        }
        let taskLabel = "\(result.queuedTaskCount) task\(result.queuedTaskCount == 1 ? "" : "s")"
        let eventLabel = "\(result.queuedEventCount) event\(result.queuedEventCount == 1 ? "" : "s")"
        if result.queuedTaskCount == 0, result.queuedEventCount == 0 {
            return "Empty template ready to share. Publishing in the background."
        }
        if result.queuedEventCount == 0 {
            return "Template ready with \(taskLabel). Publishing in the background."
        }
        if result.queuedTaskCount == 0 {
            return "Template ready with \(eventLabel). Publishing in the background."
        }
        return "Template ready with \(taskLabel) and \(eventLabel). Publishing in the background."
    }

    private func generateTemplate() {
        guard !isGeneratingTemplate else { return }
        requestedTemplate = true
        templateError = nil
        isGeneratingTemplate = true
        copied = false

        Task { @MainActor in
            do {
                templateShare = try await model.createTemplateShare(for: board.id)
            } catch {
                templateError = error.localizedDescription
            }
            isGeneratingTemplate = false
        }
    }

    private var recipientIsValid: Bool { NostrPublicKey.parse(recipient) != nil }

    private var matchingContacts: [NostrContact] {
        let query = recipient.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, NostrPublicKey.parse(query) == nil else {
            return model.nostrContacts
        }
        return model.nostrContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
    }

    private var sendToContactCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Send to a contact")
                .font(.caption.weight(.bold))
                .foregroundStyle(TaskifyTheme.secondaryText)

            TextField("npub or public key", text: $recipient, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...3)
                .font(.system(.callout, design: .monospaced))
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(TaskifyTheme.border, lineWidth: 1))

            if !matchingContacts.isEmpty {
                VStack(spacing: 6) {
                    ForEach(matchingContacts.prefix(6)) { contact in
                        Button {
                            recipient = contact.npub
                            sendErrorMessage = nil
                            sentToRecipientName = nil
                        } label: {
                            HStack(spacing: 10) {
                                NostrContactAvatar(contact: contact, size: 30)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(contact.displayName)
                                        .foregroundStyle(TaskifyTheme.primaryText)
                                    Text(contact.subtitle)
                                        .font(.caption2)
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if contact.publicKey == NostrPublicKey.parse(recipient)?.hexString {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(TaskifyTheme.accent)
                                }
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 44)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if let sendErrorMessage {
                Label(sendErrorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let sentToRecipientName {
                Label("Sent to \(sentToRecipientName)", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Color.green)
            }

            Button(action: sendToContact) {
                if isSendingToContact {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                } else {
                    Text("Send")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!recipientIsValid || activeShareBoard == nil || isSendingToContact)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sendToContact() {
        guard recipientIsValid, let activeShareBoard, !isSendingToContact else { return }
        isSendingToContact = true
        sendErrorMessage = nil
        sentToRecipientName = nil
        let recipientValue = recipient
        Task { @MainActor in
            do {
                try await model.sendSharedBoard(
                    boardID: activeShareBoard.effectiveNostrBoardID,
                    boardName: activeShareBoard.name,
                    relayURLs: activeShareBoard.effectiveRelayURLs,
                    to: recipientValue
                )
                sentToRecipientName = model.nostrContact(
                    publicKey: NostrPublicKey.parse(recipientValue)?.hexString ?? ""
                )?.displayName ?? "contact"
                recipient = ""
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                sendErrorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSendingToContact = false
        }
    }
}

struct TaskifyQRCode: View {
    let value: String

    private static let context = CIContext()

    var body: some View {
        if let image = image {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
        } else {
            Image(systemName: "qrcode")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.black)
                .padding(35)
        }
    }

    private var image: CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else {
            return nil
        }
        return Self.context.createCGImage(output, from: output.extent)
    }
}
