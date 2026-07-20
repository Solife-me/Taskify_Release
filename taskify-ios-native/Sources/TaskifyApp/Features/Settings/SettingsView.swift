import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var newBoardName = ""
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
                    boardsCard
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

            HStack(spacing: 8) {
                Circle()
                    .fill(model.syncStatus == "Synced" ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(model.syncStatus)
                    .font(.subheadline.weight(.semibold))
            }

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
                            Text(board.effectiveNostrBoardID)
                                .font(.caption2.monospaced())
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
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
            }

            TextField("Board name", text: $newBoardName)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(TaskifyTheme.border, lineWidth: 1))

            Button {
                guard model.createWeekBoard(name: newBoardName) else { return }
                newBoardName = ""
            } label: {
                Text("Create weekly board")
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
            StatusRow(title: "Nostr sync", status: model.syncStatus, complete: model.syncStatus == "Synced")
            StatusRow(title: "Wallet & chat", status: "Planned", complete: false)
        }
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
