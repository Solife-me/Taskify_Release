import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers
import VisionKit

enum IdentityAuthenticationError: LocalizedError {
    case unavailable
    case failed

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Set a device passcode before viewing or copying your private key."
        case .failed:
            "Device authentication did not complete."
        }
    }
}

struct AppearanceAccentSwatch: View {
    let label: String
    let color: Color
    let foregroundColor: Color
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(color)
                .frame(width: 34, height: 34)
                .overlay {
                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(foregroundColor)
                    }
                }
                .padding(4)
                .background(color.opacity(isSelected ? 0.22 : 0), in: Circle())
                .overlay {
                    Circle()
                        .stroke(
                            isSelected ? Color.white.opacity(0.9) : Color.white.opacity(0.22),
                            lineWidth: isSelected ? 2 : 1
                        )
                }
                .shadow(color: isSelected ? color.opacity(0.55) : .clear, radius: 6)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
    }
}

struct BoardManagerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let boardID: String
    @State private var boardName = ""
    @State private var newRelayURL = ""
    @State private var relayMessage: String?
    @State private var showingDeleteConfirmation = false
    @State private var showingArchiveBlocked = false
    @State private var showingRegenerateBoardIDConfirmation = false
    @State private var recoveryBusy = false
    @State private var recoveryMessage: String?

    private var board: Board? {
        model.board(withID: boardID)
    }

    private var taskCount: Int {
        model.taskCount(forBoardID: boardID)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                if let board {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            nameCard(board)
                            reorderCard(board)
                            detailsCard(board)
                            if board.kind != .bible {
                                completionCard(board)
                            }
                            if board.kind == .list {
                                indexCardToggleCard(board)
                            }
                            relaysCard(board)
                            syncRecoveryCard(board)
                            archiveCard(board)
                            deleteCard
                        }
                        .padding(18)
                    }
                } else {
                    ContentUnavailableView("Board unavailable", systemImage: "exclamationmark.triangle")
                }
            }
            .navigationTitle(board?.name ?? "Manage board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .onAppear {
            boardName = board?.name ?? ""
        }
        .alert("Keep one active board", isPresented: $showingArchiveBlocked) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Create or restore another board before archiving this one.")
        }
        .confirmationDialog(
            "Delete \(board?.name ?? "this board")?",
            isPresented: $showingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete board and \(taskCount) task\(taskCount == 1 ? "" : "s")", role: .destructive) {
                guard model.deleteBoard(boardID: boardID) else { return }
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the local copy. It does not delete copies already held by collaborators.")
        }
        .confirmationDialog(
            "Generate a new board ID?",
            isPresented: $showingRegenerateBoardIDConfirmation,
            titleVisibility: .visible
        ) {
            Button("Generate ID and republish", role: .destructive) {
                runRecoveryAction {
                    let newID = try await model.regenerateBoardNostrID(boardID: boardID)
                    return "New board ID created and snapshot queued (…\(newID.suffix(8))). Existing shares will not follow future changes."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This moves future sync to a new board identity. People using the old board share must receive the new share to keep syncing.")
        }
    }

    private func nameCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Board name")
                .font(.headline)

            TextField("Board name", text: $boardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(TaskifyTheme.border, lineWidth: 1)
                )

            Button("Save name") {
                let trimmedName = boardName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard model.renameBoard(boardID: boardID, name: trimmedName) else { return }
                boardName = trimmedName
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                boardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    boardName.trimmingCharacters(in: .whitespacesAndNewlines) == board.name
            )

            Text("Name changes sync with collaborators on shared boards.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var reorderableBoardIDs: [String] {
        model.visibleBoards.filter { $0.kind != .bible }.map(\.id)
    }

    private func reorderCard(_ board: Board) -> some View {
        let position = reorderableBoardIDs.firstIndex(of: board.id)
        let canMoveUp = (position ?? 0) > 0
        let canMoveDown = position.map { $0 < reorderableBoardIDs.count - 1 } ?? false

        return VStack(alignment: .leading, spacing: 12) {
            Text("Order")
                .font(.headline)

            HStack(spacing: 10) {
                Button {
                    _ = model.moveBoard(boardID: boardID, direction: -1)
                } label: {
                    Label("Move Up", systemImage: "arrow.up")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)
                .disabled(!canMoveUp)

                Button {
                    _ = model.moveBoard(boardID: boardID, direction: 1)
                } label: {
                    Label("Move Down", systemImage: "arrow.down")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.bordered)
                .disabled(!canMoveDown)
            }
            .font(.subheadline.weight(.semibold))

            Text("Changes where this board appears in the board switcher. Stays on this device only.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func detailsCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Board details")
                .font(.headline)

            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Type", value: boardKindName(board.kind))
                LabeledContent("Tasks", value: "\(taskCount)")
            }
            .font(.subheadline)

            Button {
                UIPasteboard.general.setItems(
                    // A board ID grants full access to the board; don't leave it on the clipboard
                    // (or other devices' clipboards) indefinitely.
                    [[UTType.plainText.identifier: board.effectiveNostrBoardID]],
                    options: [.expirationDate: Date().addingTimeInterval(600)]
                )
            } label: {
                Label("Copy board ID", systemImage: "doc.on.doc")
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func indexCardToggleCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "List index card",
                isOn: Binding(
                    get: { board.indexCardEnabled },
                    set: { _ = model.setBoardIndexCardEnabled(boardID: boardID, enabled: $0) }
                )
            )
            Text("Add a quick navigation card to jump to any list and keep it centered when opening the board.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func completionCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "Clear completed button",
                isOn: Binding(
                    get: { !board.clearCompletedDisabled },
                    set: {
                        _ = model.setBoardClearCompletedEnabled(
                            boardID: boardID,
                            enabled: $0
                        )
                    }
                )
            )
            Text("When the global Completed view is off, show the destructive Clear completed action for this board.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func relaysCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Nostr relays")
                .font(.headline)

            VStack(spacing: 8) {
                ForEach(board.effectiveRelayURLs, id: \.self) { relayURL in
                    HStack(spacing: 10) {
                        Image(systemName: "network")
                            .foregroundStyle(TaskifyTheme.accent)
                        Text(relayURL)
                            .font(.caption.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button(role: .destructive) {
                            removeRelay(relayURL, from: board)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .disabled(board.effectiveRelayURLs.count <= 1)
                        .accessibilityLabel("Remove \(relayURL)")
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 42)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )
                }
            }

            HStack(spacing: 8) {
                TextField("wss://relay.example", text: $newRelayURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.done)
                    .onSubmit { addRelay(to: board) }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )

                Button("Add") { addRelay(to: board) }
                    .buttonStyle(.borderedProminent)
                    .disabled(newRelayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Button("Restore Taskify defaults") {
                guard model.updateBoardRelayURLs(
                    boardID: board.id,
                    relayURLs: TaskifyRelayDefaults.urls
                ) else { return }
                relayMessage = "Default relays restored."
            }
            .buttonStyle(.bordered)
            .disabled(board.effectiveRelayURLs == TaskifyRelayDefaults.urls)

            if let relayMessage {
                Text(relayMessage)
                    .font(.caption)
                    .foregroundStyle(relayMessage.hasPrefix("Invalid") || relayMessage.hasPrefix("Keep")
                        ? Color.red
                        : TaskifyTheme.secondaryText)
            }

            Text("Relay changes apply immediately, migrate queued publishes, and sync in this board's share metadata. Secure wss:// relays are recommended.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func syncRecoveryCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Sync recovery")
                    .font(.headline)
                Spacer()
                if recoveryBusy { ProgressView().controlSize(.small) }
            }

            Button {
                runRecoveryAction {
                    try await model.resyncBoardHistory(boardID: boardID)
                    return "Relay history re-sync started."
                }
            } label: {
                Label("Re-sync relay history", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button {
                runRecoveryAction {
                    let result = try await model.republishBoardSnapshot(boardID: boardID)
                    return "Queued \(result.publishedRecordCount) current board record\(result.publishedRecordCount == 1 ? "" : "s") for republishing."
                }
            } label: {
                Label("Republish current snapshot", systemImage: "icloud.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button {
                runRecoveryAction {
                    let changed = try await model.limitQueuedRepublishToFirstPartyRelays(boardID: boardID)
                    if changed == 0 {
                        return "No queued republish is waiting on public relays."
                    }
                    return "Stopped sending \(changed) republished record\(changed == 1 ? "" : "s") to public relays. They still go to Taskify's relay, so your other devices get them."
                }
            } label: {
                Label("Clear queued republish", systemImage: "xmark.icloud")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button {
                runRecoveryAction {
                    let result = try await model.cleanStaleBoardEvents(boardID: boardID)
                    if result.staleEventCount == 0 {
                        return "No stale task versions found across \(result.respondingRelayCount) responding relay\(result.respondingRelayCount == 1 ? "" : "s")."
                    }
                    return "Queued deletion requests for \(result.staleEventCount) stale task version\(result.staleEventCount == 1 ? "" : "s")."
                }
            } label: {
                Label("Clean up stale task versions", systemImage: "eraser")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            Button(role: .destructive) {
                showingRegenerateBoardIDConfirmation = true
            } label: {
                Label("Generate new board ID", systemImage: "key.horizontal")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(recoveryBusy)

            if let recoveryMessage {
                Text(recoveryMessage)
                    .font(.caption)
                    .foregroundStyle(recoveryMessage.hasPrefix("Could not") ? Color.orange : TaskifyTheme.secondaryText)
            }
            Text("Use re-sync when relay content seems incomplete. Republish repairs missing current records. A new ID is a last resort that intentionally creates a new sync namespace.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func runRecoveryAction(
        _ operation: @escaping @MainActor () async throws -> String
    ) {
        guard !recoveryBusy else { return }
        recoveryBusy = true
        recoveryMessage = nil
        Task {
            defer { recoveryBusy = false }
            do { recoveryMessage = try await operation() }
            catch { recoveryMessage = "Could not complete recovery: \(error.localizedDescription)" }
        }
    }

    private func archiveCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if board.archived {
                Button {
                    guard model.unarchiveBoard(boardID: boardID) else { return }
                    dismiss()
                } label: {
                    Label("Restore board", systemImage: "tray.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            } else {
                Button {
                    if model.archiveBoard(boardID: boardID) {
                        dismiss()
                    } else {
                        showingArchiveBlocked = true
                    }
                } label: {
                    Label("Archive board", systemImage: "archivebox")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Text("Archiving is local to this device and can be reversed from Settings.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var deleteCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(role: .destructive) {
                showingDeleteConfirmation = true
            } label: {
                Label("Delete board", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            Text("Deleting removes this board and its locally stored tasks from this device.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func addRelay(to board: Board) {
        guard let normalized = TaskifyRelayURL.normalize(newRelayURL) else {
            relayMessage = "Invalid relay. Enter a ws:// or wss:// address."
            return
        }
        guard !board.effectiveRelayURLs.contains(normalized) else {
            relayMessage = "That relay is already configured."
            return
        }
        guard model.updateBoardRelayURLs(
            boardID: board.id,
            relayURLs: board.effectiveRelayURLs + [normalized]
        ) else {
            relayMessage = "Invalid relay configuration."
            return
        }
        newRelayURL = ""
        relayMessage = "Relay added and sync is reconnecting."
    }

    private func removeRelay(_ relayURL: String, from board: Board) {
        let remaining = board.effectiveRelayURLs.filter { $0 != relayURL }
        guard !remaining.isEmpty else {
            relayMessage = "Keep at least one relay for board sync."
            return
        }
        guard model.updateBoardRelayURLs(
            boardID: board.id,
            relayURLs: remaining
        ) else {
            relayMessage = "Invalid relay configuration."
            return
        }
        relayMessage = "Relay removed and queued changes were updated."
    }

    private func boardKindName(_ kind: BoardKind) -> String {
        switch kind {
        case .week: "Weekly"
        case .list: "Lists"
        case .compound: "Compound"
        case .bible: "Bible"
        }
    }
}

struct CompoundBoardManagerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let boardID: String

    private var board: Board? {
        model.board(withID: boardID)
    }

    private var linkedBoards: [Board] {
        model.compoundChildBoards(for: boardID)
    }

    private var availableBoards: [Board] {
        model.visibleBoards.filter { candidate in
            candidate.kind == .list && !isIncluded(candidate)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()
                if let board {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            settingsCard(board)
                            linkedBoardsCard
                            if !availableBoards.isEmpty {
                                addBoardCard
                            }
                        }
                        .padding(18)
                    }
                } else {
                    ContentUnavailableView("Board unavailable", systemImage: "exclamationmark.triangle")
                }
            }
            .navigationTitle(board?.name ?? "Compound board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private func settingsCard(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(
                "List index card",
                isOn: Binding(
                    get: { board.indexCardEnabled },
                    set: { _ = model.setBoardIndexCardEnabled(boardID: boardID, enabled: $0) }
                )
            )
            Text("Quickly jump between lists across all linked boards.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)

            Divider()
                .padding(.vertical, 4)

            Toggle(
                "Hide board names in column headers",
                isOn: Binding(
                    get: { board.hideChildBoardNames },
                    set: { _ = model.setCompoundHideChildBoardNames(boardID: boardID, hidden: $0) }
                )
            )
            Text("When off, each list shows the child board it came from.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var linkedBoardsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Linked boards")
                .font(.headline)

            if linkedBoards.isEmpty {
                Text("No list boards linked yet.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            VStack(spacing: 8) {
                ForEach(Array(linkedBoards.enumerated()), id: \.element.id) { index, child in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(child.name)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("\(child.columns.count) lists")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }

                        Spacer()

                        Button {
                            _ = model.moveCompoundChild(
                                boardID: boardID,
                                childBoardID: child.id,
                                direction: -1
                            )
                        } label: {
                            Image(systemName: "arrow.up")
                        }
                        .buttonStyle(.borderless)
                        .disabled(index == 0)

                        Button {
                            _ = model.moveCompoundChild(
                                boardID: boardID,
                                childBoardID: child.id,
                                direction: 1
                            )
                        } label: {
                            Image(systemName: "arrow.down")
                        }
                        .buttonStyle(.borderless)
                        .disabled(index == linkedBoards.count - 1)

                        Button(role: .destructive) {
                            _ = model.setCompoundChild(
                                boardID: boardID,
                                childBoardID: child.id,
                                included: false
                            )
                        } label: {
                            Image(systemName: "minus.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(child.name)")
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 42)
                    .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TaskifyTheme.border, lineWidth: 1)
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var addBoardCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a list board")
                .font(.headline)

            VStack(spacing: 8) {
                ForEach(availableBoards) { child in
                    Button {
                        _ = model.setCompoundChild(
                            boardID: boardID,
                            childBoardID: child.id,
                            included: true
                        )
                    } label: {
                        Label(child.name, systemImage: "plus.circle.fill")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private func isIncluded(_ child: Board) -> Bool {
        board?.children.contains(where: { child.matchesReference($0) }) == true
    }
}

struct BoardQRJoinFlow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onJoined: (() -> Void)?
    @State private var scannedShare: BoardSharePayload?
    @State private var rawShare = ""
    @State private var scanError: String?

    init(onJoined: (() -> Void)? = nil) {
        self.onJoined = onJoined
    }

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            Group {
                if let scannedShare {
                    reviewView(scannedShare)
                } else if scannerAvailable {
                    scannerView
                } else {
                    unavailableView
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle(scannedShare == nil ? "Scan board" : "Join board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var scannerView: some View {
        ZStack(alignment: .bottom) {
            TaskifyBoardCodeScanner(
                onCode: handleScannedCode,
                onError: { scanError = $0 }
            )
            .ignoresSafeArea(edges: .bottom)

            VStack(spacing: 8) {
                Label("Point the camera at a Taskify board QR code", systemImage: "viewfinder")
                    .font(.subheadline.weight(.semibold))
                    .multilineTextAlignment(.center)

                if let scanError {
                    Text(scanError)
                        .font(.caption)
                        .foregroundStyle(Color.orange)
                        .multilineTextAlignment(.center)
                } else {
                    Text("The board details will be shown for review before joining.")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(TaskifyTheme.border, lineWidth: 1))
            .padding(16)
        }
    }

    private var unavailableView: some View {
        ContentUnavailableView {
            Label("Camera scanning unavailable", systemImage: "qrcode.viewfinder")
        } description: {
            Text("Use a supported iPhone with camera access, or paste the Taskify share into the board join field.")
        } actions: {
            Button("Use paste instead") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
        .foregroundStyle(TaskifyTheme.primaryText)
    }

    private func reviewView(_ share: BoardSharePayload) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(spacing: 9) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(Color.green)
                    Text(share.boardName ?? "Shared Board")
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                    Text("Review this live board before joining.")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                .frame(maxWidth: .infinity)

                detailCard(title: "BOARD ID", values: [share.boardID], icon: "number")
                detailCard(
                    title: "RELAYS",
                    values: share.relayURLs.isEmpty ? TaskifyRelayDefaults.urls : share.relayURLs,
                    icon: "antenna.radiowaves.left.and.right"
                )

                Button {
                    guard model.joinSharedBoard(shareText: rawShare, name: "") else { return }
                    onJoined?()
                    dismiss()
                } label: {
                    Label("Join live board", systemImage: "person.2.badge.plus")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .buttonStyle(.borderedProminent)

                Button("Scan a different code") {
                    rawShare = ""
                    scannedShare = nil
                    scanError = nil
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
            }
            .padding(20)
        }
    }

    private func detailCard(title: String, values: [String], icon: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.system(size: 10, weight: .bold))
                .tracking(1.2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
            ForEach(values, id: \.self) { value in
                Label(value, systemImage: icon)
                    .font(.caption.monospaced())
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(TaskifyTheme.border, lineWidth: 1))
    }

    private func handleScannedCode(_ rawValue: String) {
        guard let share = BoardShareContract.decode(rawValue) else {
            scanError = "That QR code is not a valid Taskify board share."
            return
        }
        rawShare = rawValue
        scannedShare = share
        scanError = nil
    }
}

private struct TaskifyBoardCodeScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode, onError: onError)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        context.coordinator.scanner = scanner
        DispatchQueue.main.async {
            do {
                try scanner.startScanning()
            } catch {
                context.coordinator.onError("The camera scanner could not start. Check camera access in iOS Settings.")
            }
        }
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        let onError: (String) -> Void
        weak var scanner: DataScannerViewController?

        init(onCode: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onCode = onCode
            self.onError = onError
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                guard case let .barcode(barcode) = item,
                      let value = barcode.payloadStringValue else {
                    continue
                }
                onCode(value)
                return
            }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            onError("Camera scanning became unavailable. You can still paste the board share manually.")
        }
    }
}

struct LocalBackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var json: String

    init(json: String) {
        self.json = json
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let json = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.json = json
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(json.utf8))
    }
}

struct RelayStatusRow: View {
    let relay: TaskRelayStatus
    var onRemove: (() -> Void)? = nil

    private var color: Color {
        switch relay.phase {
        case .online: .green
        case .syncing: TaskifyTheme.accent
        case .connecting: .orange
        case .offline: .red
        }
    }

    private var label: String {
        switch relay.phase {
        case .online: "Synced"
        case .syncing: "Loading"
        case .connecting: "Connecting"
        case .offline: "Unavailable"
        }
    }

    private var relayName: String {
        URL(string: relay.relayURL)?.host ?? relay.relayURL
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(relayName)
                    .font(.subheadline.monospaced())
                    .lineLimit(1)

                if let message = relay.message, !message.isEmpty {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }
            }

            Spacer()

            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)

            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "minus.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("remove-sync-relay-\(relayName)")
                .accessibilityLabel("Remove \(relayName) from the sync list")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 42)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 1)
        )
    }
}

struct StatusRow: View {
    let title: String
    let status: String
    let complete: Bool

    var body: some View {
        HStack {
            Image(systemName: complete ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(complete ? Color.green : TaskifyTheme.secondaryText)
            Text(title)
            Spacer()
            Text(status)
                .font(.caption.weight(.semibold))
                .foregroundStyle(complete ? Color.green : TaskifyTheme.secondaryText)
        }
    }
}


/// Loads a snapshot on demand so thousands of queued events do not add work to Settings rendering.
struct SyncQueueInspector: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var records: [TaskPendingOutboxRecord] = []
    @State private var loaded = false
    @State private var relayCounts: [(name: String, count: Int)] = []
    @State private var scopeCounts: [(name: String, count: Int)] = []

    private var unacceptedCount: Int { records.filter { $0.acceptedRelayCount == 0 }.count }

    var body: some View {
        NavigationStack {
            List {
                Section("Delivery snapshot") {
                    if !loaded {
                        ProgressView("Reading queue…")
                    } else {
                        LabeledContent("Queued", value: records.count.formatted())
                        LabeledContent("No relay acceptance yet", value: unacceptedCount.formatted())
                        LabeledContent("Accepted by at least one relay", value: (records.count - unacceptedCount).formatted())
                        Text("Relay acceptance is a delivery receipt, not a verification that a backup can currently be restored. Changes may remain queued while other replicas are unavailable.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Waiting on relays") {
                    ForEach(relayCounts, id: \.name) { item in
                        LabeledContent(item.name, value: item.count.formatted())
                    }
                    Text("A change can wait on multiple relays, so these counts can exceed the queue total.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Changes by feature or board") {
                    ForEach(scopeCounts, id: \.name) { item in
                        LabeledContent(item.name, value: item.count.formatted())
                    }
                }
                Section("Queued changes · oldest first") {
                    ForEach(records) { record in
                        DisclosureGroup {
                            Text("Event kind: \(record.eventKind)")
                            Text("Event: \(record.id)")
                            Text("Record: \(record.recordID)")
                            Text("Scope: \(record.outboxScope)")
                            Text("Accepted by \(record.acceptedRelayCount) relay(s)")
                            if let parent = record.dependsOnEventID {
                                Text("Waiting for parent: \(parent)")
                            }
                            ForEach(record.pendingRelayURLs, id: \.self) { relay in
                                Text("Waiting: \(relay)")
                                if let rejection = record.relayRejections[relay] {
                                    Text("Refusals: \(rejection.count) · Retry after \(rejection.retryAfter.formatted())")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(model.pendingPublishScopeLabel(record.outboxScope))
                                Text(record.queuedAt, format: .dateTime.year().month().day().hour().minute())
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(record.acceptedRelayCount == 0 ? "No relay acceptance yet" : "Waiting for remaining replicas")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Sync queue")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: report) { Label("Share diagnostics", systemImage: "square.and.arrow.up") }
                        .disabled(!loaded)
                }
            }
            .task { await refresh() }
            .refreshable { await refresh() }
        }
    }

    @MainActor private func refresh() async {
        await model.refreshPendingPublishRecords()
        records = model.pendingPublishRecords
        relayCounts = counts(records.flatMap(\.pendingRelayURLs))
        scopeCounts = counts(records.map { model.pendingPublishScopeLabel($0.outboxScope) })
        loaded = true
    }

    private func counts(_ values: [String]) -> [(name: String, count: Int)] {
        Dictionary(values.map { ($0, 1) }, uniquingKeysWith: +)
            .map { (name: $0.key, count: $0.value) }
            .sorted { $0.count == $1.count ? $0.name < $1.name : $0.count > $1.count }
    }

    private var report: String {
        (["Taskify sync queue", "Queued: \(records.count)", "No acceptance: \(unacceptedCount)",
          "Routing metadata only; includes board names and record identifiers."] +
         scopeCounts.map { "Feature/board \($0.name): \($0.count)" } +
         relayCounts.map { "Waiting on \($0.name): \($0.count)" } +
         records.flatMap { record -> [String] in
             ["\(record.queuedAt.ISO8601Format()) | scope=\(record.outboxScope) | record=\(record.recordID) | event=\(record.id) | kind=\(record.eventKind) | accepted=\(record.acceptedRelayCount) | waiting=\(record.pendingRelayURLs.joined(separator: ",")) | parent=\(record.dependsOnEventID ?? "none")"] + record.relayRejections.keys.sorted().compactMap { relay in
                 guard let rejection = record.relayRejections[relay] else { return nil }
                 return "  refusal: \(relay) | count=\(rejection.count) | retryAfter=\(rejection.retryAfter.ISO8601Format())"
             }
         }).joined(separator: "\n")
    }
}
