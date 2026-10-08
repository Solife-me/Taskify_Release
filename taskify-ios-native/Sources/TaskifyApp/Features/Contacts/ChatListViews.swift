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

struct StrangerInboxRow: View {
    let threads: [NostrDirectMessageThread]
    let unreadCount: Int

    private var latestPreview: String {
        guard let thread = threads.max(by: {
            $0.latestActivityTimestamp < $1.latestActivityTimestamp
        }) else {
            return "Messages from people outside your contacts"
        }
        if Int(thread.latestCalendarInvite?.receivedAt.timeIntervalSince1970 ?? 0) == thread.latestActivityTimestamp,
           let invite = thread.latestCalendarInvite {
            return "Event invite: \(invite.event.displayTitle)"
        }
        if Int(thread.latestSharedContact?.receivedAt.timeIntervalSince1970 ?? 0) == thread.latestActivityTimestamp,
           let contact = thread.latestSharedContact {
            return contact.isIncoming
                ? "Shared contact: \(contact.contact.primaryName)"
                : "You shared: \(contact.contact.primaryName)"
        }
        if Int(thread.latestSharedTask?.receivedAt.timeIntervalSince1970 ?? 0) == thread.latestActivityTimestamp,
           let task = thread.latestSharedTask {
            return "Shared task: \(task.task.title)"
        }
        if Int(thread.latestSharedBoard?.receivedAt.timeIntervalSince1970 ?? 0) == thread.latestActivityTimestamp,
           let board = thread.latestSharedBoard {
            return "Shared board: \(board.board.boardName ?? "Board")"
        }
        return thread.latestMessage?.displayContent ?? "Messages from people outside your contacts"
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(
                    LinearGradient(
                        colors: [Color.indigo.opacity(0.86), TaskifyTheme.accent.opacity(0.56)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                Image(systemName: "person.crop.circle.badge.questionmark")
                    .font(.system(size: 23, weight: .medium))
                    .foregroundStyle(.white)
            }
            .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Strangers")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    if unreadCount > 0 {
                        Text("\(unreadCount)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(
                                LinearGradient(
                                    colors: [Color(red: 1, green: 0.36, blue: 0.41), Color(red: 1, green: 0.53, blue: 0.44)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                in: Capsule()
                            )
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.bold())
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
                Text(latestPreview)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)
                    .lineLimit(1)
            }
        }
        .padding(12)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(TaskifyTheme.panelFill)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                LinearGradient(
                    colors: [Color.indigo.opacity(0.22), .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.indigo.opacity(0.28), lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}
struct ThreadStructuredPreview {
    var text: String
    var systemImage: String
    var timestamp: Int
    var senderName: String
}

struct DirectMessageThreadRow: View {
    @Environment(AppModel.self) private var model
    let thread: NostrDirectMessageThread
    let contact: NostrContact?
    let group: NostrGroupConversation?
    let isSelf: Bool
    let isMuted: Bool
    let isBlocked: Bool

    private var hasAttention: Bool {
        thread.unreadCount > 0 || thread.actionRequiredCount > 0
    }

    private var latestStructuredPreview: ThreadStructuredPreview? {
        var candidates: [ThreadStructuredPreview] = []
        if let item = thread.latestSharedTask {
            candidates.append(ThreadStructuredPreview(
                text: item.task.title,
                systemImage: item.task.isAssignment ? "person.crop.circle.badge.checkmark" : "checklist",
                timestamp: Int(item.receivedAt.timeIntervalSince1970),
                senderName: item.sender.displayName
            ))
        }
        if let item = thread.latestSharedContact {
            candidates.append(ThreadStructuredPreview(
                text: item.isIncoming
                    ? item.contact.primaryName
                    : "You: \(item.contact.primaryName)",
                systemImage: "person.crop.circle.badge.plus",
                timestamp: Int(item.receivedAt.timeIntervalSince1970),
                senderName: item.isIncoming
                    ? item.sender.displayName
                    : (contact?.displayName ?? shortPublicKey)
            ))
        }
        if let item = thread.latestCalendarInvite {
            candidates.append(ThreadStructuredPreview(
                text: item.event.displayTitle,
                systemImage: "calendar.badge.plus",
                timestamp: Int(item.receivedAt.timeIntervalSince1970),
                senderName: item.sender.displayName
            ))
        }
        if let item = thread.latestSharedBoard {
            candidates.append(ThreadStructuredPreview(
                text: item.board.boardName ?? "Shared board",
                systemImage: "square.grid.2x2",
                timestamp: Int(item.receivedAt.timeIntervalSince1970),
                senderName: item.sender.displayName
            ))
        }
        return candidates.max { $0.timestamp < $1.timestamp }
    }

    private var latestIsStructured: Bool {
        guard let latestStructuredPreview else { return false }
        return latestStructuredPreview.timestamp >= (thread.latestMessage?.createdAt ?? 0)
    }

    var body: some View {
        HStack(spacing: 12) {
            ChatPeerAvatar(
                contact: contact,
                publicKey: thread.peerPublicKey,
                group: group,
                recentMessages: thread.messages
            )

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(group?.displayName ?? contact?.displayName ?? (isSelf ? "You" : nil) ?? latestStructuredPreview?.senderName ?? shortPublicKey)
                        .font(.body.weight(hasAttention ? .bold : .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                    if isMuted {
                        Image(systemName: "bell.slash.fill")
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    }
                    if isBlocked {
                        Image(systemName: "hand.raised.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                    if thread.latestActivityTimestamp > 0 {
                        Text(Self.relativeTime(thread.latestActivityTimestamp))
                            .font(.caption2)
                            .foregroundStyle(TaskifyTheme.tertiaryText)
                    }
                }

                HStack(spacing: 8) {
                    if let preview = latestStructuredPreview, latestIsStructured {
                        Label(
                            isBlocked ? "Blocked sender" : preview.text,
                            systemImage: preview.systemImage
                        )
                            .font(.subheadline)
                            .foregroundStyle(hasAttention ? TaskifyTheme.primaryText : TaskifyTheme.secondaryText)
                            .lineLimit(2)
                    } else if let message = thread.latestMessage {
                        Text(isBlocked ? "Blocked sender" : messagePreview(message))
                            .font(.subheadline)
                            .foregroundStyle(
                                hasAttention
                                    ? TaskifyTheme.primaryText
                                    : TaskifyTheme.secondaryText
                            )
                            .lineLimit(2)
                    }
                    Spacer(minLength: 4)
                    if thread.unreadCount > 0 {
                        Text("\(thread.unreadCount)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(
                                LinearGradient(
                                    colors: [Color(red: 1, green: 0.36, blue: 0.41), Color(red: 1, green: 0.53, blue: 0.44)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                in: Capsule()
                            )
                            .accessibilityLabel("\(thread.unreadCount) unread messages")
                            .accessibilityIdentifier("chatThreadUnreadBadge")
                    }
                    if thread.actionRequiredCount > 0 {
                        Label("\(thread.actionRequiredCount)", systemImage: "checklist")
                            .font(.caption2.bold())
                            .foregroundStyle(TaskifyTheme.accent)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(TaskifyTheme.accent.opacity(0.16), in: Capsule())
                            .accessibilityLabel("\(thread.actionRequiredCount) shared tasks need a response")
                    }
                }
            }

            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.tertiaryText)
                .accessibilityHidden(true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 18)
        .contentShape(Rectangle())
    }

    private var shortPublicKey: String {
        guard let key = NostrPublicKey.parse(thread.peerPublicKey),
              let npub = NostrPublicKey.npub(from: key) else {
            return "Nostr contact"
        }
        return npub.count > 22 ? "\(npub.prefix(12))…\(npub.suffix(6))" : npub
    }

    private func messagePreview(_ message: NostrDirectMessage) -> String {
        guard message.isIncoming else { return "You: \(message.displayContent)" }
        guard group != nil else { return message.displayContent }
        let sender = modelName(for: message.senderPublicKey)
        return "\(sender): \(message.displayContent)"
    }

    private func modelName(for publicKey: String) -> String {
        model.nostrContact(publicKey: publicKey)?.displayName ?? "Member"
    }

    private static func relativeTime(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

struct ChatMessageSearchResultRow: View {
    let result: ChatMessageSearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: result.message.attachment == nil ? "text.bubble.fill" : "paperclip")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 34, height: 34)
                .background(TaskifyTheme.accent.opacity(0.14), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(result.conversationName)
                        .font(.subheadline.bold())
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                    Text("·")
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                    Text(result.senderName)
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(relativeTime)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                Text(result.message.displayContent)
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(TaskifyTheme.tertiaryText)
                .padding(.top, 10)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .taskifyGlass(cornerRadius: 18)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Message from \(result.senderName) in \(result.conversationName): \(result.message.displayContent)"
        )
    }

    private var relativeTime: String {
        let date = Date(timeIntervalSince1970: TimeInterval(result.message.createdAt))
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

struct ChatPeerAvatar: View {
    let contact: NostrContact?
    let publicKey: String
    var size: CGFloat = 46
    var group: NostrGroupConversation? = nil
    var recentMessages: [NostrDirectMessage] = []

    var body: some View {
        Group {
            if let group {
                ChatGroupAvatar(
                    group: group,
                    recentMessages: recentMessages,
                    size: size
                )
            } else if let contact {
                NostrContactAvatar(contact: contact, size: size)
            } else {
                ZStack {
                    Circle().fill(TaskifyTheme.accent.opacity(0.22))
                    Image(systemName: "person.fill")
                        .font(.system(size: size * 0.38))
                        .foregroundStyle(TaskifyTheme.primaryText)
                }
                .frame(width: size, height: size)
                .overlay(Circle().stroke(TaskifyTheme.border, lineWidth: 1))
            }
        }
        .accessibilityHidden(true)
    }
}

struct ChatGroupAvatarMember: Identifiable {
    let id: String
    let contact: NostrContact?
    let isCurrentUser: Bool

    var initials: String {
        if let contact { return contact.initials }
        return isCurrentUser ? "Y" : "?"
    }
}

struct ChatGroupAvatar: View {
    @Environment(AppModel.self) private var model
    let group: NostrGroupConversation
    let recentMessages: [NostrDirectMessage]
    let size: CGFloat

    private var members: [ChatGroupAvatarMember] {
        let memberKeys = group.memberPublicKeys.map { $0.lowercased() }
        let memberKeySet = Set(memberKeys)
        var recentKeys: [String] = []
        var seen = Set<String>()

        for message in recentMessages.reversed() {
            let key = message.senderPublicKey.lowercased()
            guard memberKeySet.contains(key), seen.insert(key).inserted else { continue }
            recentKeys.append(key)
            if recentKeys.count == 4 { break }
        }

        let remainingKeys = memberKeys
            .filter { !seen.contains($0) }
            .enumerated()
            .sorted { left, right in
                let leftHasPhoto = model.nostrContact(publicKey: left.element)?.pictureURL != nil
                let rightHasPhoto = model.nostrContact(publicKey: right.element)?.pictureURL != nil
                if leftHasPhoto != rightHasPhoto { return leftHasPhoto && !rightHasPhoto }
                return left.offset < right.offset
            }
            .map(\.element)

        return (recentKeys + remainingKeys).prefix(4).map { key in
            ChatGroupAvatarMember(
                id: key,
                contact: model.nostrContact(publicKey: key),
                isCurrentUser: key == model.identityPublicKey.lowercased()
            )
        }
    }

    var body: some View {
        let members = members
        ZStack {
            Circle().fill(TaskifyTheme.accent.opacity(0.14))
            ForEach(Array(members.enumerated()), id: \.element.id) { index, member in
                let layout = Self.layout(for: members.count, index: index)
                memberAvatar(member, diameter: size * layout.diameter)
                    .position(x: size * layout.x, y: size * layout.y)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(TaskifyTheme.border, lineWidth: 1))
    }

    @ViewBuilder
    private func memberAvatar(_ member: ChatGroupAvatarMember, diameter: CGFloat) -> some View {
        Group {
            if let contact = member.contact {
                NostrContactAvatar(contact: contact, size: diameter)
            } else {
                ZStack {
                    LinearGradient(
                        colors: [Color(red: 0.43, green: 0.36, blue: 0.61),
                                 Color(red: 0.31, green: 0.27, blue: 0.49)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    Text(member.initials)
                        .font(.system(size: diameter * 0.38, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: diameter, height: diameter)
                .clipShape(Circle())
                .overlay(Circle().stroke(Color.black.opacity(0.28), lineWidth: 1))
            }
        }
        .frame(width: diameter, height: diameter)
    }

    private struct MemberLayout {
        let x: CGFloat
        let y: CGFloat
        let diameter: CGFloat
    }

    private static func layout(for count: Int, index: Int) -> MemberLayout {
        let layouts: [[MemberLayout]] = [
            [MemberLayout(x: 0.50, y: 0.50, diameter: 0.64)],
            [
                MemberLayout(x: 0.37, y: 0.41, diameter: 0.58),
                MemberLayout(x: 0.67, y: 0.65, diameter: 0.50),
            ],
            [
                MemberLayout(x: 0.34, y: 0.47, diameter: 0.54),
                MemberLayout(x: 0.73, y: 0.27, diameter: 0.37),
                MemberLayout(x: 0.73, y: 0.70, diameter: 0.41),
            ],
            [
                MemberLayout(x: 0.28, y: 0.28, diameter: 0.40),
                MemberLayout(x: 0.75, y: 0.25, diameter: 0.34),
                MemberLayout(x: 0.24, y: 0.73, diameter: 0.34),
                MemberLayout(x: 0.72, y: 0.71, diameter: 0.43),
            ],
        ]
        let safeCount = min(max(count, 1), 4)
        return layouts[safeCount - 1][min(index, safeCount - 1)]
    }
}

struct NewGroupConversationSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var searchText = ""
    @State private var selectedKeys = Set<String>()
    @State private var errorMessage: String?
    @State private var isNamingGroup = false
    let onCreate: (String) -> Void

    private var contacts: [NostrContact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.nostrContacts }
        return model.nostrContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
    }

    private var selectedContacts: [NostrContact] {
        model.nostrContacts.filter { selectedKeys.contains($0.publicKey) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isNamingGroup {
                    list
                } else {
                    // Plain `.searchable` gives the search bar its own working Cancel button.
                    // Forcing it always-presented via a constant `isPresented` binding made that
                    // Cancel a no-op: the keyboard could never be dismissed, and it covered the
                    // participant list.
                    list.searchable(text: $searchText, prompt: "Search contacts")
                }
            }
            .overlay {
                if model.nostrContacts.isEmpty {
                    ContentUnavailableView(
                        "No Contacts Yet",
                        systemImage: "person.3",
                        description: Text("Add or sync contacts before creating a group.")
                    )
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background)
            .navigationTitle(isNamingGroup ? "New Group" : "Add Participants")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isNamingGroup ? "Back" : "Cancel") {
                        if isNamingGroup {
                            withAnimation(.easeInOut(duration: 0.2)) { isNamingGroup = false }
                        } else {
                            dismiss()
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isNamingGroup {
                        Button("Create") { create() }
                            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Button("Next") {
                            withAnimation(.easeInOut(duration: 0.2)) { isNamingGroup = true }
                        }
                        .disabled(
                            selectedKeys.count < 2 ||
                                selectedKeys.count >= NostrGroupConversation.maximumMemberCount
                        )
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }

    private var list: some View {
        List {
            if isNamingGroup {
                namingSections
            } else {
                participantSelectionSection
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder
    private var namingSections: some View {
        Section("Group Name") {
            TextField("Name this group", text: $name)
                .font(.body)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .onSubmit {
                    if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        create()
                    }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }

        Section("Members · \(selectedKeys.count + 1)") {
            HStack(spacing: 12) {
                ChatPeerAvatar(
                    contact: model.nostrContact(publicKey: model.identityPublicKey),
                    publicKey: model.identityPublicKey,
                    size: 40
                )
                participantLabel(name: "You", subtitle: "Group creator")
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            ForEach(selectedContacts) { contact in
                HStack(spacing: 12) {
                    NostrContactAvatar(contact: contact, size: 40)
                    participantLabel(name: contact.displayName, subtitle: contact.subtitle)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
    }

    private var participantSelectionSection: some View {
        Section {
            ForEach(contacts) { contact in
                Button {
                    toggle(contact.publicKey)
                } label: {
                    HStack(spacing: 12) {
                        NostrContactAvatar(contact: contact, size: 40)
                        participantLabel(name: contact.displayName, subtitle: contact.subtitle)
                        Spacer()
                        Image(systemName: selectedKeys.contains(contact.publicKey)
                              ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(selectedKeys.contains(contact.publicKey)
                                             ? TaskifyTheme.accent : TaskifyTheme.secondaryText)
                    }
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        } header: {
            Text("People · \(selectedKeys.count + 1)/\(NostrGroupConversation.maximumMemberCount)")
                .listRowBackground(Color.clear)
        } footer: {
            Text("Select at least two people. Group membership and messages are end-to-end encrypted.")
                .listRowBackground(Color.clear)
        }
    }

    private func participantLabel(name: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
                .foregroundStyle(TaskifyTheme.primaryText)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
    }

    private func toggle(_ key: String) {
        if selectedKeys.contains(key) {
            selectedKeys.remove(key)
        } else if selectedKeys.count < NostrGroupConversation.maximumMemberCount - 1 {
            selectedKeys.insert(key)
        }
    }

    private func create() {
        do {
            let groupID = try model.createGroupConversation(
                name: name,
                memberPublicKeys: Array(selectedKeys)
            )
            onCreate(groupID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct NewConversationSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    let onSelect: (String) -> Void
    let onNewGroup: () -> Void

    private var contacts: [NostrContact] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.nostrContacts }
        return model.nostrContacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
                $0.subtitle.localizedCaseInsensitiveContains(query) ||
                $0.npub.localizedCaseInsensitiveContains(query)
        }
    }

    private var selfMatchesSearch: Bool {
        guard !model.identityPublicKey.isEmpty else { return false }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return "message yourself".localizedCaseInsensitiveContains(query) ||
            "you".localizedCaseInsensitiveContains(query) ||
            model.identityNpub.localizedCaseInsensitiveContains(query)
    }

    var body: some View {
        NavigationStack {
            List {
                Button(action: onNewGroup) {
                    HStack(spacing: 12) {
                        Image(systemName: "person.3.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 42, height: 42)
                            .background(TaskifyTheme.accent, in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text("New Group")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text("Start an encrypted group conversation")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                    }
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                if selfMatchesSearch {
                    Button {
                        onSelect(model.identityPublicKey)
                    } label: {
                        HStack(spacing: 12) {
                            ChatPeerAvatar(
                                contact: model.nostrContact(publicKey: model.identityPublicKey),
                                publicKey: model.identityPublicKey,
                                size: 42
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Message Yourself")
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text("Keep private notes in your own encrypted chat")
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .accessibilityLabel("Message yourself")
                }

                ForEach(contacts) { contact in
                    Button {
                        onSelect(contact.publicKey)
                    } label: {
                        HStack(spacing: 12) {
                            NostrContactAvatar(contact: contact, size: 42)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(contact.displayName)
                                    .foregroundStyle(TaskifyTheme.primaryText)
                                Text(contact.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background)
            .navigationTitle("New Message")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search contacts")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }
}

struct ShareContactPickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var sendingContactID: String?
    let onSelect: (NostrContact) async -> Bool

    private var contacts: [NostrContact] {
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
            List(contacts) { contact in
                Button {
                    guard sendingContactID == nil else { return }
                    sendingContactID = contact.id
                    Task {
                        if await onSelect(contact) { dismiss() }
                        sendingContactID = nil
                    }
                } label: {
                    HStack(spacing: 12) {
                        NostrContactAvatar(contact: contact, size: 42)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(contact.displayName)
                                .foregroundStyle(TaskifyTheme.primaryText)
                            Text(contact.subtitle)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                        }
                        Spacer()
                        if sendingContactID == contact.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "paperplane")
                                .foregroundStyle(TaskifyTheme.accent)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(sendingContactID != nil)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .overlay {
                if model.nostrContacts.isEmpty {
                    ContentUnavailableView(
                        "No Contacts to Share",
                        systemImage: "person.crop.circle.badge.plus",
                        description: Text("Add or sync contacts before sharing one.")
                    )
                }
            }
            .scrollContentBackground(.hidden)
            .background(TaskifyTheme.background)
            .navigationTitle("Share Contact")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search contacts")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(sendingContactID != nil)
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(TaskifyTheme.accent)
    }
}
