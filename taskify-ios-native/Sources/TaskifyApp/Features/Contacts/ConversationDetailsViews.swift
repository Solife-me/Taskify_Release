import CryptoKit
import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import TaskifyCore
import TaskifyWatchShared
import UIKit
import UniformTypeIdentifiers
import VisionKit

enum ConversationDetailsTab: String, CaseIterable, Identifiable {
    case info = "Info"
    case photos = "Photos"
    case files = "Files"
    case links = "Links"

    var id: String { rawValue }
}
struct ConversationSharedPhoto: Identifiable {
    let id: String
    let url: URL
    let attachment: NostrDirectMessageAttachment?
}

struct ConversationSharedFile: Identifiable {
    let id: String
    let attachment: NostrDirectMessageAttachment
    let senderPublicKey: String
    let createdAt: Int
}

struct ConversationSharedLink: Identifiable {
    let id: String
    let url: URL
    let senderPublicKey: String
    let createdAt: Int
}

enum ConversationSharedContent {
    static func photos(in messages: [NostrDirectMessage]) -> [ConversationSharedPhoto] {
        messages.flatMap { message in
            let attachmentURL = message.attachment.flatMap { URL(string: $0.url)?.absoluteString }
            return NostrDirectMessageSharedContent.photoURLs(in: message).enumerated().map { index, url in
                ConversationSharedPhoto(
                    id: "\(message.rumorEventID)-photo-\(index)",
                    url: url,
                    attachment: url.absoluteString == attachmentURL ? message.attachment : nil
                )
            }
        }
    }

    /// Every attachment except photos — documents, videos, audio, archives, anything
    /// else shared through the conversation's encrypted attachments.
    static func files(in messages: [NostrDirectMessage]) -> [ConversationSharedFile] {
        messages.compactMap { message in
            guard let attachment = message.attachment, !attachment.isImage else { return nil }
            return ConversationSharedFile(
                id: "\(message.rumorEventID)-file",
                attachment: attachment,
                senderPublicKey: message.senderPublicKey,
                createdAt: message.createdAt
            )
        }
    }

    static func links(in messages: [NostrDirectMessage]) -> [ConversationSharedLink] {
        messages.flatMap { message in
            NostrDirectMessageSharedContent.linkURLs(in: message).enumerated().map { index, url in
                ConversationSharedLink(
                    id: "\(message.rumorEventID)-link-\(index)",
                    url: url,
                    senderPublicKey: message.senderPublicKey,
                    createdAt: message.createdAt
                )
            }
        }
    }
}

struct ConversationDetailsTabBar: View {
    @Binding var selection: ConversationDetailsTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(ConversationDetailsTab.allCases) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { selection = tab }
                } label: {
                    VStack(spacing: 8) {
                        Text(tab.rawValue)
                            .font(.subheadline.weight(selection == tab ? .bold : .semibold))
                            .foregroundStyle(
                                selection == tab ? TaskifyTheme.primaryText : TaskifyTheme.secondaryText
                            )
                        Capsule()
                            .fill(selection == tab ? TaskifyTheme.accent : Color.clear)
                            .frame(height: 3)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == tab ? .isSelected : [])
            }
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 8)
    }
}

struct ConversationPhotosView: View {
    @Environment(\.openURL) private var openURL
    let messages: [NostrDirectMessage]
    let emptyTitle: String
    let emptyDescription: String

    init(
        messages: [NostrDirectMessage],
        emptyTitle: String = "No Shared Photos",
        emptyDescription: String
    ) {
        self.messages = messages
        self.emptyTitle = emptyTitle
        self.emptyDescription = emptyDescription
    }

    private var photos: [ConversationSharedPhoto] {
        ConversationSharedContent.photos(in: messages)
    }

    var body: some View {
        if photos.isEmpty {
            ContentUnavailableView(
                emptyTitle,
                systemImage: "photo.on.rectangle.angled",
                description: Text(emptyDescription)
            )
            .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 140), spacing: 12)],
                    spacing: 12
                ) {
                    ForEach(photos) { photo in
                        if let attachment = photo.attachment {
                            DirectMessageAttachmentView(attachment: attachment, compact: true)
                        } else {
                            Button {
                                openURL(photo.url)
                            } label: {
                                AsyncImage(url: photo.url) { phase in
                                    if let image = phase.image {
                                        image
                                            .resizable()
                                            .scaledToFill()
                                    } else if phase.error != nil {
                                        Image(systemName: "photo.badge.exclamationmark")
                                            .font(.title2)
                                            .foregroundStyle(TaskifyTheme.secondaryText)
                                    } else {
                                        ProgressView()
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 150)
                                .background(Color.black.opacity(0.2))
                                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                                        .stroke(TaskifyTheme.border, lineWidth: 0.8)
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Open shared photo")
                        }
                    }
                }
                .padding(16)
            }
        }
    }
}

