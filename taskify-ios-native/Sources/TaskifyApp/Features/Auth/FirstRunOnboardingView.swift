import SwiftUI
import UniformTypeIdentifiers
import TaskifyCore

struct FirstRunOnboardingView: View {
    let pushSupported: Bool
    let pushConfigured: Bool
    let cloudRestoreAvailable: Bool

    @Environment(\.appAccent) private var accent
    @StateObject private var viewModel: FirstRunOnboardingViewModel
    @State private var showFileImporter = false
    @State private var showFileExporter = false

    init(
        pushSupported: Bool,
        pushConfigured: Bool,
        cloudRestoreAvailable: Bool,
        onUseExistingKey: @escaping (String) -> Bool,
        onGenerateNewKey: @escaping () -> GeneratedBackup?,
        onRestoreFromBackupFile: @escaping (Data) async throws -> Void,
        onRestoreFromCloud: @escaping (String) async throws -> Void,
        onEnableNotifications: @escaping () async throws -> Void,
        onComplete: @escaping () -> Void
    ) {
        self.pushSupported = pushSupported
        self.pushConfigured = pushConfigured
        self.cloudRestoreAvailable = cloudRestoreAvailable
        _viewModel = StateObject(
            wrappedValue: FirstRunOnboardingViewModel(
                onUseExistingKey: onUseExistingKey,
                onGenerateNewKey: onGenerateNewKey,
                onRestoreFromBackupFile: onRestoreFromBackupFile,
                onRestoreFromCloud: onRestoreFromCloud,
                onEnableNotifications: onEnableNotifications,
                onComplete: onComplete
            )
        )
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Welcome to Taskify")
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                    Text("Choose how you want to get started.")
                        .font(.subheadline)
                        .foregroundStyle(ThemeColors.textSecondary)
                }

