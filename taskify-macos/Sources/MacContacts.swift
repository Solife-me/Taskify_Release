import SwiftUI
import TaskifyCore

/// The contacts directory, presented as a sheet from Chat's header — matching where iOS puts
/// it (`NostrContactsDirectoryView`, opened from `ChatView`'s own-avatar button) rather than
/// adding it as a new top-level sidebar destination. Your own profile is edited from Settings'
/// existing Profile tab instead of a duplicate "My Card" route.
struct MacContactsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var selection: String?
    @State private var showingNewContact = false
    @State private var editingContact: NostrContact?
    @State private var deletingContact: NostrContact?

    private var filteredContacts: [NostrContact] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = query.isEmpty ? model.nostrContacts : model.nostrContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
        return matches.sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Contacts").font(.title2.bold())
                if model.isRefreshingContacts { ProgressView().controlSize(.small) }
                Spacer()
                Button { model.refreshContacts() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(model.isRefreshingContacts).help("Refresh Contacts")
                Button { showingNewContact = true } label: { Image(systemName: "person.badge.plus") }
                    .buttonStyle(.plain).help("Add Contact")
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }.padding(16)
            Divider()
            HSplitView {
                VStack(spacing: 0) {
                    TextField("Search contacts", text: $search).textFieldStyle(.roundedBorder).padding(10)
                    if model.nostrContacts.isEmpty {
                        ContentUnavailableView(
                            "Build Your Contact List", systemImage: "person.2.badge.plus",
                            description: Text("Contacts from the PWA appear here automatically. Add someone by their npub to use them for task sharing and assignments.")
                        ).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        List(selection: $selection) {
                            ForEach(filteredContacts) { contact in
                                HStack(spacing: 10) {
                                    MacContactAvatar(contact: contact)
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 5) {
                                            Text(contact.displayName).font(.headline).lineLimit(1)
                                            if contact.profile?.nip05 != nil {
                                                Image(systemName: "checkmark.seal.fill").font(.caption2).foregroundStyle(.green)
                                            }
                                        }
                                        Text(contact.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }.padding(.vertical, 5).tag(contact.publicKey)
                                    .contextMenu {
                                        Button("Copy npub") { macCopy(contact.npub) }
                                        Button("Edit Contact…") { editingContact = contact }
                                        Button("Delete Contact…", role: .destructive) { deletingContact = contact }
                                    }
                            }
                        }.listStyle(.sidebar)
                    }
                }.frame(minWidth: 230, idealWidth: 280, maxWidth: 340)
                if let selection, let contact = model.nostrContact(publicKey: selection) {
                    MacContactDetail(contact: contact, edit: { editingContact = contact }, delete: { deletingContact = contact })
                        .id(selection).frame(minWidth: 360, maxWidth: .infinity)
                } else {
                    ContentUnavailableView("Your Contacts", systemImage: "person.2", description: Text("Choose a contact or add a new one."))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 680, minHeight: 480)
        .sheet(isPresented: $showingNewContact) { MacContactEditor(contact: nil) }
        .sheet(item: $editingContact) { contact in MacContactEditor(contact: contact) }
        .confirmationDialog(
            "Remove this contact from your private contact list?",
            isPresented: Binding(get: { deletingContact != nil }, set: { if !$0 { deletingContact = nil } }),
            presenting: deletingContact
        ) { contact in
            Button("Delete Contact", role: .destructive) {
                Task {
                    do { try await model.deleteNostrContact(publicKey: contact.publicKey) }
                    catch { model.errorMessage = error.localizedDescription }
                }
                if selection == contact.publicKey { selection = nil }
            }
            Button("Cancel", role: .cancel) {}
        } message: { contact in
            Text("\(contact.displayName) will be removed from the private contact list on your relays and the PWA.")
        }
        .task { model.refreshContactsIfNeeded() }
    }
}

struct MacContactAvatar: View {
    let contact: NostrContact
    var size: CGFloat = 36
    var body: some View {
        Group {
            if let url = contact.pictureURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() } else { initials }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size).clipShape(Circle())
    }
    private var initials: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.15))
            Text(contact.initials).font(.system(size: size * 0.38, weight: .semibold))
        }
    }
}

