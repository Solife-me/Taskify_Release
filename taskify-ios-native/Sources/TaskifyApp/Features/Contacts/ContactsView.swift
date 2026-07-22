import SwiftUI
import TaskifyCore
import UIKit

struct NostrContactsDirectoryView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var editingContact: NostrContact?
    @State private var showingNewContact = false
    @State private var deletingContact: NostrContact?

    private var filteredContacts: [NostrContact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.nostrContacts }
        return model.nostrContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                Text("Contacts")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(TaskifyTheme.primaryText)

                Spacer()

                TaskifyGlassControlGroup(spacing: 8) {
                    HeaderIconButton(
                        systemName: "arrow.clockwise",
                        accessibilityLabel: "Refresh contacts"
                    ) {
                        model.refreshContacts()
                    }
                    .disabled(model.isRefreshingContacts)

                    HeaderIconButton(
                        systemName: "person.badge.plus",
                        accent: true,
                        accessibilityLabel: "Add contact"
                    ) {
                        showingNewContact = true
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    contactHeader

                    if model.nostrContacts.isEmpty {
                        emptyState
                    } else if filteredContacts.isEmpty {
                        ContentUnavailableView.search(text: searchText)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 50)
                    } else {
                        LazyVStack(spacing: 10) {
                            ForEach(filteredContacts) { contact in
                                NavigationLink {
                                    NostrContactDetailView(contactPublicKey: contact.publicKey)
                                        .environmentObject(model)
                                } label: {
                                    NostrContactRow(contact: contact)
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button {
                                        UIPasteboard.general.string = contact.npub
                                    } label: {
                                        Label("Copy npub", systemImage: "doc.on.doc")
                                    }
                                    Button {
                                        editingContact = contact
                                    } label: {
                                        Label("Edit Contact", systemImage: "pencil")
                                    }
                                    Button(role: .destructive) {
                                        deletingContact = contact
                                    } label: {
                                        Label("Delete Contact", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }

                    Text("Private contacts are encrypted to your Nostr identity and synced using the same NIP-51 list as the PWA. Public profile details are read from signed Nostr profiles.")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .padding(.horizontal, 4)
                        .padding(.bottom, 18)
                }
                .padding(.horizontal, 18)
            }
                .scrollIndicators(.hidden)
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .searchable(text: $searchText, prompt: "Search contacts")
        }
        .sheet(isPresented: $showingNewContact) {
            NostrContactEditorSheet()
                .environmentObject(model)
        }
        .sheet(item: $editingContact) { contact in
            NostrContactEditorSheet(contact: contact)
                .environmentObject(model)
        }
        .alert(
            "Delete Contact?",
            isPresented: Binding(
                get: { deletingContact != nil },
                set: { if !$0 { deletingContact = nil } }
            ),
            presenting: deletingContact
        ) { contact in
            Button("Delete", role: .destructive) {
                Task {
                    do {
                        try await model.deleteNostrContact(publicKey: contact.publicKey)
                    } catch {
                        model.errorMessage = error.localizedDescription
                    }
                }
                deletingContact = nil
            }
            Button("Cancel", role: .cancel) { deletingContact = nil }
        } message: { contact in
            Text("\(contact.displayName) will be removed from the private contact list on your relays and the PWA.")
        }
        .task {
            model.refreshContactsIfNeeded()
        }
    }

    private var contactHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Contacts", systemImage: "person.2.fill")
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.primaryText)
                Spacer()
                if model.isRefreshingContacts {
                    ProgressView()
                        .controlSize(.small)
                } else if !model.nostrContacts.isEmpty {
                    Text("\(model.nostrContacts.count)")
                        .font(.caption.bold())
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(TaskifyTheme.raisedFill, in: Capsule())
                }
            }
            Text(model.contactSyncStatus)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .padding(16)
        .taskifyGlass(cornerRadius: 22)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.2.badge.plus")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(TaskifyTheme.accent)
            Text("Build your contact list")
                .font(.headline)
            Text("Contacts from the PWA will appear here automatically. You can also add someone with their npub and use them for task sharing and assignments.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)
                .multilineTextAlignment(.center)
            Button {
                showingNewContact = true
            } label: {
                Label("Add Contact", systemImage: "plus")
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 26)
        .padding(.vertical, 42)
        .taskifyGlass(cornerRadius: 24)
    }
}