                content
            }
            .padding(24)
        }
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(ThemeColors.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(ThemeColors.surfaceBorder.opacity(0.26), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.12), radius: 30, y: 18)
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.json],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task {
                    do {
                        let granted = url.startAccessingSecurityScopedResource()
                        defer {
                            if granted {
                                url.stopAccessingSecurityScopedResource()
                            }
                        }
                        let data = try Data(contentsOf: url)
                        await viewModel.restoreFromBackupFile(data: data)
                    } catch {
                        await viewModel.restoreFromBackupFile(data: Data())
                    }
                }
            case .failure:
                break
            }
        }
        .fileExporter(
            isPresented: $showFileExporter,
            document: PrivateKeyTextDocument(text: viewModel.createdNsec),
            contentType: .plainText,
            defaultFilename: "taskify-nsec"
        ) { result in
            switch result {
            case .success:
                viewModel.noteSavedNsecFile()
            case .failure:
                viewModel.noteUnableToSaveNsecFile()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.page {
        case .home:
            VStack(spacing: 12) {
                onboardingChoice(
                    title: "Sign in with nsec",
                    subtitle: "Use an existing Taskify or Nostr private key.",
                    prominent: true
                ) {
                    viewModel.openSignIn()
                }

                onboardingChoice(
                    title: "Create new login",
                    subtitle: "Generate a new Taskify account and back up the nsec immediately."
                ) {
                    viewModel.openCreate()
                }

                onboardingChoice(
                    title: "Restore from backup",
                    subtitle: "Import a Taskify backup file to recover your account key."
                ) {
                    viewModel.openRestore()
                }
            }

        case .signIn:
            VStack(alignment: .leading, spacing: 16) {
                pageHeader(title: "Sign in with nsec")

                TextField("nsec1... or 64-character key", text: $viewModel.existingKeyInput)
                    .textFieldStyle(.plain)
                    .platformNoAutoCaps()
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(fieldBackground)

                HStack(spacing: 12) {
                    Button("Paste Key") {
                        if let value = PlatformServices.readPasteboardString() {
                            viewModel.existingKeyInput = value
                        }
                    }
                    .buttonStyle(.bordered)

                    Button("Continue") {
                        _ = viewModel.submitExistingKey()
                    }
                    .buttonStyle(.borderedProminent)
                }

                if let error = viewModel.signInError {
                    errorText(error)
                }

                Button("Back") {
                    viewModel.goHome()
                }
                .buttonStyle(.bordered)
            }

        case .create:
            VStack(alignment: .leading, spacing: 16) {
                pageHeader(title: "Create new login")

                Text("This private key acts as your password to Taskify. Store it somewhere safe like a password manager.")
                    .font(.subheadline)
                    .foregroundStyle(ThemeColors.textSecondary)

                ScrollView(.horizontal, showsIndicators: false) {
                    Text(viewModel.createdNsec.isEmpty ? "Generating key..." : viewModel.createdNsec)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(ThemeColors.textPrimary)
                        .textSelection(.enabled)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(fieldBackground)

                HStack(spacing: 12) {
                    Button("Copy nsec") {
                        if viewModel.createdNsec.isEmpty {
                            viewModel.noteUnableToCopyNsec()
                            return
                        }
                        PlatformServices.copyToPasteboard(viewModel.createdNsec)
                        PlatformServices.notificationSuccess()
                        viewModel.noteCopiedNsec()
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.createdNsec.isEmpty)

                    Button("Save to file") {
                        showFileExporter = true
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.createdNsec.isEmpty)
                }

                if let message = viewModel.createMessage {
                    helperText(message)
                }

                if let error = viewModel.createError {
                    errorText(error)
                }

                HStack(spacing: 12) {
                    Button("Back") {
                        viewModel.goHome()
                    }
                    .buttonStyle(.bordered)

                    Button("Continue") {
                        viewModel.continueFromCreatedLogin()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.createdNsec.isEmpty)
                }
            }

        case .restore:
            VStack(alignment: .leading, spacing: 16) {
                pageHeader(title: "Restore from backup")

                VStack(alignment: .leading, spacing: 10) {
                    Text("Restore from file")
                        .font(.headline)
                    Text("The native app imports the Taskify account key from a PWA backup file now. Full local backup payload restore is still pending.")
                        .font(.subheadline)
                        .foregroundStyle(ThemeColors.textSecondary)

                    Button(viewModel.restoreBusy == .file ? "Restoring..." : "Choose backup file") {
                        showFileImporter = true
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.restoreBusy != nil)
                }
                .padding(18)
                .background(cardBackground)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Restore from cloud")
                        .font(.headline)
                    TextField("nsec1... or 64-character key", text: $viewModel.cloudRestoreInput)
                        .textFieldStyle(.plain)
                        .platformNoAutoCaps()
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .background(fieldBackground)
                        .disabled(viewModel.restoreBusy != nil)

                    Button(viewModel.restoreBusy == .cloud ? "Restoring..." : "Restore from cloud") {
                        Task {
                            await viewModel.restoreFromCloud()
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(!cloudRestoreAvailable || viewModel.restoreBusy != nil)

                    if !cloudRestoreAvailable {
                        helperText("Cloud backup service is unavailable in this app build.")
                    }
                }
                .padding(18)
                .background(cardBackground)

                if let error = viewModel.restoreError {
                    errorText(error)
                }

                Button("Back") {
                    viewModel.goHome()
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.restoreBusy != nil)
            }

        case .notifications:
            VStack(alignment: .leading, spacing: 16) {
                pageHeader(title: "Enable reminder notifications?")

                Text("Taskify only sends notifications for reminders you create on tasks or events. Taskify never sends unsolicited notifications.")
                    .font(.subheadline)
                    .foregroundStyle(ThemeColors.textSecondary)

                if !pushSupported {
                    helperText("This device does not support notification permissions. You can still use Taskify normally.")
                }

                if pushSupported && !pushConfigured {
                    helperText("Notifications are not fully configured in this app build yet. You can enable them later in Settings when available.")
                }

                if let error = viewModel.notificationError {
                    errorText(error)
                }

                HStack(spacing: 12) {
                    Button("Not now") {
                        viewModel.completeOnboarding()
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.notificationBusy)

                    Button(viewModel.notificationBusy ? "Enabling..." : "Enable notifications") {
                        Task {
                            await viewModel.enableNotifications(
                                pushSupported: pushSupported,
                                pushConfigured: pushConfigured
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.notificationBusy)
                }
            }
        }
    }

    private func pageHeader(title: String) -> some View {
        Text(title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(ThemeColors.textPrimary)
    }

    private func onboardingChoice(
        title: String,
        subtitle: String,
        prominent: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(prominent ? Color.white : ThemeColors.textPrimary)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(prominent ? Color.white.opacity(0.82) : ThemeColors.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(prominent ? ThemeColors.accent(for: accent) : ThemeColors.surfaceRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(
                        prominent ? ThemeColors.accent(for: accent).opacity(0.22) : ThemeColors.surfaceBorder.opacity(0.22),
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
    }

    private func helperText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(ThemeColors.textSecondary)
    }

    private func errorText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(ThemeColors.danger)
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(ThemeColors.surfaceRaised)
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(ThemeColors.surfaceBorder.opacity(0.22), lineWidth: 1)
            )
    }

    private var fieldBackground: some View {
        RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(ThemeColors.surfaceRaised)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(ThemeColors.surfaceBorder.opacity(0.28), lineWidth: 1)
            )
    }
}

private struct PrivateKeyTextDocument: FileDocument {
    static var readableContentTypes: [UTType] = [.plainText]

    var text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        if let data = configuration.file.regularFileContents,
           let value = String(data: data, encoding: .utf8) {
            text = value
        } else {
            text = ""
        }
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data((text + "\n").utf8))
    }
}
