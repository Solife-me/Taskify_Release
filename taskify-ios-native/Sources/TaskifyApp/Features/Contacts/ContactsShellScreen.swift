import CoreImage.CIFilterBuiltins
import SwiftUI
import TaskifyCore

#if os(iOS) && canImport(UIKit) && canImport(VisionKit)
import UIKit
import VisionKit
#endif

struct ContactsShellScreen: View {
    let profile: TaskifyProfile

    @EnvironmentObject private var dataController: DataController
    @EnvironmentObject private var settingsManager: SettingsManager
    @StateObject private var viewModel = ContactsViewModel()

    @State private var searchText = ""
    @State private var showAddSheet = false
    @State private var showProfileSheet = false
    @State private var activeDetail: ContactPresentation?
    @State private var editingContact: TaskifyContactRecord?
    @State private var didInitialLoad = false
    @State private var verificationTask: Task<Void, Never>?

    private var myCard: TaskifyContactRecord {
        let metadata = dataController.myProfileMetadata
        return TaskifyContactRecord(
            id: "profile",
            kind: .nostr,
            name: metadata.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? (sanitizeUsername(metadata.username).isEmpty ? profile.name : sanitizeUsername(metadata.username))
                : metadata.displayName,
            address: metadata.lud16,
            paymentRequest: "",
            npub: profile.npub,
            username: metadata.username.isEmpty ? nil : metadata.username,
            displayName: metadata.displayName.isEmpty ? nil : metadata.displayName,
            nip05: metadata.nip05.isEmpty ? nil : metadata.nip05,
            about: metadata.about.isEmpty ? nil : metadata.about,
            picture: metadata.picture.isEmpty ? nil : metadata.picture,
            relays: profile.relays,
            createdAt: metadata.updatedAt ?? 0,
            updatedAt: metadata.updatedAt ?? 0,
            source: .profile
        )
    }

    private var filteredContacts: [TaskifyContactRecord] {
        viewModel.filteredContacts(searchText: searchText)
    }

    private var contactsSyncEnabled: Bool {
        settingsManager.settings.walletContactsSyncEnabled
    }

    private var syncStatusTitle: String {
        switch dataController.contactSyncState.status {
        case .loading:
            return "Syncing contacts"
        case .success:
            return "Contacts synced"
        case .error:
            return "Sync needs attention"
        case .idle:
            return contactsSyncEnabled ? "Contacts ready to sync" : "Contacts stored locally"
        }
    }