struct ConversationFilesView: View {
    let messages: [NostrDirectMessage]
    let emptyDescription: String
    let unknownSenderName: String

    init(
        messages: [NostrDirectMessage],
        emptyDescription: String,
        unknownSenderName: String = "Contact"
    ) {
        self.messages = messages
        self.emptyDescription = emptyDescription
        self.unknownSenderName = unknownSenderName
    }

    private var files: [ConversationSharedFile] {
        ConversationSharedContent.files(in: messages)
    }

    var body: some View {
        if files.isEmpty {
            ContentUnavailableView(
                "No Shared Files",
                systemImage: "doc.on.doc",
                description: Text(emptyDescription)
            )
            .frame(maxHeight: .infinity)
        } else {
            List(files) { file in
                ConversationFileRow(file: file, unknownSenderName: unknownSenderName)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }
}

struct ConversationFileRow: View {
    @Environment(AppModel.self) private var model
    let file: ConversationSharedFile
    let unknownSenderName: String

    @State private var isLoading = false
    @State private var failed = false
    @State private var previewURL: URL?

    var body: some View {
        Button(action: openFile) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(TaskifyTheme.accent.opacity(0.14))
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: file.attachment.detailIcon)
                            .font(.headline)
                            .foregroundStyle(TaskifyTheme.accent)
                    }
                }
                .frame(width: 42, height: 42)