struct NostrContactAvatar: View {
    let contact: NostrContact
    var size: CGFloat = 46

    var body: some View {
        Group {
            if let url = contact.pictureURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initials
                    }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(TaskifyTheme.border, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private var initials: some View {
        ZStack {
            Circle().fill(TaskifyTheme.accent.opacity(0.22))
            Text(contact.initials)
                .font(.system(size: size * 0.34, weight: .semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
        }
    }
}

private struct NostrContactRow: View {
    let contact: NostrContact

    var body: some View {
        HStack(spacing: 13) {
            NostrContactAvatar(contact: contact)
            VStack(alignment: .leading, spacing: 3) {
                Text(contact.displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .lineLimit(1)
                Text(contact.subtitle)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.tertiaryText)
        }
        .padding(14)
        .taskifyGlass(cornerRadius: 20)
        .contentShape(Rectangle())
    }
}

private struct NostrContactDetailView: View {
    @EnvironmentObject private var model: AppModel
    let contactPublicKey: String

    private var contact: NostrContact? {
        model.nostrContacts.first { $0.publicKey == contactPublicKey }
    }

    var body: some View {
        ScrollView {
            if let contact {
                VStack(spacing: 18) {
                    NostrContactAvatar(contact: contact, size: 88)
                    VStack(spacing: 5) {
                        Text(contact.displayName)
                            .font(.title2.bold())
                        Text(contact.subtitle)
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        contactField("Nostr public key", value: contact.npub, icon: "key")
                        if let nip05 = contact.profile?.nip05 {
                            contactField("NIP-05", value: nip05, icon: "checkmark.seal")
                        }
                        if let lud16 = contact.profile?.lud16 {
                            contactField("Lightning", value: lud16, icon: "bolt")
                        }
                        if let about = contact.profile?.about {
                            contactField("About", value: about, icon: "person.text.rectangle")
                        }
                        if !contact.relayURLs.isEmpty {
                            contactField(
                                "Delivery relays",
                                value: contact.relayURLs.joined(separator: "\n"),
                                icon: "dot.radiowaves.left.and.right"
                            )
                        }
                    }
                    .padding(18)
                    .taskifyGlass(cornerRadius: 24)

                    Button {
                        UIPasteboard.general.string = contact.npub
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: {
                        Label("Copy npub", systemImage: "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                .padding(18)
            }
        }
        .background(TaskifyTheme.background.ignoresSafeArea())
        .navigationTitle("Contact")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func contactField(_ label: String, value: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .textSelection(.enabled)
            }
            Spacer()
        }
    }
}

private struct NostrContactEditorSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    private let existingContact: NostrContact?

    @State private var publicKeyValue: String
    @State private var nickname: String
    @State private var relayURL: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(contact: NostrContact? = nil) {
        existingContact = contact
        _publicKeyValue = State(initialValue: contact?.npub ?? "")
        _nickname = State(initialValue: contact?.petname ?? "")
        _relayURL = State(initialValue: contact?.relayURLs.first ?? "")
    }

    private var keyIsValid: Bool {
        NostrPublicKey.parse(publicKeyValue) != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Nostr contact") {
                    TextField("npub or public key", text: $publicKeyValue, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(2...4)
                        .disabled(existingContact != nil)
                    TextField("Nickname (optional)", text: $nickname)
                    TextField("Relay hint (optional)", text: $relayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                Section {
                    Label(
                        keyIsValid ? "Valid Nostr public key" : "Enter a valid npub or public key",
                        systemImage: keyIsValid ? "checkmark.circle.fill" : "exclamationmark.circle"
                    )
                    .foregroundStyle(keyIsValid ? Color.green : Color.orange)

                    Text("Taskify discovers the contact's preferred NIP-17 inbox relays automatically and encrypts the saved list to your identity.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle(existingContact == nil ? "New Contact" : "Edit Contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: {
                        if isSaving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(!keyIsValid || isSaving)
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .interactiveDismissDisabled(isSaving)
    }

    private func save() {
        guard keyIsValid, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                _ = try await model.saveNostrContact(
                    publicKeyValue: publicKeyValue,
                    petname: nickname,
                    relayURL: relayURL
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                isSaving = false
            }
        }
    }
}