    private var syncStatusMessage: String {
        if !contactsSyncEnabled {
            return "Contacts stay on this device until contact sync is enabled. Nostr follows and private contacts will not publish."
        }
        if let message = dataController.contactSyncState.message,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }
        if let updatedAt = dataController.contactSyncState.updatedAt {
            let date = Date(timeIntervalSince1970: TimeInterval(updatedAt) / 1000)
            return "Last updated \(date.formatted(date: .abbreviated, time: .shortened))."
        }
        return "Pull private contacts and publish public follows over Nostr."
    }

    private var syncStatusIcon: String {
        switch dataController.contactSyncState.status {
        case .loading:
            return "arrow.triangle.2.circlepath"
        case .success:
            return "checkmark.icloud"
        case .error:
            return "exclamationmark.icloud"
        case .idle:
            return contactsSyncEnabled ? "icloud" : "icloud.slash"
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch viewModel.state {
                case .loading:
                    ProgressView("Loading contacts…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .error(let message):
                    ContentUnavailableView("Contacts Unavailable", systemImage: "person.crop.circle.badge.exclamationmark", description: Text(message))
                case .empty, .ready:
                    listContent
                }
            }
            .navigationTitle("Contacts")
            .searchable(text: $searchText, prompt: "Search contacts")
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button {
                        showAddSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add contact")
                }
            }
            .task {
                guard !didInitialLoad else { return }
                didInitialLoad = true
                refreshLocalState()
                _ = await dataController.loadMyProfileMetadata()
                if contactsSyncEnabled {
                    _ = await dataController.syncContactsFromNostr(silent: true)
                }
                await dataController.refreshContactProfiles()
                refreshLocalState()
                queueNip05Verification()
            }
            .onChange(of: dataController.contactsVersion) { _, _ in
                refreshLocalState()
                queueNip05Verification()
            }
            .onChange(of: dataController.publicFollowsVersion) { _, _ in refreshLocalState() }
            .onChange(of: dataController.contactNip05ChecksVersion) { _, _ in refreshLocalState() }
            .onChange(of: dataController.myProfileMetadata) { _, _ in
                refreshLocalState()
                queueNip05Verification()
            }
            .onChange(of: settingsManager.settings.walletContactsSyncEnabled) { _, enabled in
                refreshLocalState()
                guard enabled else { return }
                Task {
                    _ = await dataController.syncContactsFromNostr(silent: true)
                    refreshLocalState()
                    queueNip05Verification()
                }
            }
            .onDisappear {
                verificationTask?.cancel()
                verificationTask = nil
            }
            .sheet(isPresented: $showAddSheet) {
                ContactEditorSheet(
                    title: "New Contact",
                    initialDraft: TaskifyContactDraft(kind: .custom, source: .manual),
                    publicFollows: viewModel.importableFollows(),
                    onLookup: { value in
                        try await dataController.lookupContact(reference: value)
                    },
                    onSave: { draft in
                        let saved = await dataController.saveContact(draft, publish: contactsSyncEnabled)
                        refreshLocalState()
                        queueNip05Verification()
                        return saved != nil
                    }
                )
            }
            .sheet(isPresented: $showProfileSheet) {
                ProfileMetadataEditorSheet(
                    initialMetadata: dataController.myProfileMetadata,
                    profileName: profile.name,
                    npub: profile.npub,
                    shareValue: dataController.myContactShareValue(),
                    shareExportValue: dataController.myContactShareEnvelope() ?? dataController.myContactShareValue(),
                    onSave: { metadata in
                        let state = await dataController.publishMyProfileMetadata(metadata)
                        refreshLocalState()
                        return state.status == .success
                    }
                )
            }
            .sheet(item: $editingContact) { contact in
                ContactEditorSheet(
                    title: "Edit Contact",
                    initialDraft: draft(from: contact),
                    publicFollows: viewModel.importableFollows(),
                    onLookup: { value in
                        try await dataController.lookupContact(reference: value)
                    },
                    onSave: { draft in
                        let saved = await dataController.saveContact(draft, publish: contactsSyncEnabled)
                        refreshLocalState()
                        queueNip05Verification()
                        return saved != nil
                    }
                )
            }
            .sheet(item: $activeDetail) { item in
                let subtitle = viewModel.subtitle(for: item.contact, isProfile: item.isProfile)
                ContactDetailSheet(
                    contact: item.contact,
                    subtitle: subtitle,
                    fields: viewModel.fields(for: item.contact),
                    shareDisplayValue: item.isProfile
                        ? dataController.myContactShareValue()
                        : dataController.contactShareValue(contactId: item.contact.id),
                    shareExportValue: item.isProfile
                        ? (dataController.myContactShareEnvelope() ?? dataController.myContactShareValue())
                        : (dataController.contactShareEnvelope(contactId: item.contact.id)
                            ?? dataController.contactShareValue(contactId: item.contact.id)),
                    editLabel: item.isProfile ? "Edit Profile" : "Edit",
                    onEdit: {
                        if item.isProfile {
                            showProfileSheet = true
                        } else {
                            editingContact = item.contact
                        }
                    },
                    canFollow: viewModel.canFollow(item.contact, isProfile: item.isProfile),
                    isFollowed: viewModel.isFollowed(item.contact),
                    onToggleFollow: item.isProfile ? nil : {
                        _ = await dataController.setPublicFollow(
                            contact: item.contact,
                            followed: !viewModel.isFollowed(item.contact),
                            publish: contactsSyncEnabled
                        )
                        refreshLocalState()
                    },
                    onDelete: item.isProfile ? nil : {
                        _ = await dataController.deleteContact(id: item.contact.id, publish: contactsSyncEnabled)
                        refreshLocalState()
                        activeDetail = nil
                    }
                )
                .presentationDetents([.medium, .large])
            }
        }
    }

    private var listContent: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Label(syncStatusTitle, systemImage: syncStatusIcon)
                        .font(.headline)
                    Text(syncStatusMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    if contactsSyncEnabled {
                        HStack(spacing: 12) {
                            Button {
                                Task {
                                    _ = await dataController.syncContactsFromNostr()
                                    refreshLocalState()
                                    queueNip05Verification()
                                }
                            } label: {
                                if dataController.contactSyncState.status == .loading {
                                    ProgressView()
                                        .frame(maxWidth: .infinity)
                                } else {
                                    Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                                        .frame(maxWidth: .infinity)
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(dataController.contactSyncState.status == .loading)

                            Button {
                                Task {
                                    _ = await dataController.publishContactsToNostr()
                                    refreshLocalState()
                                }
                            } label: {
                                Label("Publish", systemImage: "icloud.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .disabled(dataController.contactSyncState.status == .loading)
                        }
                    }
                }
                .padding(.vertical, 6)
            }

            Section {
                Button {
                    activeDetail = ContactPresentation(contact: myCard, isProfile: true)
                } label: {
                    ContactRowView(
                        contact: myCard,
                        subtitle: viewModel.subtitle(for: myCard, isProfile: true)
                            ?? ContactSubtitlePresentation(text: "My Card"),
                        accent: ThemeColors.accent(for: settingsManager.settings.accent)
                    )
                }
                .buttonStyle(.plain)
            } footer: {
                Text("Your profile card shares your current `npub`, relay hints, and profile metadata.")
            }

            Section("Saved Contacts") {
                if filteredContacts.isEmpty {
                    ContentUnavailableView(
                        searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "No Contacts Yet" : "No Matches",
                        systemImage: searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "person.crop.circle.badge.plus"
                            : "magnifyingglass",
                        description: Text(
                            searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? "Import an `npub`, paste a `nip05`, or add a custom contact."
                                : "Try a different search term."
                        )
                    )
                        .padding(.vertical, 16)
                } else {
                    ForEach(filteredContacts) { contact in
                        Button {
                            activeDetail = ContactPresentation(contact: contact, isProfile: false)
                        } label: {
                            ContactRowView(
                                contact: contact,
                                subtitle: viewModel.subtitle(for: contact)
                                    ?? ContactSubtitlePresentation(text: "No details added"),
                                accent: ThemeColors.accent(for: settingsManager.settings.accent)
                            )
                        }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task {
                                    _ = await dataController.deleteContact(id: contact.id, publish: contactsSyncEnabled)
                                    refreshLocalState()
                                }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }

                            Button {
                                editingContact = contact
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .tint(ThemeColors.accent(for: settingsManager.settings.accent))
                        }
                    }
                }
            }
        }
        .platformInsetGroupedListStyle()
    }

    private func refreshLocalState() {
        let contacts = dataController.fetchContacts()
        viewModel.setContacts(contacts)
        viewModel.setPublicFollows(dataController.fetchPublicFollows())
        viewModel.setNip05Checks(dataController.loadNip05Checks())

        if let activeDetail {
            if activeDetail.isProfile {
                self.activeDetail = ContactPresentation(contact: myCard, isProfile: true)
            } else if let updated = contacts.first(where: { $0.id == activeDetail.contact.id }) {
                self.activeDetail = ContactPresentation(contact: updated, isProfile: false)
            } else {
                self.activeDetail = nil
            }
        }

        if let editingContact {
            self.editingContact = contacts.first(where: { $0.id == editingContact.id })
        }
    }

    private func queueNip05Verification() {
        verificationTask?.cancel()
        let profileCard = myCard
        let contacts = viewModel.contacts
        verificationTask = Task {
            _ = await dataController.ensureNip05Verification(
                contactId: profileCard.id,
                nip05: profileCard.nip05,
                npub: profileCard.npub,
                contactUpdatedAt: profileCard.updatedAt
            )
            for contact in contacts {
                guard !Task.isCancelled else { return }
                _ = await dataController.ensureNip05Verification(
                    contactId: contact.id,
                    nip05: contact.nip05,
                    npub: contact.npub,
                    contactUpdatedAt: contact.updatedAt
                )
            }
            guard !Task.isCancelled else { return }
            await MainActor.run {
                refreshLocalState()
            }
        }
    }

    private func draft(from contact: TaskifyContactRecord) -> TaskifyContactDraft {
        TaskifyContactDraft(
            id: contact.id,
            kind: contact.kind,
            name: contact.name,
            address: contact.address,
            paymentRequest: contact.paymentRequest,
            npub: contact.npub,
            username: contact.username ?? "",
            displayName: contact.displayName ?? "",
            nip05: contact.nip05 ?? "",
            about: contact.about ?? "",
            picture: contact.picture ?? "",
            relays: contact.relays,
            source: contact.source
        )
    }
}

