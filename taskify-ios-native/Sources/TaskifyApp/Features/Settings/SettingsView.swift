import SwiftUI
import TaskifyCore
import UIKit
import VisionKit

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var newBoardName = ""
    @State private var newBoardKind: BoardKind = .week
    @State private var selectedCompoundChildIDs: Set<String> = []
    @State private var managingCompoundBoard: Board?
    @State private var sharedBoardID = ""
    @State private var sharedBoardName = ""
    @State private var showingBoardScanner = false
    @State private var identityInput = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Settings")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(.horizontal, 18)
                .padding(.top, 14)

            ScrollView {
                VStack(spacing: 18) {
                    identityCard
                    syncCard
                    boardsCard
                    notificationsCard
                    migrationCard
                    appearanceCard
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 18)
            }
            .scrollIndicators(.hidden)
        }
        .sheet(isPresented: $showingBoardScanner) {
            BoardQRJoinFlow()
                .environmentObject(model)
        }
        .sheet(item: $managingCompoundBoard) { board in
            CompoundBoardManagerSheet(boardID: board.id)
                .environmentObject(model)
        }
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nostr identity")
                .font(.headline)

            Text(model.identityNpub.isEmpty ? "Creating secure identity…" : model.identityNpub)
                .font(.caption.monospaced())
                .foregroundStyle(TaskifyTheme.secondaryText)
                .lineLimit(2)
                .textSelection(.enabled)

            Button {
                UIPasteboard.general.string = model.identityNpub
            } label: {
                Label("Copy npub", systemImage: "doc.on.doc")
            }
            .buttonStyle(.bordered)
            .disabled(model.identityNpub.isEmpty)

            SecureField("Import nsec or 64-character secret", text: $identityInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button("Import identity") {
                guard model.importIdentity(identityInput) else { return }
                identityInput = ""
            }
            .buttonStyle(.bordered)
            .disabled(identityInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var syncCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: model.syncIsOnline ? "checkmark.icloud.fill" : "arrow.triangle.2.circlepath.icloud")
                    .font(.title2)
                    .foregroundStyle(model.syncIsOnline ? Color.green : TaskifyTheme.accent)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Nostr sync")
                        .font(.headline)
                    Text(model.syncStatus)
                        .font(.subheadline.weight(.semibold))
                }

                Spacer()

                Circle()
                    .fill(model.syncIsOnline ? Color.green : Color.orange)
                    .frame(width: 9, height: 9)
                    .accessibilityHidden(true)
            }

            Text(model.syncDetail)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            if model.relayStatuses.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Preparing relays…")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            } else {
                VStack(spacing: 8) {
                    ForEach(model.relayStatuses) { relay in
                        RelayStatusRow(relay: relay)
                    }
                }
            }

            if model.pendingSyncChangeCount > 0 {
                Label(
                    "\(model.pendingSyncChangeCount) change\(model.pendingSyncChangeCount == 1 ? "" : "s") safely queued",
                    systemImage: "tray.full.fill"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Button {
                model.retrySync()
            } label: {
                Label("Retry sync", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)

            Text("Taskify stays synced when at least one relay is available. Individual relay issues are shown above without incorrectly marking the whole app offline.")
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var availableCompoundChildren: [Board] {
        model.visibleBoards.filter { $0.kind == .list }
    }

    private var createBoardButtonTitle: String {
        switch newBoardKind {
        case .week: "Create weekly board"
        case .list: "Create list board"
        case .compound: "Create compound board"
        case .bible: "Create board"
        }
    }

    private func boardSummary(_ board: Board) -> String {
        switch board.kind {
        case .week:
            "Weekly board"
        case .list:
            "List board • \(board.columns.count) lists"
        case .compound:
            "Compound board • \(model.compoundChildBoards(for: board.id).count) linked boards"
        case .bible:
            "Bible board"
        }
    }

    private var boardsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Boards & Lists")
                .font(.headline)

            ForEach(model.visibleBoards) { board in
                VStack(spacing: 7) {
                    Button {
                        model.selectBoard(board.id)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(board.name)
                                Text(boardSummary(board))
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                HStack(spacing: 6) {
                                    Text(board.effectiveNostrBoardID)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                        .lineLimit(1)

                                    Image(systemName: "doc.on.doc")
                                        .font(.caption2)
                                        .foregroundStyle(TaskifyTheme.secondaryText)
                                }
                            }
                            Spacer()
                            if board.id == model.selectedBoardID {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(TaskifyTheme.accent)
                            }
                        }
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 58)
                        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = board.effectiveNostrBoardID
                        } label: {
                            Label("Copy board ID", systemImage: "doc.on.doc")
                        }
                    }

                    if board.kind == .compound {
                        Button {
                            managingCompoundBoard = board
                        } label: {
                            Label("Manage linked boards", systemImage: "slider.horizontal.3")
                                .font(.caption.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }

            TextField("Board name", text: $newBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(TaskifyTheme.border, lineWidth: 1))

            Picker("Board type", selection: $newBoardKind) {
                Text("Weekly").tag(BoardKind.week)
                Text("Lists").tag(BoardKind.list)
                Text("Compound").tag(BoardKind.compound)
            }
            .pickerStyle(.segmented)

            if newBoardKind == .compound {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Linked list boards")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TaskifyTheme.secondaryText)

                    if availableCompoundChildren.isEmpty {
                        Text("Create a list board before creating a compound board.")
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    } else {
                        ForEach(availableCompoundChildren) { child in
                            Button {
                                if selectedCompoundChildIDs.contains(child.id) {
                                    selectedCompoundChildIDs.remove(child.id)
                                } else {
                                    selectedCompoundChildIDs.insert(child.id)
                                }
                            } label: {
                                HStack {
                                    Image(systemName: selectedCompoundChildIDs.contains(child.id) ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(selectedCompoundChildIDs.contains(child.id) ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                                    Text(child.name)
                                    Spacer()
                                    Text("\(child.columns.count) lists")
                                        .font(.caption)
                                        .foregroundStyle(TaskifyTheme.tertiaryText)
                                }
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .padding(.horizontal, 12)
                                .frame(height: 42)
                                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            Button {
                let created: Bool
                switch newBoardKind {
                case .week:
                    created = model.createWeekBoard(name: newBoardName)
                case .list:
                    created = model.createListBoard(name: newBoardName)
                case .compound:
                    let orderedChildIDs = availableCompoundChildren
                        .filter { selectedCompoundChildIDs.contains($0.id) }
                        .map(\.id)
                    created = model.createCompoundBoard(
                        name: newBoardName,
                        childBoardIDs: orderedChildIDs
                    )
                case .bible:
                    created = false
                }
                guard created else { return }
                newBoardName = ""
                selectedCompoundChildIDs.removeAll()
            } label: {
                Text(createBoardButtonTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(TaskifyTheme.accent, in: Capsule())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(
                newBoardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    (newBoardKind == .compound && selectedCompoundChildIDs.isEmpty)
            )

            Divider()

            Text("Join a shared board")
                .font(.headline)

            TextField("Board ID or Taskify share", text: $sharedBoardID, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(2...5)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .frame(minHeight: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Text("Paste either a board ID or the full share text from Taskify. The board name and relays are imported automatically when available.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            Button {
                showingBoardScanner = true
            } label: {
                Label("Scan board QR code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
            }
            .buttonStyle(.bordered)

            TextField("Board name (optional)", text: $sharedBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button("Join shared board") {
                guard model.joinSharedBoard(shareText: sharedBoardID, name: sharedBoardName) else { return }
                sharedBoardID = ""
                sharedBoardName = ""
            }
            .buttonStyle(.borderedProminent)
            .disabled(sharedBoardID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var migrationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Native app status")
                .font(.headline)

            StatusRow(title: "Offline task storage", status: "Active", complete: true)
            StatusRow(title: "Weekly boards", status: "Active", complete: true)
            StatusRow(title: "List boards & rich task editing", status: "Active", complete: true)
            StatusRow(title: "Compound boards", status: "Active", complete: true)
            StatusRow(title: "Recurrence & native reminders", status: "Active", complete: true)
            StatusRow(title: "Nostr sync", status: model.syncStatus, complete: model.syncIsOnline)
            StatusRow(title: "Wallet & chat", status: "Planned", complete: false)
        }
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var notificationsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "bell.badge.fill")
                    .font(.title2)
                    .foregroundStyle(TaskifyTheme.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Task reminders")
                        .font(.headline)
                    Text(model.notificationStatus)
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }

            Text("Reminders are scheduled locally by iOS. Task titles and dates stay on this device.")
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)

            if model.notificationStatus == "Disabled in iOS Settings" {
                Button("Open iOS Settings") {
                    if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                        openURL(settingsURL)
                    }
                }
                .buttonStyle(.borderedProminent)
            } else if model.notificationStatus != "Enabled" && model.notificationStatus != "Delivered quietly" {
                Button("Enable notifications") {
                    model.requestNotificationPermission()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }

    private var appearanceCard: some View {
        HStack(spacing: 14) {
            Image(systemName: "moon.stars.fill")
                .font(.title2)
                .foregroundStyle(TaskifyTheme.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text("PWA-inspired dark appearance")
                    .font(.headline)
                Text("Native materials, Dynamic Type, and VoiceOver are enabled.")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .taskifyGlass(cornerRadius: 24)
    }
}

private struct CompoundBoardManagerSheet: View {
    @EnvironmentObject private var model: AppModel
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
            Form {
                if let board {
                    Section {
                        Toggle(
                            "Hide board names in column headers",
                            isOn: Binding(
                                get: { board.hideChildBoardNames },
                                set: { _ = model.setCompoundHideChildBoardNames(boardID: boardID, hidden: $0) }
                            )
                        )
                    } footer: {
                        Text("When off, each list shows the child board it came from.")
                    }

                    Section("Linked boards") {
                        if linkedBoards.isEmpty {
                            Text("No list boards linked yet.")
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }

                        ForEach(Array(linkedBoards.enumerated()), id: \.element.id) { index, child in
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(child.name)
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
                        }
                    }

                    if !availableBoards.isEmpty {
                        Section("Add a list board") {
                            ForEach(availableBoards) { child in
                                Button {
                                    _ = model.setCompoundChild(
                                        boardID: boardID,
                                        childBoardID: child.id,
                                        included: true
                                    )
                                } label: {
                                    Label(child.name, systemImage: "plus.circle.fill")
                                }
                            }
                        }
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

    private func isIncluded(_ child: Board) -> Bool {
        board?.children.contains(where: { child.matchesReference($0) }) == true
    }
}

private struct BoardQRJoinFlow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var scannedShare: BoardSharePayload?
    @State private var rawShare = ""
    @State private var scanError: String?

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

private struct RelayStatusRow: View {
    let relay: TaskRelayStatus

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
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 42)
        .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct StatusRow: View {
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
