import SwiftUI
import TaskifyCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var newBoardName = ""
    @State private var newBoardKind: BoardKind = .week
    @State private var sharedBoardID = ""
    @State private var sharedBoardName = ""
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

    private var boardsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Boards & Lists")
                .font(.headline)

            ForEach(model.visibleBoards) { board in
                Button {
                    model.selectBoard(board.id)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(board.name)
                            Text(board.kind == .list ? "List board • \(board.columns.count) lists" : "Weekly board")
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
                    .frame(height: 52)
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
            }

            TextField("Board name", text: $newBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(TaskifyTheme.border, lineWidth: 1))

            Picker("Board type", selection: $newBoardKind) {
                Text("Weekly").tag(BoardKind.week)
                Text("Lists").tag(BoardKind.list)
            }
            .pickerStyle(.segmented)

            Button {
                let created = newBoardKind == .list
                    ? model.createListBoard(name: newBoardName)
                    : model.createWeekBoard(name: newBoardName)
                guard created else { return }
                newBoardName = ""
            } label: {
                Text(newBoardKind == .list ? "Create list board" : "Create weekly board")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(TaskifyTheme.accent, in: Capsule())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(newBoardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Divider()

            Text("Join a shared board")
                .font(.headline)

            TextField("Board ID", text: $sharedBoardID)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            TextField("Board name (optional)", text: $sharedBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button("Join shared board") {
                guard model.joinWeekBoard(boardID: sharedBoardID, name: sharedBoardName) else { return }
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