private struct ContactPresentation: Identifiable {
    let contact: TaskifyContactRecord
    let isProfile: Bool

    var id: String {
        isProfile ? "profile" : contact.id
    }
}

private struct ContactRowView: View {
    let contact: TaskifyContactRecord
    let subtitle: ContactSubtitlePresentation
    let accent: Color

    var body: some View {
        HStack(spacing: 14) {
            ContactAvatarView(contact: contact, accent: accent, size: 46)

            VStack(alignment: .leading, spacing: 4) {
                Text(contactPrimaryName(contact))
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(subtitle.text)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if subtitle.verified {
                        VerifiedNip05Badge()
                    }
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
    }
}

private struct VerifiedNip05Badge: View {
    var body: some View {
        Image(systemName: "checkmark.seal.fill")
            .font(.footnote)
            .foregroundStyle(ThemeColors.accentBlue)
            .accessibilityLabel("Verified NIP-05")
    }
}

private struct ContactAvatarView: View {
    let contact: TaskifyContactRecord
    let accent: Color
    let size: CGFloat

    var body: some View {
        Group {
            if let picture = contact.picture,
               let url = URL(string: picture),
               !picture.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        initialsView
                    }
                }
            } else {
                initialsView
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var initialsView: some View {
        ZStack {
            Circle()
                .fill(accent.opacity(0.14))
            Text(contactInitials(contactPrimaryName(contact)))
                .font(.system(size: size * 0.34, weight: .semibold, design: .rounded))
                .foregroundStyle(accent)
        }
    }
}

private struct ContactDetailSheet: View {
    let contact: TaskifyContactRecord
    let subtitle: ContactSubtitlePresentation?
    let fields: [ContactField]
    let shareDisplayValue: String?
    let shareExportValue: String?
    let editLabel: String
    let onEdit: () -> Void
    let canFollow: Bool
    let isFollowed: Bool
    let onToggleFollow: (() async -> Void)?
    let onDelete: (() async -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    VStack(spacing: 16) {
                        if let shareDisplayValue, !shareDisplayValue.isEmpty {
                            TaskifyQRCodeView(value: shareDisplayValue)
                                .frame(width: 220, height: 220)
                                .padding(16)
                                .background(ThemeColors.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: 24))
                        }

                        ContactAvatarView(contact: contact, accent: ThemeColors.accentBlue, size: 88)

                        VStack(spacing: 8) {
                            Text(contactPrimaryName(contact))
                                .font(.title2.weight(.semibold))
                                .multilineTextAlignment(.center)
                            if let subtitle {
                                HStack(spacing: 6) {
                                    Text(subtitle.text)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .multilineTextAlignment(.center)
                                    if subtitle.verified {
                                        VerifiedNip05Badge()
                                    }
                                }
                            }
                            if let sourceLabel {
                                Label(sourceLabel, systemImage: "person.crop.circle.badge.checkmark")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    if let shareExportValue, !shareExportValue.isEmpty {
                        HStack(spacing: 12) {
                            ShareLink(item: shareExportValue) {
                                Label("Share Contact", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)

                            Button {
                                PlatformServices.copyToPasteboard(shareExportValue)
                                PlatformServices.notificationSuccess()
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                    }

                    if canFollow, let onToggleFollow {
                        Button {
                            Task { await onToggleFollow() }
                        } label: {
                            Label(
                                isFollowed ? "Unfollow" : "Follow",
                                systemImage: isFollowed
                                    ? "person.crop.circle.badge.minus"
                                    : "person.crop.circle.badge.plus"
                            )
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }

                    if let updatedLabel {
                        HStack(spacing: 6) {
                            Image(systemName: "clock")
                            Text(updatedLabel)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 12) {
                        ForEach(fields) { field in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(field.label)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Button {
                                    PlatformServices.copyToPasteboard(field.value)
                                    PlatformServices.notificationSuccess()
                                } label: {
                                    HStack(alignment: .top, spacing: 8) {
                                        Text(field.value)
                                            .font(field.multiline ? .body : .body.monospaced())
                                            .foregroundStyle(.primary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .multilineTextAlignment(.leading)
                                        if field.verified {
                                            VerifiedNip05Badge()
                                                .padding(.top, 2)
                                        }
                                    }
                                    .padding(12)
                                    .background(ThemeColors.surfaceRaised)
                                    .clipShape(RoundedRectangle(cornerRadius: 14))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if let onDelete {
                        HStack(spacing: 12) {
                            Button(editLabel) {
                                dismiss()
                                onEdit()
                            }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity)

                            Button("Delete", role: .destructive) {
                                Task {
                                    await onDelete()
                                    dismiss()
                                }
                            }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity)
                        }
                    } else {
                        Button(editLabel) {
                            dismiss()
                            onEdit()
                        }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity)
                    }
                }
                .padding(20)
            }
            .navigationTitle(contact.source == .profile ? "My Card" : "Contact")
            .platformInlineTitle()
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var sourceLabel: String? {
        switch contact.source {
        case .manual:
            return "Manual contact"
        case .profile:
            return "Profile card"
        case .scan:
            return "Scanned contact"
        case .sync:
            return "Synced over Nostr"
        case nil:
            return nil
        }
    }

    private var updatedLabel: String? {
        guard contact.updatedAt > 0 else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(contact.updatedAt) / 1000)
        return "Updated \(date.formatted(date: .abbreviated, time: .shortened))"
    }
}

private struct ContactEditorSheet: View {
    let title: String
    let initialDraft: TaskifyContactDraft
    let publicFollows: [TaskifyPublicFollowRecord]
    let onLookup: (String) async throws -> TaskifyContactDraft
    let onSave: (TaskifyContactDraft) async -> Bool

    @Environment(\.dismiss) private var dismiss

    @State private var draft: TaskifyContactDraft
    @State private var lookupValue = ""
    @State private var saveError: String?
    @State private var lookupBusy = false
    @State private var saveBusy = false
    @State private var showScanner = false
    @State private var showFollowPicker = false

    init(
        title: String,
        initialDraft: TaskifyContactDraft,
        publicFollows: [TaskifyPublicFollowRecord],
        onLookup: @escaping (String) async throws -> TaskifyContactDraft,
        onSave: @escaping (TaskifyContactDraft) async -> Bool
    ) {
        self.title = title
        self.initialDraft = initialDraft
        self.publicFollows = publicFollows
        self.onLookup = onLookup
        self.onSave = onSave
        _draft = State(initialValue: initialDraft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Import") {
                    TextField("npub1… or name@example.com", text: $lookupValue)
                        .platformNoAutoCaps()

                    HStack(spacing: 12) {
                        Button {
                            Task { await importReference(lookupValue, allowPasteboardFallback: true) }
                        } label: {
                            if lookupBusy {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                            } else {
                                Label(lookupValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Paste" : "Import", systemImage: lookupValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "doc.on.clipboard" : "arrow.down.circle")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(lookupBusy)

                        Button {
                            Task { await importFromPasteboard() }
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(lookupBusy)
                    }

                    #if os(iOS)
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan QR", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(lookupBusy)
                    #endif

                    if !publicFollows.isEmpty {
                        Button {
                            showFollowPicker = true
                        } label: {
                            Label("Pick from Follows", systemImage: "person.2.fill")
                        }
                        .disabled(lookupBusy)
                    } else {
                        Text("Sync contacts to load your public follows.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Details") {
                    Picker("Type", selection: $draft.kind) {
                        Text("Custom").tag(TaskifyContactKind.custom)
                        Text("Nostr").tag(TaskifyContactKind.nostr)
                    }
                    TextField("Nickname", text: $draft.name)
                    TextField("Display name", text: $draft.displayName)
                    TextField("Username", text: $draft.username)
                        .platformNoAutoCaps()
                    TextField("Lightning address", text: $draft.address)
                        .platformNoAutoCaps()
                    TextField("npub or hex pubkey", text: $draft.npub)
                        .platformNoAutoCaps()
                    TextField("NIP-05", text: $draft.nip05)
                        .platformNoAutoCaps()
                    TextField("Picture URL", text: $draft.picture)
                        .platformNoAutoCaps()
                        .platformURLKeyboard()
                    TextField("Relay hints (comma separated)", text: Binding(
                        get: { draft.relays.joined(separator: ", ") },
                        set: { draft.relays = normalizeRelayList($0.split(separator: ",").map(String.init)) }
                    ))
                        .platformNoAutoCaps()
                        .platformURLKeyboard()
                    TextField("About", text: $draft.about, axis: .vertical)
                        .lineLimit(4, reservesSpace: true)
                }

                if let saveError, !saveError.isEmpty {
                    Section {
                        Text(saveError)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .platformInlineTitle()
            .sheet(isPresented: $showFollowPicker) {
                PublicFollowPickerSheet(
                    follows: publicFollows,
                    onSelect: { follow in
                        Task {
                            showFollowPicker = false
                            await importReference(formatContactNpub(follow.pubkey), allowPasteboardFallback: false)
                        }
                    }
                )
            }
            .sheet(isPresented: $showScanner) {
                ContactScannerSheet { scannedValue in
                    lookupValue = scannedValue
                    Task { await importReference(scannedValue, allowPasteboardFallback: false, preferredSource: .scan) }
                }
            }
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.leading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button {
                        Task {
                            saveBusy = true
                            defer { saveBusy = false }
                            let ok = await onSave(draft)
                            if ok {
                                dismiss()
                            } else {
                                saveError = "Unable to save contact."
                            }
                        }
                    } label: {
                        if saveBusy {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(saveBusy)
                }
            }
        }
    }

    private func importFromPasteboard() async {
        guard let pasted = PlatformServices.readPasteboardString(), !pasted.isEmpty else {
            saveError = "Clipboard is empty."
            return
        }
        lookupValue = pasted
        await importReference(pasted, allowPasteboardFallback: false)
    }

    private func importReference(
        _ value: String,
        allowPasteboardFallback: Bool,
        preferredSource: TaskifyContactSource? = nil
    ) async {
        var reference = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if reference.isEmpty, allowPasteboardFallback {
            reference = PlatformServices.readPasteboardString() ?? ""
            if !reference.isEmpty {
                lookupValue = reference
            }
        }
        guard !reference.isEmpty else {
            saveError = "Paste a contact share, `npub`, or NIP-05 first."
            return
        }

        lookupBusy = true
        defer { lookupBusy = false }

        do {
            let imported = try await onLookup(reference)
            draft = mergedDraft(with: imported, preferredSource: preferredSource)
            saveError = nil
        } catch {
            saveError = error.localizedDescription
        }
    }

    private func mergedDraft(
        with imported: TaskifyContactDraft,
        preferredSource: TaskifyContactSource? = nil
    ) -> TaskifyContactDraft {
        TaskifyContactDraft(
            id: draft.id ?? imported.id,
            kind: imported.kind,
            name: imported.name.isEmpty ? draft.name : imported.name,
            address: imported.address.isEmpty ? draft.address : imported.address,
            paymentRequest: imported.paymentRequest.isEmpty ? draft.paymentRequest : imported.paymentRequest,
            npub: imported.npub.isEmpty ? draft.npub : imported.npub,
            username: imported.username.isEmpty ? draft.username : imported.username,
            displayName: imported.displayName.isEmpty ? draft.displayName : imported.displayName,
            nip05: imported.nip05.isEmpty ? draft.nip05 : imported.nip05,
            about: imported.about.isEmpty ? draft.about : imported.about,
            picture: imported.picture.isEmpty ? draft.picture : imported.picture,
            relays: imported.relays.isEmpty ? draft.relays : imported.relays,
            source: preferredSource ?? imported.source ?? draft.source
        )
    }
}

private struct PublicFollowPickerSheet: View {
    let follows: [TaskifyPublicFollowRecord]
    let onSelect: (TaskifyPublicFollowRecord) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    private var filteredFollows: [TaskifyPublicFollowRecord] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return follows }
        return follows.filter { follow in
            [
                follow.petname ?? "",
                follow.nip05 ?? "",
                follow.username ?? "",
                follow.pubkey,
                formatContactNpub(follow.pubkey),
            ]
            .joined(separator: "\n")
            .lowercased()
            .contains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if filteredFollows.isEmpty {
                    ContentUnavailableView(
                        "No Follows Found",
                        systemImage: "person.crop.circle.badge.questionmark",
                        description: Text("Sync your contacts first, or search for a different follow.")
                    )
                    .padding(.vertical, 20)
                } else {
                    ForEach(filteredFollows) { follow in
                        Button {
                            dismiss()
                            onSelect(follow)
                        } label: {
                            HStack(spacing: 14) {
                                ZStack {
                                    Circle()
                                        .fill(ThemeColors.accentBlue.opacity(0.14))
                                        .frame(width: 42, height: 42)
                                    Text(contactInitials(followPrimaryTitle(follow)))
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(ThemeColors.accentBlue)
                                }

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(followPrimaryTitle(follow))
                                        .font(.headline)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text(followSecondaryTitle(follow))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search follows")
            .navigationTitle("Import from Follows")
            .platformInlineTitle()
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.leading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func followPrimaryTitle(_ follow: TaskifyPublicFollowRecord) -> String {
        let petname = (follow.petname ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let nip05 = (follow.nip05 ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let username = formatContactUsername(follow.username)
        if !petname.isEmpty { return petname }
        if !nip05.isEmpty { return nip05 }
        return username.isEmpty ? formatContactNpub(follow.pubkey) : username
    }

    private func followSecondaryTitle(_ follow: TaskifyPublicFollowRecord) -> String {
        let nip05 = (follow.nip05 ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let username = formatContactUsername(follow.username)
        return nip05.isEmpty ? (username.isEmpty ? formatContactNpub(follow.pubkey) : username) : nip05
    }
}

private struct ContactScannerSheet: View {
    let onScannedValue: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var scannerError: String?

    var body: some View {
        NavigationStack {
            Group {
                if scannerAvailable {
                    scannerView
                } else {
                    ContentUnavailableView(
                        "Scanner Unavailable",
                        systemImage: "qrcode.viewfinder",
                        description: Text("Use Paste instead, or try scanning on a physical iPhone or iPad.")
                    )
                }
            }
            .navigationTitle("Scan QR")
            .platformInlineTitle()
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.leading) {
                    Button("Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let scannerError, !scannerError.isEmpty {
                    Text(scannerError)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding()
                }
            }
        }
    }

    @ViewBuilder
    private var scannerView: some View {
        #if os(iOS) && canImport(UIKit) && canImport(VisionKit)
        ContactScannerRepresentable { result in
            switch result {
            case .success(let value):
                dismiss()
                onScannedValue(value)
            case .failure(let error):
                scannerError = error.localizedDescription
            }
        }
        .ignoresSafeArea(edges: .bottom)
        #else
        EmptyView()
        #endif
    }

    private var scannerAvailable: Bool {
        #if os(iOS) && canImport(UIKit) && canImport(VisionKit)
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
        #else
        false
        #endif
    }
}

#if os(iOS) && canImport(UIKit) && canImport(VisionKit)
private struct ContactScannerRepresentable: UIViewControllerRepresentable {
    let onResult: (Result<String, Error>) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onResult: onResult)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr, .aztec, .dataMatrix, .pdf417, .code128])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        do {
            try controller.startScanning()
        } catch {
            DispatchQueue.main.async {
                onResult(.failure(error))
            }
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) {
        uiViewController.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private var hasResolved = false
        private let onResult: (Result<String, Error>) -> Void

        init(onResult: @escaping (Result<String, Error>) -> Void) {
            self.onResult = onResult
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !hasResolved else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item,
                   let payload = barcode.payloadStringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !payload.isEmpty {
                    hasResolved = true
                    onResult(.success(payload))
                    return
                }
            }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            guard !hasResolved else { return }
            onResult(.failure(error))
        }
    }
}
#endif

private struct ProfileMetadataEditorSheet: View {
    let initialMetadata: TaskifyProfileMetadata
    let profileName: String
    let npub: String
    let shareValue: String?
    let shareExportValue: String?
    let onSave: (TaskifyProfileMetadata) async -> Bool

    @Environment(\.dismiss) private var dismiss

    @State private var metadata: TaskifyProfileMetadata
    @State private var saveBusy = false
    @State private var saveError: String?

    init(
        initialMetadata: TaskifyProfileMetadata,
        profileName: String,
        npub: String,
        shareValue: String?,
        shareExportValue: String?,
        onSave: @escaping (TaskifyProfileMetadata) async -> Bool
    ) {
        self.initialMetadata = initialMetadata
        self.profileName = profileName
        self.npub = npub
        self.shareValue = shareValue
        self.shareExportValue = shareExportValue
        self.onSave = onSave
        _metadata = State(initialValue: initialMetadata)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(ThemeColors.accentBlue.opacity(0.14))
                                .frame(width: 54, height: 54)
                            Text(contactInitials(metadata.displayName.isEmpty ? profileName : metadata.displayName))
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(ThemeColors.accentBlue)
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text(metadata.displayName.isEmpty ? profileName : metadata.displayName)
                                .font(.headline)
                            Text(formatContactNpub(npub))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let shareValue, !shareValue.isEmpty {
                        TaskifyQRCodeView(value: shareValue)
                            .frame(height: 220)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }

                    HStack(spacing: 12) {
                        if let shareExportValue, !shareExportValue.isEmpty {
                            ShareLink(item: shareExportValue) {
                                Label("Share Card", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)

                            Button {
                                PlatformServices.copyToPasteboard(shareExportValue)
                                PlatformServices.notificationSuccess()
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        } else {
                            ShareLink(item: formatContactNpub(npub)) {
                                Label("Share npub", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                }

                Section("Profile Metadata") {
                    TextField("Username", text: $metadata.username)
                        .platformNoAutoCaps()
                    TextField("Display name", text: $metadata.displayName)
                    TextField("Lightning address", text: $metadata.lud16)
                        .platformNoAutoCaps()
                    TextField("NIP-05", text: $metadata.nip05)
                        .platformNoAutoCaps()
                    TextField("Picture URL", text: $metadata.picture)
                        .platformNoAutoCaps()
                        .platformURLKeyboard()
                    TextField("About", text: $metadata.about, axis: .vertical)
                        .lineLimit(4, reservesSpace: true)
                }

                if let saveError, !saveError.isEmpty {
                    Section {
                        Text(saveError)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("My Card")
            .platformInlineTitle()
            .toolbar {
                ToolbarItem(placement: PlatformToolbarPlacement.leading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: PlatformToolbarPlacement.trailing) {
                    Button {
                        Task {
                            saveBusy = true
                            defer { saveBusy = false }
                            let ok = await onSave(metadata)
                            if ok {
                                dismiss()
                            } else {
                                saveError = "Unable to publish profile metadata."
                            }
                        }
                    } label: {
                        if saveBusy {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                }
            }
        }
    }
}

private struct TaskifyQRCodeView: View {
    let value: String

    private let context = CIContext()
    private let filter = CIFilter.qrCodeGenerator()

    var body: some View {
        if let image = qrImage {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            RoundedRectangle(cornerRadius: 20)
                .fill(ThemeColors.surfaceRaised)
                .overlay {
                    Text("QR unavailable")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
        }
    }

    private var qrImage: CGImage? {
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else { return nil }
        return context.createCGImage(output, from: output.extent)
    }
}