                VStack(alignment: .leading, spacing: 3) {
                    Text(file.attachment.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(2)
                    HStack(spacing: 5) {
                        Text(file.attachment.detailKindLabel)
                        if let size = file.attachment.size {
                            Text("·")
                            Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    Text(metadata)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                Spacer(minLength: 2)
                Image(systemName: failed ? "arrow.clockwise" : "arrow.up.forward")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { old, new in
            if let old, old != new { try? FileManager.default.removeItem(at: old) }
        }
        .accessibilityLabel("Open \(file.attachment.displayName)")
    }

    private var metadata: String {
        let sender = file.senderPublicKey == model.identityPublicKey
            ? "You"
            : model.nostrContact(publicKey: file.senderPublicKey)?.displayName ?? unknownSenderName
        let date = Date(timeIntervalSince1970: TimeInterval(file.createdAt))
            .formatted(date: .abbreviated, time: .shortened)
        return "\(sender) · \(date)"
    }

    private func openFile() {
        if failed {
            failed = false
        }
        isLoading = true
        Task { @MainActor in
            defer { isLoading = false }
            do {
                let decrypted = try await DirectMessageAttachmentDataLoader.shared.file(for: file.attachment)
                guard !Task.isCancelled else { return }
                previewURL = try DirectMessageAttachmentDataLoader.previewFile(
                    file: decrypted,
                    attachment: file.attachment
                )
                failed = false
            } catch {
                failed = true
            }
        }
    }
}

struct ConversationLinksView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let messages: [NostrDirectMessage]
    let emptyDescription: String
    let unknownSenderName: String

    init(
        messages: [NostrDirectMessage],
        emptyDescription: String,
        unknownSenderName: String = "Contact"
    ) {
        self.messages = messages
        self.emptyDescription = emptyDescription
        self.unknownSenderName = unknownSenderName
    }

    private var links: [ConversationSharedLink] {
        ConversationSharedContent.links(in: messages)
    }

    var body: some View {
        if links.isEmpty {
            ContentUnavailableView(
                "No Shared Links",
                systemImage: "link",
                description: Text(emptyDescription)
            )
            .frame(maxHeight: .infinity)
        } else {
            List(links) { link in
                Button {
                    openURL(link.url)
                } label: {
                    HStack(spacing: 12) {
                        Group {
                            if let faviconURL = TaskContentLinks.faviconURL(for: link.url) {
                                AsyncImage(url: faviconURL) { phase in
                                    if case let .success(image) = phase {
                                        image
                                            .resizable()
                                            .scaledToFit()
                                            .padding(9)
                                    } else {
                                        Image(systemName: "link")
                                            .font(.headline)
                                    }
                                }
                            } else {
                                Image(systemName: "link")
                                    .font(.headline)
                            }
                        }
                        .foregroundStyle(TaskifyTheme.accent)
                        .frame(width: 42, height: 42)
                        .background(TaskifyTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 11))

                        VStack(alignment: .leading, spacing: 3) {
                            Text(TaskContentLinks.fallbackTitle(for: link.url))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.primaryText)
                                .lineLimit(2)
                            Text(link.url.absoluteString)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                            Text(metadata(for: link))
                                .font(.caption2)
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }

                        Spacer(minLength: 2)
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .scrollContentBackground(.hidden)
        }
    }

    private func metadata(for link: ConversationSharedLink) -> String {
        let sender = link.senderPublicKey == model.identityPublicKey
            ? "You"
            : model.nostrContact(publicKey: link.senderPublicKey)?.displayName ?? unknownSenderName
        let date = Date(timeIntervalSince1970: TimeInterval(link.createdAt))
            .formatted(date: .abbreviated, time: .shortened)
        return "\(sender) · \(date)"
    }
}

struct GroupConversationDetailsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draftName = ""
    @State private var isEditingName = false
    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?
    @State private var selectedTab = ConversationDetailsTab.info
    let groupID: String

    private var group: NostrGroupConversation? { model.groupConversation(id: groupID) }
    private var messages: [NostrDirectMessage] { model.directMessages(with: groupID) }

    var body: some View {
        NavigationStack {
            Group {
                if let group {
                    VStack(spacing: 0) {
                        VStack(spacing: 8) {
                            ChatPeerAvatar(
                                contact: nil,
                                publicKey: group.groupID,
                                size: 72,
                                group: group,
                                recentMessages: messages
                            )
                            Text(group.displayName)
                                .font(.title2.bold())
                                .multilineTextAlignment(.center)
                            Text("\(group.memberPublicKeys.count) participants")
                                .font(.subheadline)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        .padding(.top, 12)
                        .padding(.bottom, 14)

                        ConversationDetailsTabBar(selection: $selectedTab)

                        tabContent(group)
                    }
                } else {
                    ContentUnavailableView(
                        "Group Unavailable",
                        systemImage: "person.3",
                        description: Text("This group is no longer stored on this device.")
                    )
                }
            }
            .background(TaskifyTheme.background.ignoresSafeArea())
            .navigationTitle("Group Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
        .onAppear {
            draftName = group?.name ?? ""
        }
    }

    @ViewBuilder
    private func tabContent(_ group: NostrGroupConversation) -> some View {
        switch selectedTab {
        case .info:
            infoContent(group)
        case .photos:
            ConversationPhotosView(
                messages: messages,
                emptyDescription: "Photos shared with this group will appear here."
            )
        case .files:
            ConversationFilesView(
                messages: messages,
                emptyDescription: "Files shared with this group will appear here.",
                unknownSenderName: "Group Member"
            )
        case .links:
            ConversationLinksView(
                messages: messages,
                emptyDescription: "Web links shared in group messages will appear here.",
                unknownSenderName: "Group Member"
            )
        }
    }

    private func infoContent(_ group: NostrGroupConversation) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("GROUP NAME")
                    .font(.caption2.bold())
                    .tracking(0.8)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .padding(.leading, 4)

                if isEditingName {
                    VStack(spacing: 12) {
                        TextField("Group name", text: $draftName)
                            .textInputAutocapitalization(.words)
                            .submitLabel(.done)
                            .onSubmit(saveName)
                            .padding(.horizontal, 13)
                            .frame(height: 44)
                            .background(TaskifyTheme.raisedFill, in: RoundedRectangle(cornerRadius: 12))

                        HStack(spacing: 12) {
                            Button("Cancel") {
                                draftName = group.name
                                isEditingName = false
                                errorMessage = nil
                            }
                            .buttonStyle(.bordered)
                            .disabled(isSaving)

                            Spacer()

                            Button {
                                saveName()
                            } label: {
                                if isSaving {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Text("Save")
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(
                                isSaving ||
                                    draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            )
                        }
                    }
                    .padding(14)
                    .taskifyGlass(cornerRadius: 18)
                } else {
                    Button {
                        draftName = group.name
                        statusMessage = nil
                        errorMessage = nil
                        isEditingName = true
                    } label: {
                        HStack {
                            Text(group.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Spacer()
                            Image(systemName: "pencil")
                                .foregroundStyle(TaskifyTheme.accent)
                        }
                        .padding(14)
                        .taskifyGlass(cornerRadius: 18)
                    }
                    .buttonStyle(.plain)
                }

                if let statusMessage {
                    Label(statusMessage, systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                Text("PARTICIPANTS")
                    .font(.caption2.bold())
                    .tracking(0.8)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .padding(.leading, 4)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(group.memberPublicKeys, id: \.self) { publicKey in
                            participantCell(publicKey)
                        }
                    }
                    .padding(.horizontal, 2)
                }

                Text("CONVERSATION")
                    .font(.caption2.bold())
                    .tracking(0.8)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .padding(.leading, 4)

                VStack(spacing: 0) {
                    Toggle(
                        "Mute Group",
                        isOn: Binding(
                            get: { model.isDirectMessageGroupMuted(group.groupID) },
                            set: { muted in
                                model.setDirectMessageGroupMuted(group.groupID, muted: muted)
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            }
                        )
                    )
                    .padding(14)

                    Divider().overlay(TaskifyTheme.border)

                    Button(role: model.hasLeftDirectMessageGroup(group.groupID) ? nil : .destructive) {
                        let left = !model.hasLeftDirectMessageGroup(group.groupID)
                        model.setDirectMessageGroupLeft(group.groupID, left: left)
                        UINotificationFeedbackGenerator().notificationOccurred(left ? .warning : .success)
                    } label: {
                        HStack {
                            Label(
                                model.hasLeftDirectMessageGroup(group.groupID) ? "Rejoin Group" : "Leave Group",
                                systemImage: model.hasLeftDirectMessageGroup(group.groupID)
                                    ? "arrow.uturn.forward.circle" : "rectangle.portrait.and.arrow.right"
                            )
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.bold())
                                .foregroundStyle(TaskifyTheme.tertiaryText)
                        }
                        .padding(14)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .taskifyGlass(cornerRadius: 18)

                Text("Muted groups stay available without adding new unread badges. Leaving disables replies and attachments until you rejoin.")
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.tertiaryText)
                    .padding(.horizontal, 4)
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private func participantRow(_ publicKey: String) -> some View {
        let contact = model.nostrContact(publicKey: publicKey)
        HStack(spacing: 12) {
            if let contact {
                NostrContactAvatar(contact: contact, size: 42)
            } else {
                ChatPeerAvatar(contact: nil, publicKey: publicKey, size: 42)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(participantName(publicKey, contact: contact))
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text(participantKey(publicKey, contact: contact))
                    .font(.caption)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func participantCell(_ publicKey: String) -> some View {
        let contact = model.nostrContact(publicKey: publicKey)
        VStack(spacing: 7) {
            if let contact {
                NostrContactAvatar(contact: contact, size: 58)
            } else {
                ChatPeerAvatar(contact: nil, publicKey: publicKey, size: 58)
            }
            Text(participantName(publicKey, contact: contact))
                .font(.caption.weight(.semibold))
                .foregroundStyle(TaskifyTheme.primaryText)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .frame(width: 72)
        .accessibilityElement(children: .combine)
    }

    private func participantName(_ publicKey: String, contact: NostrContact?) -> String {
        if publicKey == model.identityPublicKey { return "You" }
        return contact?.displayName ?? "Group Member"
    }

    private func participantKey(_ publicKey: String, contact: NostrContact?) -> String {
        let value: String
        if publicKey == model.identityPublicKey, !model.identityNpub.isEmpty {
            value = model.identityNpub
        } else if let contact {
            value = contact.npub
        } else if let key = NostrPublicKey.parse(publicKey),
                  let npub = NostrPublicKey.npub(from: key) {
            value = npub
        } else {
            value = publicKey
        }
        guard value.count > 26 else { return value }
        return "\(value.prefix(15))…\(value.suffix(8))"
    }

    private func saveName() {
        let name = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !isSaving else { return }
        isSaving = true
        statusMessage = nil
        errorMessage = nil
        Task {
            do {
                let queuedForSync = try await model.renameGroupConversation(
                    groupID: groupID,
                    name: name
                )
                draftName = name
                isEditingName = false
                statusMessage = queuedForSync
                    ? "Group name updated"
                    : "Saved locally; it will sync with the next group message"
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSaving = false
        }
    }
}
