import SwiftUI
import TaskifyCore
import UIKit

enum TaskShareMode: String, CaseIterable, Identifiable {
    case share = "Share"
    case assignment = "Assign"

    var id: String { rawValue }

    var explanation: String {
        switch self {
        case .share:
            "The recipient can review this task and add a separate copy to one of their boards."
        case .assignment:
            "The recipient can accept, decline, or choose maybe. Their response will update this task."
        }
    }
}

struct TaskShareSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let taskID: String
    @State private var mode: TaskShareMode
    @State private var recipient = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var result: SharedTaskSendResult?
    @FocusState private var recipientFocused: Bool

    init(taskID: String, initialMode: TaskShareMode = .share) {
        self.taskID = taskID
        _mode = State(initialValue: initialMode)
    }

    private var task: TaskItem? { model.task(withID: taskID) }
    private var recipientIsValid: Bool { NostrPublicKey.parse(recipient) != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Send as", selection: $mode) {
                        ForEach(TaskShareMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    Text(mode.explanation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Recipient") {
                    TextField("npub or public key", text: $recipient, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(2...4)
                        .font(.system(.callout, design: .monospaced))
                        .focused($recipientFocused)
                        .submitLabel(.send)
                        .onSubmit(send)

                    if !recipient.isEmpty {
                        Label(
                            recipientIsValid ? "Valid Nostr recipient" : "Enter a valid npub or 64-character public key",
                            systemImage: recipientIsValid ? "checkmark.circle.fill" : "exclamationmark.circle"
                        )
                        .font(.caption)
                        .foregroundStyle(recipientIsValid ? Color.green : Color.orange)
                    }
                }

                if !matchingContacts.isEmpty {
                    Section("Contacts") {
                        ForEach(matchingContacts.prefix(8)) { contact in
                            Button {
                                recipient = contact.npub
                                errorMessage = nil
                                result = nil
                            } label: {
                                HStack(spacing: 12) {
                                    NostrContactAvatar(contact: contact, size: 38)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(contact.displayName)
                                            .foregroundStyle(TaskifyTheme.primaryText)
                                        Text(contact.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    if contact.publicKey == NostrPublicKey.parse(recipient)?.hexString {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(TaskifyTheme.accent)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !model.recentSharedTaskRecipients.isEmpty {
                    Section("Recent recipients") {
                        ForEach(model.recentSharedTaskRecipients.prefix(6)) { recent in
                            Button {
                                recipient = recent.npub
                                errorMessage = nil
                                result = nil
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "person.crop.circle")
                                        .font(.title3)
                                        .foregroundStyle(TaskifyTheme.accent)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(recent.shortDisplayName)
                                            .foregroundStyle(TaskifyTheme.primaryText)
                                        Text("\(recent.relayURLs.count) delivery relay\(recent.relayURLs.count == 1 ? "" : "s")")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if recent.publicKey == NostrPublicKey.parse(recipient)?.hexString {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(TaskifyTheme.accent)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let task {
                    Section("Task preview") {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(task.title)
                                .font(.headline)
                            if !task.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(task.note)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                            }
                            HStack(spacing: 12) {
                                if task.dueDateEnabled, let dueDate = task.dueDate {
                                    Label(
                                        dueDate.formatted(.dateTime.month(.abbreviated).day()),
                                        systemImage: "calendar"
                                    )
                                }
                                if let subtasks = task.subtasks, !subtasks.isEmpty {
                                    Label("\(subtasks.count)", systemImage: "checklist")
                                }
                                if let documents = task.documents, !documents.isEmpty {
                                    Label("\(documents.count)", systemImage: "paperclip")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 3)
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }

                if let result {
                    Section {
                        Label(
                            result.assignment
                                ? "Assignment queued securely"
                                : "Task queued securely",
                            systemImage: "checkmark.circle.fill"
                        )
                        .foregroundStyle(.green)
                        Text("Taskify selected \(result.relayCount) relay\(result.relayCount == 1 ? "" : "s") for encrypted delivery.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Send Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(result == nil ? "Cancel" : "Done") { dismiss() }
                        .disabled(isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: send) {
                        if isSending {
                            ProgressView()
                        } else {
                            Text(mode == .assignment ? "Assign" : "Send")
                        }
                    }
                    .disabled(!recipientIsValid || task == nil || isSending || result != nil)
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .interactiveDismissDisabled(isSending)
        .onChange(of: mode) { _, _ in
            errorMessage = nil
            result = nil
        }
        .onChange(of: recipient) { _, _ in
            errorMessage = nil
            result = nil
        }
        .task {
            if recipient.isEmpty { recipientFocused = true }
        }
    }

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

    private func send() {
        guard recipientIsValid, task != nil, !isSending, result == nil else { return }
        recipientFocused = false
        isSending = true
        errorMessage = nil
        Task { @MainActor in
            do {
                result = try await model.sendSharedTask(
                    taskID: taskID,
                    recipientValue: recipient,
                    assignment: mode == .assignment
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSending = false
        }
    }
}
