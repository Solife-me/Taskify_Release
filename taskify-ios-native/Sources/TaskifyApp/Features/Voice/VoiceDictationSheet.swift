import SwiftUI
import TaskifyCore

/// Speak freely, get tasks. Port of the PWA's `VoiceDictationModal`: on-device speech becomes a
/// transcript, the transcript goes to the Worker's extraction endpoint, and what comes back is a
/// reviewable list of candidate tasks the user confirms before anything is written.
///
/// The interesting behavior -- how spoken corrections ("actually make that Thursday", "scratch
/// that") fold into the candidate list -- lives in `VoiceSessionState` in TaskifyCore, where it is
/// unit tested. This view is the shell around it.
struct VoiceDictationSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var recognizer = SpeechDictationRecognizer()
    @State private var session = VoiceSessionState()
    @State private var statusMessage: String?
    @State private var didExtractForCurrentSpeech = false
    @State private var listeningStartedAt = Date()
    @State private var isSaving = false
    @State private var canRetryExtraction = false
    @State private var extractionDurationSeconds: Int?

    @State private var approvals: [VoiceTaskApproval] = []
    @State private var selectedApprovalIDs: Set<String> = []
    @State private var pendingCandidates: [VoiceTaskCandidate]?
    @State private var referenceDate = Date()
    @State private var defaultBoardID: String?
    @State private var didAutoStart = false

    private let client = VoiceDictationClient()

    private var confirmedCount: Int { approvals.filter { selectedApprovalIDs.contains($0.id) }.count }

    private var saveLabel: String {
        switch confirmedCount {
        case 0: return "Save Tasks"
        case 1: return "Save 1 Task"
        default: return "Save \(confirmedCount) Tasks"
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TaskifyTheme.background.ignoresSafeArea()

                VStack(spacing: 16) {
                    availabilityBanner
                    transcriptCard
                    candidateList
                    Spacer(minLength: 0)
                    footer
                }
                .padding(20)
            }
            .navigationTitle("Voice Add Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .disabled(recognizer.isListening || isSaving)
                }
            }
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled(recognizer.isListening || isSaving)
        .task {
            wireRecognizer()
            defaultBoardID = model.selectedBoardID
            await recognizer.requestAuthorization()
            guard !Task.isCancelled, !didAutoStart else { return }
            didAutoStart = true
            if recognizer.isAvailable { toggleListening() }
        }
        .onDisappear {
            recognizer.stop()
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var availabilityBanner: some View {
        switch recognizer.availability {
        case .denied(let message), .unsupported(let message):
            banner(message, systemImage: "exclamationmark.triangle.fill", tint: .orange)
        case .ready, .unknown:
            if session.quotaExhausted {
                banner(
                    "Daily voice limit reached. Any tasks already found are shown below.",
                    systemImage: "hourglass",
                    tint: .orange
                )
            }
        }
    }

    private func banner(_ text: String, systemImage: String, tint: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(TaskifyTheme.primaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(tint.opacity(0.18), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(tint.opacity(0.4))
            )
    }

    private var transcriptCard: some View {
        ScrollView {
            Group {
                if session.transcript.isEmpty && session.interimTranscript.isEmpty {
                    Text(recognizer.isListening ? "Listening…" : "Tap the mic and say what you need to do.")
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .italic()
                } else {
                    (
                        Text(session.transcript)
                            .foregroundStyle(TaskifyTheme.primaryText)
                        + Text(session.transcript.isEmpty ? "" : " ")
                        + Text(session.interimTranscript)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                            .italic()
                    )
                }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: 96)
        .padding(16)
        .taskifyGlass(cornerRadius: 22)
    }

    @ViewBuilder
    private var candidateList: some View {
        if session.isProcessing {
            ProgressView().controlSize(.large).tint(TaskifyTheme.accent)
                .frame(maxWidth: .infinity).padding(.top, 24)
        } else if !approvals.isEmpty {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(approvals) { approval in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Button {
                                    if !selectedApprovalIDs.insert(approval.id).inserted {
                                        selectedApprovalIDs.remove(approval.id)
                                    }
                                } label: {
                                    Label(selectedApprovalIDs.contains(approval.id) ? "Include task" : "Exclude task",
                                          systemImage: selectedApprovalIDs.contains(approval.id) ? "checkmark.circle.fill" : "circle")
                                }
                                .buttonStyle(.plain)
                                Spacer()
                                if let board = model.board(withID: approval.task.boardID) {
                                    Text(board.name).foregroundStyle(TaskifyTheme.secondaryText)
                                }
                            }
                            .font(.caption)
                            // The actual board card, populated by the same creation routine as Save.
                            TaskCardView(task: approval.task)
                                .allowsHitTesting(false)
                        }
                        .opacity(selectedApprovalIDs.contains(approval.id) ? 1 : 0.55)
                    }
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 12) {
            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if canRetryExtraction && !recognizer.isListening && !session.isProcessing {
                Button("Retry finding tasks") {
                    Task { await extractIfNeeded() }
                }
                .accessibilityIdentifier("voice.retryExtraction")
            }

            HStack(spacing: 14) {
                Button {
                    toggleListening()
                } label: {
                    Image(systemName: recognizer.isListening ? "stop.fill" : "mic.fill")
                        .font(.title2)
                        .frame(width: 58, height: 58)
                        .foregroundStyle(.white)
                        .taskifyGlassControl(
                            in: Circle(),
                            tint: recognizer.isListening ? Color.red.opacity(0.8) : TaskifyTheme.accent.opacity(0.78)
                        )
                        .symbolEffect(.pulse, isActive: recognizer.isListening)
                }
                .buttonStyle(.plain)
                .disabled(!recognizer.isAvailable || isSaving || session.isProcessing)
                .accessibilityLabel(recognizer.isListening ? "Stop recording" : "Start recording")

                if recognizer.isListening {
                    Label("Listening…", systemImage: "waveform")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(TaskifyTheme.accent)
                } else if session.isProcessing {
                    Label("Finding tasks…", systemImage: "sparkles")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }

                Spacer(minLength: 0)

                Button {
                    Task { await save() }
                } label: {
                    Text(isSaving ? "Saving…" : saveLabel)
                        .font(.headline)
                        .padding(.horizontal, 18)
                        .frame(height: 48)
                        .foregroundStyle(.white)
                        .taskifyGlassControl(in: Capsule(), tint: TaskifyTheme.accent.opacity(0.78))
                }
                .buttonStyle(.plain)
                .disabled(confirmedCount == 0 || session.isProcessing || isSaving || recognizer.isListening)
                .opacity(confirmedCount == 0 ? 0.45 : 1)
            }
        }
    }

    // MARK: - Behavior

    private func wireRecognizer() {
        recognizer.onCommit = { text in
            session.commitTranscript(text)
        }
        recognizer.onInterim = { text in
            session.interimTranscript = text
        }
        recognizer.onError = { message in
            statusMessage = message
        }
    }

    private func toggleListening() {
        if recognizer.isListening {
            recognizer.stop()
            Task { await extractIfNeeded() }
        } else {
            statusMessage = nil
            session.quotaExhausted = false
            didExtractForCurrentSpeech = false
            canRetryExtraction = false
            pendingCandidates = nil
            approvals = []
            selectedApprovalIDs = []
            if session.combinedTranscript().isEmpty { referenceDate = Date() }
            extractionDurationSeconds = nil
            listeningStartedAt = Date()
            recognizer.start()
        }
    }

    /// Runs one extraction pass over everything said so far. Guarded so that stopping the mic and
    /// dismissing the sheet don't each fire their own request for the same speech.
    private func extractIfNeeded() async {
        guard !didExtractForCurrentSpeech else { return }
        let transcript = session.combinedTranscript()
        guard !transcript.isEmpty else { return }

        guard let identity = try? KeychainIdentityStore().load() else {
            statusMessage = "Set up your Taskify identity in Settings before using voice."
            return
        }

        didExtractForCurrentSpeech = true
        canRetryExtraction = false
        statusMessage = nil
        if extractionDurationSeconds == nil {
            extractionDurationSeconds = max(0, Int(Date().timeIntervalSince(listeningStartedAt).rounded()))
        }
        session.isProcessing = true
        defer { session.isProcessing = false }

        do {
            let candidates: [VoiceTaskCandidate]
            if let pendingCandidates {
                candidates = pendingCandidates
            } else {
                let result = try await client.extract(
                    identity: identity, transcript: transcript, candidates: session.candidates,
                    sessionDurationSeconds: extractionDurationSeconds ?? 0
                )
                session.quotaExhausted = result.quotaExhausted
                // Extraction describes the full transcript, so rebuild rather than duplicating earlier tasks.
                session.candidates = []
                session.apply(result.operations)
                candidates = session.confirmedCandidates
                pendingCandidates = candidates
            }
            guard !candidates.isEmpty else {
                statusMessage = session.quotaExhausted ? nil : "Couldn't find any tasks. Try recording a little more detail."
                return
            }
            let finalTasks = try await client.finalizeForPreview(
                identity: identity, candidates: candidates, boardID: defaultBoardID,
                boards: model.voiceBoardContexts(), now: referenceDate
            )
            approvals = finalTasks.compactMap { finalTask in
                guard let task = model.previewVoiceTasks([finalTask], defaultBoardID: defaultBoardID, referenceDate: referenceDate).first else { return nil }
                return VoiceTaskApproval(id: task.id, finalTask: finalTask, task: task)
            }
            selectedApprovalIDs = Set(approvals.map(\.id))
            statusMessage = approvals.count == finalTasks.count ? nil : "Some tasks couldn't be placed on an available board."
        } catch {
            // Let the user retry rather than losing the transcript they just dictated.
            didExtractForCurrentSpeech = false
            canRetryExtraction = true
            statusMessage = VoiceDictationClient.message(for: error)
        }
    }

    private func save() async {
        let confirmed = approvals.filter { selectedApprovalIDs.contains($0.id) }
        guard !confirmed.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        let created = model.addTasksFromVoice(
            confirmed.map(\.finalTask), defaultBoardID: defaultBoardID, referenceDate: referenceDate
        )

        guard created > 0 else {
            statusMessage = "Couldn't add those to this board. Try a week or list board."
            return
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }
}

/// Cached finalized values are both rendered for approval and submitted unchanged.
private struct VoiceTaskApproval: Identifiable {
    let id: String
    let finalTask: VoiceFinalTask
    let task: TaskItem
}
