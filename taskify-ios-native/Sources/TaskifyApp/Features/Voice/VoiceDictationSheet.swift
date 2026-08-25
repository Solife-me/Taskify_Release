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

    private let client = VoiceDictationClient()

    private var confirmedCount: Int { session.confirmedCandidates.count }

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
            await recognizer.requestAuthorization()
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
        let visible = session.visibleCandidates
        if !visible.isEmpty {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(visible) { candidate in
                        candidateCard(candidate)
                    }
                }
            }
        } else if session.isProcessing {
            ProgressView()
                .controlSize(.large)
                .tint(TaskifyTheme.accent)
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
        }
    }

    private func candidateCard(_ candidate: VoiceTaskCandidate) -> some View {
        let isConfirmed = candidate.status == .confirmed

        return HStack(alignment: .top, spacing: 12) {
            Button {
                toggle(candidate)
            } label: {
                Image(systemName: isConfirmed ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isConfirmed ? TaskifyTheme.accent : TaskifyTheme.tertiaryText)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isConfirmed ? "Deselect \(candidate.title)" : "Select \(candidate.title)")

            VStack(alignment: .leading, spacing: 4) {
                Text(candidate.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                if let dueText = candidate.dueText, !dueText.isEmpty {
                    Label(dueText, systemImage: "calendar")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }
                if let subtasks = candidate.subtasks, !subtasks.isEmpty {
                    ForEach(Array(subtasks.enumerated()), id: \.offset) { _, subtask in
                        Label(subtask, systemImage: "circle.fill")
                            .font(.caption2)
                            .labelStyle(SubtaskBulletLabelStyle())
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                dismissCandidate(candidate)
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.tertiaryText)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(candidate.title)")
        }
        .padding(16)
        .taskifyGlass(cornerRadius: 20)
        .opacity(isConfirmed ? 1 : 0.55)
    }

    private var footer: some View {
        VStack(spacing: 12) {
            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
                .disabled(!recognizer.isAvailable || isSaving)
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
            listeningStartedAt = Date()
            recognizer.start()
        }
    }

    private func toggle(_ candidate: VoiceTaskCandidate) {
        guard let index = session.candidates.firstIndex(where: { $0.id == candidate.id }) else { return }
        session.candidates[index].status = candidate.status == .confirmed ? .draft : .confirmed
    }

    private func dismissCandidate(_ candidate: VoiceTaskCandidate) {
        guard let index = session.candidates.firstIndex(where: { $0.id == candidate.id }) else { return }
        withAnimation(.easeInOut(duration: 0.2)) {
            session.candidates[index].status = .dismissed
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
        session.isProcessing = true
        defer { session.isProcessing = false }

        do {
            let result = try await client.extract(
                identity: identity,
                transcript: transcript,
                candidates: session.candidates,
                sessionDurationSeconds: Int(Date().timeIntervalSince(listeningStartedAt).rounded())
            )
            session.quotaExhausted = result.quotaExhausted
            session.apply(result.operations)

            if session.visibleCandidates.isEmpty && !result.quotaExhausted {
                statusMessage = "Couldn't find any tasks in that. Try again with something like \"remind me to call Ana tomorrow\"."
            } else {
                statusMessage = nil
            }
        } catch {
            // Let the user retry rather than losing the transcript they just dictated.
            didExtractForCurrentSpeech = false
            statusMessage = VoiceDictationClient.message(for: error)
        }
    }

    private func save() async {
        let confirmed = session.confirmedCandidates
        guard !confirmed.isEmpty else { return }

        isSaving = true
        defer { isSaving = false }

        guard let identity = try? KeychainIdentityStore().load() else {
            statusMessage = "Set up your Taskify identity in Settings before using voice."
            return
        }
        let finalTasks = await client.finalize(
            identity: identity,
            candidates: confirmed,
            boardID: model.selectedBoardID
        )
        let created = model.addTasksFromVoice(finalTasks)

        guard created > 0 else {
            statusMessage = "Couldn't add those to this board. Try a week or list board."
            return
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }
}

/// Small filled dot instead of SF Symbols' default sizing, so subtask bullets stay visually quiet.
private struct SubtaskBulletLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon
                .font(.system(size: 4))
            configuration.title
        }
    }
}

extension VoiceDictationClient {
    static func message(for error: Error) -> String {
        if let voiceError = error as? VoiceDictationError, let description = voiceError.errorDescription {
            return description
        }
        return "Couldn't reach Taskify to find tasks. Check your connection and try again."
    }
}