private struct MacContactDetail: View {
    let contact: NostrContact
    var edit: () -> Void
    var delete: () -> Void
    @Environment(AppModel.self) private var model
    @State private var nip05Status: MacNip05VerificationStatus = .unverified
    @State private var copiedField: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                MacContactAvatar(contact: contact, size: 84)
                VStack(spacing: 4) {
                    HStack(spacing: 8) {
                        Text(contact.displayName).font(.title2.bold())
                        if model.isBot(publicKey: contact.publicKey) {
                            Text("BOT").font(.caption2.weight(.bold)).foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(Color.accentColor.opacity(0.14), in: Capsule())
                        }
                    }
                    Text(contact.subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
                MacQRCodeView(value: contact.npub, label: "Contact QR code")
                VStack(alignment: .leading, spacing: 14) {
                    field("Nostr public key", value: contact.npub)
                    if let nip05 = contact.profile?.nip05 { nip05Field(nip05) }
                    if let lud16 = contact.profile?.lud16 { field("Lightning", value: lud16) }
                    if let about = contact.profile?.about.trimmedOrNil { field("About", value: about) }
                    if !contact.relayURLs.isEmpty { field("Delivery relays", value: contact.relayURLs.joined(separator: "\n")) }
                }
                .padding(16).frame(maxWidth: 420, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                HStack {
                    Button("Edit Contact…", action: edit)
                    Button("Delete Contact…", role: .destructive, action: delete)
                }
            }.padding(28).frame(maxWidth: .infinity)
        }
        .task(id: contact.profile?.nip05) {
            guard let nip05 = contact.profile?.nip05 else { nip05Status = .unverified; return }
            nip05Status = .checking
            do { _ = try await Nip05Client.verify(nip05, publicKeyHex: contact.publicKey); nip05Status = .verified }
            catch { nip05Status = .invalid }
        }
        .task(id: contact.publicKey) { await model.refreshBotCommands(publicKey: contact.publicKey) }
    }

    private func field(_ label: String, value: String) -> some View {
        Button {
            macCopy(value)
            copiedField = label
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        Text(label).font(.caption).foregroundStyle(.secondary)
                        if copiedField == label { Text("Copied").font(.caption2).foregroundStyle(.green) }
                    }
                    Text(value).font(.callout).textSelection(.enabled).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                Image(systemName: "doc.on.doc").font(.caption).foregroundStyle(.secondary)
            }
        }.buttonStyle(.plain)
    }

    @ViewBuilder private func nip05Field(_ value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                switch nip05Status {
                case .unverified: Image(systemName: "seal").foregroundStyle(.secondary)
                case .checking: ProgressView().controlSize(.small)
                case .verified: Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                case .invalid: Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange)
                }
            }.frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(nip05Label).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.callout).textSelection(.enabled)
                if nip05Status == .invalid {
                    Text("This address does not currently resolve to the contact's signed public key.")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
            Spacer()
            Button { macCopy(value) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var nip05Label: String {
        switch nip05Status {
        case .unverified: "NIP-05"
        case .checking: "Checking NIP-05"
        case .verified: "Verified NIP-05"
        case .invalid: "Unverified NIP-05"
        }
    }
}

private enum MacNip05VerificationStatus: Equatable {
    case unverified, checking, verified, invalid
}

private struct MacContactEditor: View {
    let existingContact: NostrContact?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var publicKeyValue: String
    @State private var nickname: String
    @State private var relayURL: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(contact: NostrContact?) {
        existingContact = contact
        _publicKeyValue = State(initialValue: contact?.npub ?? "")
        _nickname = State(initialValue: contact?.petname ?? "")
        _relayURL = State(initialValue: contact?.relayURLs.first ?? "")
    }

    private var keyIsValid: Bool { NostrPublicKey.parse(publicKeyValue) != nil }
    private var nip05IsValid: Bool { (try? Nip05Client.request(for: publicKeyValue)) != nil }
    private var canSave: Bool { keyIsValid || (existingContact == nil && nip05IsValid) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(existingContact == nil ? "New Contact" : "Edit Contact").font(.title2.bold())
            HStack {
                TextField("npub, public key, or NIP-05", text: $publicKeyValue, axis: .vertical)
                    .lineLimit(1...3).font(.system(.body, design: .monospaced)).disabled(existingContact != nil)
                if existingContact == nil {
                    Button("Paste") {
                        if let value = NSPasteboard.general.string(forType: .string) { publicKeyValue = value }
                    }
                }
            }
            TextField("Nickname (optional)", text: $nickname)
            TextField("Relay hint (optional)", text: $relayURL)
            Label(
                keyIsValid
                    ? "Valid Nostr public key"
                    : (nip05IsValid ? "NIP-05 address will be verified before saving" : "Enter a valid npub, public key, or NIP-05 address"),
                systemImage: canSave ? "checkmark.circle.fill" : "exclamationmark.circle"
            ).font(.caption).foregroundStyle(canSave ? Color.green : Color.orange)
            Text("Taskify discovers the contact's preferred NIP-17 inbox relays automatically and encrypts the saved list to your identity.")
                .font(.caption2).foregroundStyle(.secondary)
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
            Spacer()
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.disabled(isSaving).keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    save()
                } label: {
                    if isSaving { ProgressView().controlSize(.small) } else { Text("Save") }
                }.buttonStyle(.borderedProminent).disabled(!canSave || isSaving).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 440, height: 400).interactiveDismissDisabled(isSaving)
    }

    private func save() {
        guard canSave, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                var value = publicKeyValue
                var resolvedRelay: String?
                if !keyIsValid {
                    let resolved = try await Nip05Client.resolve(publicKeyValue)
                    value = NostrPublicKey.npub(from: try Data(hex: resolved.publicKeyHex)) ?? resolved.publicKeyHex
                    resolvedRelay = resolved.relayURLs.first
                }
                _ = try await model.saveNostrContact(
                    publicKeyValue: value,
                    petname: nickname,
                    relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? resolvedRelay : relayURL
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }
}
