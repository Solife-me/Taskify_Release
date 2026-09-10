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

private struct ChatConversationRoute: Hashable {
    let peerPublicKey: String
    let timelineItemID: String?

    init(peerPublicKey: String, timelineItemID: String? = nil) {
        self.peerPublicKey = peerPublicKey
        self.timelineItemID = timelineItemID
    }
}

private struct ChatMessageSearchHit: Identifiable {
    let thread: NostrDirectMessageThread
    let message: NostrDirectMessage
    let conversationName: String
    let senderName: String

    var id: String { "\(thread.peerPublicKey):\(message.id)" }
    var route: ChatConversationRoute {
        ChatConversationRoute(
            peerPublicKey: thread.peerPublicKey,
            timelineItemID: "message-\(message.id)"
        )
    }
}

struct ContactsView: View {
    @Environment(AppModel.self) private var model
    @State private var navigationPath: [ChatConversationRoute] = []
    @State private var searchText = ""
    @State private var showingContactDirectory = false
    @State private var showingNewConversation = false
    @State private var showingNewGroup = false
    @State private var showingStrangers = false
    @State private var threadPendingDeletion: NostrDirectMessageThread?
    @FocusState private var searchFocused: Bool

    private var ownContact: NostrContact? {
        guard !model.identityPublicKey.isEmpty else { return nil }
        // Falls back to the published profile so the header avatar shows your picture and name
        // even before you appear in your own contact directory.
        return model.nostrContact(publicKey: model.identityPublicKey) ?? model.ownContactRepresentation
    }

    private var activeThreads: [NostrDirectMessageThread] {
        model.directMessageThreads
    }

    private func strangerThreads(
        in activeThreads: [NostrDirectMessageThread]
    ) -> [NostrDirectMessageThread] {
        activeThreads.filter { thread in
            model.groupConversation(id: thread.peerPublicKey) == nil &&
                model.nostrContact(publicKey: thread.peerPublicKey) == nil &&
                thread.peerPublicKey != model.identityPublicKey
        }
    }

    private func familiarThreads(
        in activeThreads: [NostrDirectMessageThread],
        strangerThreads: [NostrDirectMessageThread]
    ) -> [NostrDirectMessageThread] {
        let strangerIDs = Set(strangerThreads.map(\.peerPublicKey))
        return activeThreads.filter { !strangerIDs.contains($0.peerPublicKey) }
    }

    private func strangerUnreadCount(
        in strangerThreads: [NostrDirectMessageThread]
    ) -> Int {
        strangerThreads.reduce(0) { $0 + $1.unreadCount + $1.actionRequiredCount }
    }

    private func filteredThreads(
        activeThreads: [NostrDirectMessageThread],
        strangerThreads: [NostrDirectMessageThread],
        familiarThreads: [NostrDirectMessageThread]
    ) -> [NostrDirectMessageThread] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = query.isEmpty
            ? (showingStrangers ? strangerThreads : familiarThreads)
            : activeThreads
        guard !query.isEmpty else { return source }
        return source.filter { thread in
            let contact = model.nostrContact(publicKey: thread.peerPublicKey)
            let group = model.groupConversation(id: thread.peerPublicKey)
            return contact?.displayName.localizedCaseInsensitiveContains(query) == true ||
                group?.displayName.localizedCaseInsensitiveContains(query) == true ||
                contact?.subtitle.localizedCaseInsensitiveContains(query) == true ||
                thread.peerPublicKey.localizedCaseInsensitiveContains(query) ||
                thread.sharedTasks.contains { item in
                    item.task.title.localizedCaseInsensitiveContains(query) ||
                        item.task.note?.localizedCaseInsensitiveContains(query) == true ||
                        item.sender.displayName.localizedCaseInsensitiveContains(query)
                } || thread.sharedContacts.contains { item in
                    item.contact.primaryName.localizedCaseInsensitiveContains(query) ||
                        item.contact.npub.localizedCaseInsensitiveContains(query) ||
                        item.contact.nip05?.localizedCaseInsensitiveContains(query) == true
                } || thread.calendarInvites.contains { item in
                    item.event.displayTitle.localizedCaseInsensitiveContains(query) ||
                        item.event.start?.localizedCaseInsensitiveContains(query) == true
                } || thread.sharedBoards.contains { item in
                    (item.board.boardName ?? "Shared board").localizedCaseInsensitiveContains(query)
                }
        }
    }

    private func messageSearchResults(
        in activeThreads: [NostrDirectMessageThread]
    ) -> [ChatMessageSearchHit] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return Array(
            activeThreads
                .flatMap { thread -> [ChatMessageSearchHit] in
                    let contact = model.nostrContact(publicKey: thread.peerPublicKey)
                    let group = model.groupConversation(id: thread.peerPublicKey)
                    let conversationName = group?.displayName
                        ?? contact?.displayName
                        ?? (thread.peerPublicKey == model.identityPublicKey ? "You" : nil)
                        ?? "Conversation"
                    return thread.messages.compactMap { message in
                        let sender = message.isIncoming
                            ? (model.nostrContact(publicKey: message.senderPublicKey)?.displayName
                                ?? conversationName)
                            : "You"
                        guard message.matchesSearch(query, senderName: sender) else { return nil }
                        return ChatMessageSearchHit(
                            thread: thread,
                            message: message,
                            conversationName: conversationName,
                            senderName: sender
                        )
                    }
                }
                .sorted {
                    if $0.message.createdAt != $1.message.createdAt {
                        return $0.message.createdAt > $1.message.createdAt
                    }
                    return $0.id < $1.id
                }
                .prefix(100)
        )
    }

    var body: some View {
        let activeThreads = activeThreads
        let strangerThreads = strangerThreads(in: activeThreads)
        let familiarThreads = familiarThreads(
            in: activeThreads,
            strangerThreads: strangerThreads
        )
        let filteredThreads = filteredThreads(
            activeThreads: activeThreads,
            strangerThreads: strangerThreads,
            familiarThreads: familiarThreads
        )
        let messageSearchResults = messageSearchResults(in: activeThreads)
        let strangerUnreadCount = strangerUnreadCount(in: strangerThreads)
        let chatRows = NostrChatListItem.rows(
            threads: filteredThreads,
            strangerThreads: searchText.isEmpty && !showingStrangers ? strangerThreads : []
        )

        return NavigationStack(path: $navigationPath) {
            VStack(alignment: .leading, spacing: 0) {
                header
                searchBar

                if activeThreads.isEmpty {
                    ScrollView {
                        emptyState
                            .padding(.horizontal, 18)
                            .padding(.top, 30)
                    }
                } else if filteredThreads.isEmpty,
                          messageSearchResults.isEmpty,
                          (showingStrangers || !searchText.isEmpty) {
                    ScrollView {
                        if showingStrangers && searchText.isEmpty {
                            ContentUnavailableView(
                                "No Stranger Messages",
                                systemImage: "person.crop.circle.badge.checkmark",
                                description: Text("Messages from people outside your contacts will appear here.")
                            )
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .padding(.top, 50)
                        } else {
                            ContentUnavailableView.search(text: searchText)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .padding(.top, 50)
                        }
                    }
                } else {
                    List {
                        if !messageSearchResults.isEmpty {
                            Section {
                                ForEach(messageSearchResults) { result in
                                    NavigationLink(value: result.route) {
                                        ChatMessageSearchResultRow(result: result)
                                    }
                                    .buttonStyle(.plain)
                                    .listRowBackground(Color.clear)
                                    .listRowSeparator(.hidden)
                                    .listRowInsets(EdgeInsets(
                                        top: 5,
                                        leading: 18,
                                        bottom: 5,
                                        trailing: 18
                                    ))
                                }
                            } header: {
                                Text("Messages")
                                    .font(.caption.bold())
                                    .foregroundStyle(TaskifyTheme.tertiaryText)
                            }
                        }

                        ForEach(chatRows) { row in
                            switch row {
                            case .strangers:
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) { showingStrangers = true }
                                } label: {
                                    StrangerInboxRow(
                                        threads: strangerThreads,
                                        unreadCount: strangerUnreadCount
                                    )
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 5, leading: 18, bottom: 5, trailing: 18))
                            case .thread(let thread):
                                NavigationLink(value: ChatConversationRoute(
                                    peerPublicKey: thread.peerPublicKey
                                )) {
                                    DirectMessageThreadRow(
                                        thread: thread,
                                        contact: thread.peerPublicKey == model.identityPublicKey
                                            ? ownContact
                                            : model.nostrContact(publicKey: thread.peerPublicKey),
                                        group: model.groupConversation(id: thread.peerPublicKey),
                                        isSelf: thread.peerPublicKey == model.identityPublicKey,
                                        isMuted: model.isDirectMessageGroupMuted(thread.peerPublicKey),
                                        isBlocked: model.isDirectMessagePeerBlocked(thread.peerPublicKey)
                                    )
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 5, leading: 18, bottom: 5, trailing: 18))
                                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                    Button {
                                        archive(thread)
                                    } label: {
                                        Label("Archive", systemImage: "archivebox")
                                    }
                                    .tint(.indigo)
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) {
                                        threadPendingDeletion = thread
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                                .contextMenu {
                                    Button {
                                        archive(thread)
                                    } label: {
                                        Label("Archive Conversation", systemImage: "archivebox")
                                    }
                                    Button(role: .destructive) {
                                        threadPendingDeletion = thread
                                    } label: {
                                        Label("Delete Conversation", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .scrollIndicators(.hidden)
                    .scrollDismissesKeyboard(.interactively)
                    .contentMargins(.bottom, 90, for: .scrollContent)
                }
            }
            .onChange(of: navigationPath) { _, _ in
                // Leaving the search field behind when a thread (or search result) opens; the
                // pushed conversation manages its own keyboard.
                searchFocused = false
            }
            // NavigationStack supplies an opaque dark surface of its own, so the root tab's
            // backdrop cannot show through it. Render the shared backdrop inside the stack.
            .background(TaskifyAppBackground())
            .navigationDestination(for: ChatConversationRoute.self) { route in
                DirectMessageConversationView(
                    peerPublicKey: route.peerPublicKey,
                    initialTimelineItemID: route.timelineItemID
                )
                    .environment(model)
            }
        }
        .sheet(isPresented: $showingContactDirectory) {
            NostrContactsDirectoryView()
                .environment(model)
        }
        .fullScreenCover(isPresented: $showingNewConversation) {
            NewConversationSheet { peerPublicKey in
                showingNewConversation = false
                navigationPath.append(ChatConversationRoute(peerPublicKey: peerPublicKey))
            } onNewGroup: {
                showingNewConversation = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    showingNewGroup = true
                }
            }
            .environment(model)
        }
        .fullScreenCover(isPresented: $showingNewGroup) {
            NewGroupConversationSheet { groupID in
                showingNewGroup = false
                navigationPath.append(ChatConversationRoute(peerPublicKey: groupID))
            }
            .environment(model)
        }
        .task {
            model.refreshContactsIfNeeded()
#if DEBUG
            switch ProcessInfo.processInfo.environment["TASKIFY_CHAT_SHEET"] {
            case "newConversation": showingNewConversation = true
            case "newGroup": showingNewGroup = true
            default: break
            }
#endif
        }
        .confirmationDialog(
            "Delete this conversation?",
            isPresented: Binding(
                get: { threadPendingDeletion != nil },
                set: { if !$0 { threadPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Conversation", role: .destructive) {
                guard let thread = threadPendingDeletion else { return }
                model.deleteDirectMessageThread(peerPublicKey: thread.peerPublicKey)
                threadPendingDeletion = nil
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
            Button("Cancel", role: .cancel) { threadPendingDeletion = nil }
        } message: {
            Text("This removes the local history and briefly suppresses relay replays so the conversation stays deleted.")
        }
    }

    private var header: some View {
        ZStack {
            Text(showingStrangers ? "Strangers" : "Chat")
                .taskifyScreenTitle()

            HStack(spacing: 10) {
                if showingStrangers {
                    HeaderIconButton(systemName: "chevron.left", accessibilityLabel: "Back to conversations") {
                        withAnimation(.easeInOut(duration: 0.2)) { showingStrangers = false }
                    }
                } else {
                    Button {
                        searchFocused = false
                        showingContactDirectory = true
                    } label: {
                        ChatPeerAvatar(
                            contact: ownContact,
                            publicKey: model.identityPublicKey,
                            size: 42
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open contacts and profile")
                }

                Spacer()

                if showingStrangers {
                    Color.clear.frame(width: 42, height: 42)
                } else {
                    HeaderIconButton(
                        systemName: "plus",
                        accent: true,
                        accessibilityLabel: "New message"
                    ) {
                        searchFocused = false
                        showingNewConversation = true
                    }
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 9)
        .padding(.bottom, 5)
    }

    private var searchBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)

            TextField(showingStrangers ? "Search strangers" : "Search", text: $searchText)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
                .onSubmit { searchFocused = false }

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }

            // The only exit from the keyboard once this custom field is focused. Without it a
            // focused field with no results traps the screen: the keyboard hides the tab bar and
            // there is nothing outside the field to tap that would resign focus.
            if searchFocused || !searchText.isEmpty {
                Button("Cancel") {
                    searchText = ""
                    searchFocused = false
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TaskifyTheme.accent)
                .accessibilityLabel("Close search")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 42)
        .taskifyGlassControl(in: Capsule())
        .padding(.horizontal, 18)
        .padding(.vertical, 7)
    }

    private func archive(_ thread: NostrDirectMessageThread) {
        model.archiveDirectMessageThread(peerPublicKey: thread.peerPublicKey)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "message.badge.waveform.fill")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(TaskifyTheme.accent)
            Text("No messages yet")
                .font(.headline)
            Text("Start a private conversation or wait for an incoming Nostr message.")
                .font(.subheadline)
                .foregroundStyle(TaskifyTheme.secondaryText)
                .multilineTextAlignment(.center)
            Button {
                searchFocused = false
                showingNewConversation = true
            } label: {
                Label("Start a Conversation", systemImage: "square.and.pencil")
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 28)
        .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TaskifyTheme.border, style: StrokeStyle(lineWidth: 1, dash: [6, 5]))
        )
    }
}

private struct StrangerInboxRow: View {
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

private struct ThreadStructuredPreview {
    var text: String
    var systemImage: String
    var timestamp: Int
    var senderName: String
}

private struct DirectMessageThreadRow: View {
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
        }
        .padding(12)
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

private struct ChatMessageSearchResultRow: View {
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

private struct ChatPeerAvatar: View {
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

private struct ChatGroupAvatarMember: Identifiable {
    let id: String
    let contact: NostrContact?
    let isCurrentUser: Bool

    var initials: String {
        if let contact { return contact.initials }
        return isCurrentUser ? "Y" : "?"
    }
}

private struct ChatGroupAvatar: View {
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

private struct NewGroupConversationSheet: View {
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

private struct NewConversationSheet: View {
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

private struct ShareContactPickerSheet: View {
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

enum ConversationDetailsTab: String, CaseIterable, Identifiable {
    case info = "Info"
    case photos = "Photos"
    case files = "Files"
    case links = "Links"

    var id: String { rawValue }
}

private struct ConversationSharedPhoto: Identifiable {
    let id: String
    let url: URL
    let attachment: NostrDirectMessageAttachment?
}

private struct ConversationSharedFile: Identifiable {
    let id: String
    let attachment: NostrDirectMessageAttachment
    let senderPublicKey: String
    let createdAt: Int
}

private struct ConversationSharedLink: Identifiable {
    let id: String
    let url: URL
    let senderPublicKey: String
    let createdAt: Int
}

private enum ConversationSharedContent {
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

private struct ConversationFileRow: View {
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

private struct GroupConversationDetailsView: View {
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

private enum ChatTimelineItem: Identifiable, Equatable {
    case message(NostrDirectMessage)
    case sharedTask(SharedInboxItem)
    case sharedContact(SharedContactInboxItem)
    case calendarInvite(SharedCalendarInviteInboxItem)
    case sharedBoard(SharedBoardInboxItem)

    var id: String {
        switch self {
        case let .message(message): "message-\(message.id)"
        case let .sharedTask(item): "shared-task-\(item.id)"
        case let .sharedContact(item): "shared-contact-\(item.id)"
        case let .calendarInvite(item): "calendar-invite-\(item.id)"
        case let .sharedBoard(item): "shared-board-\(item.id)"
        }
    }

    var timestamp: Int {
        switch self {
        case let .message(message): message.createdAt
        case let .sharedTask(item): Int(item.receivedAt.timeIntervalSince1970)
        case let .sharedContact(item): Int(item.receivedAt.timeIntervalSince1970)
        case let .calendarInvite(item): Int(item.receivedAt.timeIntervalSince1970)
        case let .sharedBoard(item): Int(item.receivedAt.timeIntervalSince1970)
        }
    }

    func matchesSearch(_ query: String, senderName: (String) -> String) -> Bool {
        switch self {
        case let .message(message):
            message.matchesSearch(query, senderName: senderName(message.senderPublicKey))
        case let .sharedTask(item):
            item.task.title.localizedCaseInsensitiveContains(query) ||
                item.task.note?.localizedCaseInsensitiveContains(query) == true ||
                item.sender.displayName.localizedCaseInsensitiveContains(query)
        case let .sharedContact(item):
            item.contact.primaryName.localizedCaseInsensitiveContains(query) ||
                item.contact.npub.localizedCaseInsensitiveContains(query) ||
                item.contact.nip05?.localizedCaseInsensitiveContains(query) == true
        case let .calendarInvite(item):
            item.event.displayTitle.localizedCaseInsensitiveContains(query) ||
                item.event.start?.localizedCaseInsensitiveContains(query) == true ||
                item.sender.displayName.localizedCaseInsensitiveContains(query)
        case let .sharedBoard(item):
            (item.board.boardName ?? "Shared board").localizedCaseInsensitiveContains(query) ||
                item.sender.displayName.localizedCaseInsensitiveContains(query)
        }
    }
}

private struct ChatConversationPresentation {
    let timeline: [ChatTimelineItem]
    let lastSentItemID: String?
    let messageLookup: [String: NostrDirectMessage]
    let reactionLookup: [String: [NostrDirectMessageReaction]]
    let senderContacts: [String: NostrContact]
    let senderNames: [String: String]
    let structuredSenderName: String?
}

/// A conversation owns only its current snapshot projection and a bounded amount of parsed
/// syntax. Composer edits and upload progress must not sort the history or reparse visible
/// messages. Nothing is persisted; the owner clears this cache when leaving or backgrounding.
@MainActor
private final class ChatConversationRenderCache: Equatable {
    private struct Key: Equatable {
        let revision: Int
        let identity: String
        let peer: String
    }

    private final class DocumentBox: NSObject {
        let value: NostrChatMarkdownDocument
        init(_ value: NostrChatMarkdownDocument) { self.value = value }
    }

    private final class InlineBox: NSObject {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private var key: Key?
    private var currentPresentation: ChatConversationPresentation?
    private var searchQuery: String?
    private var currentSearchResults: [ChatTimelineItem] = []
    private let documents = NSCache<NSString, DocumentBox>()
    private let inlines = NSCache<NSString, InlineBox>()

    init() {
        documents.countLimit = 128
        documents.totalCostLimit = 1_024 * 1_024
        inlines.countLimit = 512
        inlines.totalCostLimit = 1_024 * 1_024
    }

    nonisolated static func == (lhs: ChatConversationRenderCache, rhs: ChatConversationRenderCache) -> Bool {
        lhs === rhs
    }

    func presentation(
        revision: Int,
        identity: String,
        peer: String,
        build: () -> ChatConversationPresentation
    ) -> ChatConversationPresentation {
        let nextKey = Key(revision: revision, identity: identity, peer: peer)
        if key == nextKey, let currentPresentation { return currentPresentation }
        if let key, key.identity != identity || key.peer != peer { clear() }
        let value = build()
        key = nextKey
        currentPresentation = value
        searchQuery = nil
        currentSearchResults = []
        return value
    }

    func searchResults(query: String, build: () -> [ChatTimelineItem]) -> [ChatTimelineItem] {
        if searchQuery == query { return currentSearchResults }
        let value = query.isEmpty ? [] : build()
        searchQuery = query
        currentSearchResults = value
        return value
    }

    func document(_ text: String) -> NostrChatMarkdownDocument {
        if let cached = documents.object(forKey: text as NSString) { return cached.value }
        let value = NostrChatMarkdown.document(text)
        let cost = text.utf8.count
        if cost <= 128 * 1_024 {
            documents.setObject(DocumentBox(value), forKey: text as NSString, cost: cost * 4)
        }
        return value
    }

    func inline(_ text: String) -> AttributedString {
        if let cached = inlines.object(forKey: text as NSString) { return cached.value }
        let value = NostrChatMarkdown.inlineAttributedString(text)
        let cost = text.utf8.count
        if cost <= 128 * 1_024 {
            inlines.setObject(InlineBox(value), forKey: text as NSString, cost: cost * 4)
        }
        return value
    }

    func clear() {
        key = nil
        currentPresentation = nil
        searchQuery = nil
        currentSearchResults = []
        documents.removeAllObjects()
        inlines.removeAllObjects()
    }
}

/// Owns the staged plaintext until the user removes it or the send is queued.
private final class ChatAttachmentDraft: Identifiable {
    let id = UUID()
    let fileURL: URL
    let name: String
    let mimeType: String
    let size: Int
    var uploadedAttachment: NostrDirectMessageAttachment?

    init(fileURL: URL, name: String, mimeType: String, size: Int) {
        self.fileURL = fileURL; self.name = name; self.mimeType = mimeType; self.size = size
    }

    deinit { try? FileManager.default.removeItem(at: fileURL) }
}

private final class ChatPasteTextView: UITextView {
    var pasteAttachment: (([NSItemProvider]) -> Bool)?
    private var shouldFocusWhenAttached = false

    @discardableResult
    func requestFocus() -> Bool {
        shouldFocusWhenAttached = true
        guard window != nil, isEditable, isUserInteractionEnabled else { return false }
        return isFirstResponder || becomeFirstResponder()
    }

    func dismissFocus() {
        shouldFocusWhenAttached = false
        if isFirstResponder { resignFirstResponder() }
    }

    func markFocusEnded() {
        shouldFocusWhenAttached = false
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, shouldFocusWhenAttached else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil, self.shouldFocusWhenAttached else { return }
            self.requestFocus()
        }
    }

    override func paste(itemProviders: [NSItemProvider]) {
        if pasteAttachment?(itemProviders) == true { return }
        super.paste(itemProviders: itemProviders)
    }

    override func paste(_ sender: Any?) {
        if pasteAttachment?(UIPasteboard.general.itemProviders) == true { return }
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        // An image/file-only clipboard is attachable but not pasteable text, and UIKit
        // would otherwise hide the Paste item entirely. Keep it offered so the paste
        // override can stage the clipboard contents as an attachment. The has* family is
        // metadata-only, so building the menu never reads pasteboard contents (which
        // would trigger the system paste-permission prompt).
        if action == #selector(paste(_:)),
           UIPasteboard.general.hasImages || UIPasteboard.general.hasURLs {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }
}

private struct ChatComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let isFocused: FocusState<Bool>.Binding
    let isEnabled: Bool
    let dismissKeyboard: Bool
    let accessibilityLabel: String
    let onSubmit: () -> Void
    let pasteAttachment: ([NSItemProvider]) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> ChatPasteTextView {
        let view = ChatPasteTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(TaskifyTheme.primaryText)
        view.tintColor = UIColor(TaskifyTheme.accent)
        view.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        view.textContainer.lineFragmentPadding = 0
        // Scrolling stays enabled for the composer's whole life: toggling it as the text
        // grows resets contentOffset and corrupts contentSize/caret geometry, which left
        // the caret stranded below the fold. While the text fits the (externally sized)
        // frame nothing scrolls; once SwiftUI caps the height the same view pans and
        // tracks the caret natively.
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.returnKeyType = .send
        // Draft scrolling belongs to the editor, including downward drags near
        // the keyboard. Only a drag that starts in the conversation dismisses it.
        view.keyboardDismissMode = .none
        view.pasteConfiguration = UIPasteConfiguration(
            acceptableTypeIdentifiers: [UTType.item.identifier]
        )
        view.accessibilityLabel = accessibilityLabel
        view.pasteAttachment = pasteAttachment
        let tapRecognizer = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.focusComposer(_:))
        )
        tapRecognizer.cancelsTouchesInView = false
        view.addGestureRecognizer(tapRecognizer)
        return view
    }

    func updateUIView(_ view: ChatPasteTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.isEditable = isEnabled
        view.accessibilityLabel = accessibilityLabel
        view.pasteAttachment = pasteAttachment

        if dismissKeyboard {
            view.dismissFocus()
        } else if isFocused.wrappedValue {
            view.requestFocus()
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ChatPasteTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitting = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        )
        let lineHeight = uiView.font?.lineHeight ?? 20
        let insetHeight = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let maximumHeight = lineHeight * 15 + insetHeight
        let height = min(max(fitting.height, 42), maximumHeight)
        return CGSize(width: width, height: height)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposerTextView

        init(parent: ChatComposerTextView) { self.parent = parent }

        @objc func focusComposer(_ recognizer: UITapGestureRecognizer) {
            guard recognizer.state == .ended,
                  parent.isEnabled,
                  let textView = recognizer.view as? ChatPasteTextView else { return }
            textView.requestFocus()
            if !parent.isFocused.wrappedValue {
                parent.isFocused.wrappedValue = true
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
            scrollCaretIntoView(textView)
        }

        /// Once the draft exceeds the composer's height cap, keep the caret on screen as
        /// new lines are typed (mirrors the Messages composer). scrollRangeToVisible is a
        /// no-op while the caret is already visible, so a user scrolling back through the
        /// draft is only re-anchored on the next keystroke.
        func scrollCaretIntoView(_ textView: UITextView) {
            guard textView.isFirstResponder,
                  !textView.isTracking,
                  !textView.isDecelerating else { return }
            DispatchQueue.main.async { [weak textView] in
                guard let textView, textView.window != nil else { return }
                // The text may have changed again since this was scheduled; settle layout
                // so contentSize and the caret geometry are current before scrolling.
                textView.layoutIfNeeded()
                let range = textView.selectedRange
                guard range.location != NSNotFound else { return }
                // An empty range at end-of-document produces no rect under TextKit 2;
                // scroll to the last character instead so the caret comes into view.
                if range.length == 0, range.location > 0 {
                    textView.scrollRangeToVisible(
                        NSRange(location: range.location - 1, length: 1)
                    )
                } else {
                    textView.scrollRangeToVisible(range)
                }
                // Fallback: if the caret still isn't visible after that, scroll it in by
                // offset directly.
                if let end = textView.selectedTextRange?.end {
                    let caretRect = textView.caretRect(for: end)
                    if caretRect.height > 0, !textView.bounds.contains(caretRect) {
                        let target = max(
                            0,
                            caretRect.maxY - textView.bounds.height
                                + textView.textContainerInset.bottom
                        )
                        if target > textView.contentOffset.y {
                            textView.setContentOffset(
                                CGPoint(x: 0, y: target), animated: false
                            )
                        }
                    }
                }
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            guard !parent.isFocused.wrappedValue else { return }
            DispatchQueue.main.async { self.parent.isFocused.wrappedValue = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            (textView as? ChatPasteTextView)?.markFocusEnded()
            guard parent.isFocused.wrappedValue else { return }
            DispatchQueue.main.async { self.parent.isFocused.wrappedValue = false }
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard text == "\n" else { return true }
            parent.onSubmit()
            return false
        }
    }
}

private struct DirectMessageConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var renderCache = ChatConversationRenderCache()
    @FocusState private var composerFocused: Bool
    @FocusState private var searchFocused: Bool
    @State private var draft = ""
    @State private var isSending = false
    @State private var isSendingAttachment = false
    @State private var attachmentDrafts: [ChatAttachmentDraft] = []
    @State private var attachmentPreparationTask: Task<Void, Never>?
    @State private var attachmentSendTask: Task<Void, Never>?
    @State private var attachmentProgress: AttachmentTransferProgress?
    @State private var attachmentSendError: String?
    @State private var attachmentUploadFileIndex = 0
    @State private var attachmentUploadFileTotal = 0
    @State private var replyingTo: NostrDirectMessage?
    @State private var showingPhotoPicker = false
    @State private var photoSelections: [PhotosPickerItem] = []
    @State private var showingCamera = false
    @State private var showingDocumentScanner = false
    @State private var showingFileImporter = false
    @State private var showingContactSharePicker = false
    @State private var showingGroupDetails = false
    @State private var showingContactDetails = false
    @State private var isSearchingConversation = false
    @State private var searchQuery = ""
    @State private var selectedSearchResultID: String?
    @State private var searchSelectionTask: Task<Void, Never>?
    @State private var timelineScrollTask: Task<Void, Never>?
    @State private var isScrolledAwayFromBottom = false
    @State private var protectsInitialScrollTarget = false
    @State private var isAddingContact = false
    @State private var confirmingConversationDeletion = false
    @State private var botCommands: [BotCommand] = []
    @State private var botCommandMenuHeight: CGFloat = 0
    let peerPublicKey: String
    let initialTimelineItemID: String?

    private var contact: NostrContact? { model.nostrContact(publicKey: peerPublicKey) }
    private var group: NostrGroupConversation? { model.groupConversation(id: peerPublicKey) }
    private var isSelfConversation: Bool { peerPublicKey == model.identityPublicKey }
    private var messages: [NostrDirectMessage] { model.directMessages(with: peerPublicKey) }
    private var sharedTasks: [SharedInboxItem] {
        model.sharedInboxItems
            .filter {
                $0.status != .deleted &&
                    $0.sender.publicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var sharedContacts: [SharedContactInboxItem] {
        model.sharedContactInboxItems
            .filter {
                $0.status != .deleted &&
                    $0.conversationPublicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var calendarInvites: [SharedCalendarInviteInboxItem] {
        model.sharedCalendarInviteItems
            .filter {
                $0.status != .deleted &&
                    $0.sender.publicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var sharedBoards: [SharedBoardInboxItem] {
        model.sharedBoardInboxItems
            .filter {
                $0.status != .deleted &&
                    $0.sender.publicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
            }
            .sorted {
                if $0.receivedAt != $1.receivedAt { return $0.receivedAt < $1.receivedAt }
                return $0.id < $1.id
            }
    }
    private var presentation: ChatConversationPresentation {
        renderCache.presentation(
            revision: model.snapshotRevision,
            identity: model.identityPublicKey,
            peer: peerPublicKey,
            build: makePresentation
        )
    }

    private var timeline: [ChatTimelineItem] { presentation.timeline }
    private var structuredSenderName: String? { presentation.structuredSenderName }

    private func makePresentation() -> ChatConversationPresentation {
        let sharedTasks = sharedTasks
        let sharedContacts = sharedContacts
        let calendarInvites = calendarInvites
        let sharedBoards = sharedBoards
        let items =
            messages.map(ChatTimelineItem.message)
                + sharedTasks.map(ChatTimelineItem.sharedTask)
                + sharedContacts.map(ChatTimelineItem.sharedContact)
                + calendarInvites.map(ChatTimelineItem.calendarInvite)
                + sharedBoards.map(ChatTimelineItem.sharedBoard)

        // `created_at` has one-second precision. Keep the order established by the message store
        // for ties; an event-ID tiebreaker is effectively random and can flip a just-sent message
        // behind the response that followed it.
        let timeline = items.enumerated()
            .sorted {
                if $0.element.timestamp != $1.element.timestamp {
                    return $0.element.timestamp < $1.element.timestamp
                }
                return $0.offset < $1.offset
            }
            .map(\.element)
        var values: [(Date, String)] = sharedTasks.map { ($0.receivedAt, $0.sender.displayName) }
        values += sharedContacts.compactMap {
            $0.isIncoming ? ($0.receivedAt, $0.sender.displayName) : nil
        }
        values += calendarInvites.map { ($0.receivedAt, $0.sender.displayName) }
        values += sharedBoards.map { ($0.receivedAt, $0.sender.displayName) }

        let lastSentItemID = timeline.last { item in
            switch item {
            case let .message(message):
                !message.isIncoming && message.deliveryState == .sent
            case let .sharedContact(contact):
                !contact.isIncoming
            default:
                false
            }
        }?.id
        let currentMessages = timeline.compactMap { item -> NostrDirectMessage? in
            guard case let .message(message) = item else { return nil }
            return message
        }
        var messageLookup: [String: NostrDirectMessage] = [:]
        messageLookup.reserveCapacity(currentMessages.count * 2)
        for message in currentMessages {
            messageLookup[message.rumorEventID] = message
            messageLookup[message.wrapEventID] = message
        }
        let senderContacts = Dictionary(
            model.nostrContacts.map { ($0.publicKey, $0) },
            uniquingKeysWith: { _, newest in newest }
        )
        let senderNames = Dictionary(
            uniqueKeysWithValues: Set(currentMessages.map(\.senderPublicKey)).map {
                ($0, senderName(for: $0))
            }
        )
        return ChatConversationPresentation(
            timeline: timeline,
            lastSentItemID: lastSentItemID,
            messageLookup: messageLookup,
            reactionLookup: model.directMessageReactionLookup(peerPublicKey: peerPublicKey),
            senderContacts: senderContacts,
            senderNames: senderNames,
            structuredSenderName: values.max { $0.0 < $1.0 }?.1
        )
    }
    private var isStranger: Bool {
        group == nil && contact == nil && peerPublicKey != model.identityPublicKey
    }
    private var isBlocked: Bool { model.isDirectMessagePeerBlocked(peerPublicKey) }
    private var hasLeftGroup: Bool { group != nil && model.hasLeftDirectMessageGroup(peerPublicKey) }
    private var conversationTitle: String {
        group?.displayName ?? contact?.displayName ?? (isSelfConversation ? "You" : nil)
            ?? structuredSenderName ?? "Message"
    }
    private var canShowContactDetails: Bool {
        group == nil && NostrPublicKey.parse(peerPublicKey) != nil
    }
    private var contactDetailFallbackName: String? {
        guard contact == nil else { return nil }
        return isSelfConversation ? "You" : structuredSenderName
    }
    private var searchResults: [ChatTimelineItem] {
        let currentTimeline = timeline
        return renderCache.searchResults(query: searchQuery) {
            currentTimeline.filter {
                $0.matchesSearch(searchQuery, senderName: senderName(for:))
            }
        }
    }
    private var selectedSearchResultIndex: Int? {
        guard let selectedSearchResultID else { return nil }
        return searchResults.firstIndex { $0.id == selectedSearchResultID }
    }

    var body: some View {
        let presentation = presentation
        let currentTimeline = presentation.timeline
        let currentSearchMatches = Set(searchResults.map(\.id))

        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if currentTimeline.isEmpty {
                        VStack(spacing: 12) {
                            ChatPeerAvatar(
                                contact: contact,
                                publicKey: peerPublicKey,
                                size: 72,
                                group: group,
                                recentMessages: messages
                            )
                            Text(
                                group?.displayName ?? contact?.displayName
                                    ?? (isSelfConversation ? "Message Yourself" : nil)
                                    ?? structuredSenderName ?? "New conversation"
                            )
                                .font(.headline)
                            Text(
                                isSelfConversation
                                    ? "Keep private notes synced through your encrypted Nostr inbox."
                                    : "Messages are end-to-end encrypted with your Nostr identity."
                            )
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.horizontal, 30)
                        .padding(.top, 70)
                    } else {
                        ForEach(Array(currentTimeline.enumerated()), id: \.element.id) { index, item in
                            // One stable child per timeline item preserves lazy row creation.
                            // A conditional divider beside the bubble makes the child count
                            // depend on evaluating off-screen messages.
                            VStack(spacing: 0) {
                                if shouldShowDayDivider(at: index, in: currentTimeline) {
                                    ChatDayDivider(timestamp: item.timestamp)
                                }

                                switch item {
                                case let .message(message):
                                    let groupedWithPrevious = isMessageGrouped(at: index, with: index - 1, in: currentTimeline)
                                    let groupedWithNext = isMessageGrouped(at: index + 1, with: index, in: currentTimeline)
                                    let reactions = (presentation.reactionLookup[message.rumorEventID] ?? [])
                                        + (message.wrapEventID == message.rumorEventID
                                            ? []
                                            : presentation.reactionLookup[message.wrapEventID] ?? [])
                                    DirectMessageBubble(
                                        renderCache: renderCache,
                                        message: message,
                                        repliedMessage: message.replyToEventID.flatMap {
                                            presentation.messageLookup[$0]
                                        },
                                        reactions: reactions,
                                        senderName: group != nil && message.isIncoming && !groupedWithPrevious
                                            ? presentation.senderNames[message.senderPublicKey] : nil,
                                        senderContact: group != nil && message.isIncoming
                                            ? presentation.senderContacts[message.senderPublicKey] : nil,
                                        showsSenderAvatar: group != nil && message.isIncoming,
                                        isGroupedWithPrevious: groupedWithPrevious,
                                        isGroupedWithNext: groupedWithNext,
                                        showsSentStatus: item.id == presentation.lastSentItemID,
                                        isSearchMatch: currentSearchMatches.contains(item.id),
                                        isSelectedSearchResult: selectedSearchResultID == item.id
                                    )
                                    .equatable()
                                    .contextMenu {
                                        Label(
                                            "Sent \(Date(timeIntervalSince1970: TimeInterval(message.createdAt)).formatted(date: .abbreviated, time: .shortened))",
                                            systemImage: "clock"
                                        )
                                        Menu("React", systemImage: "face.smiling") {
                                            ForEach(["❤️", "👍", "👎", "😂", "😮", "😢"], id: \.self) { emoji in
                                                Button(emoji) { react(to: message, with: emoji) }
                                            }
                                        }
                                        if reactions.contains(where: {
                                            $0.senderPublicKey == model.identityPublicKey
                                        }) {
                                            Button("Remove Reaction", systemImage: "minus.circle") {
                                                react(to: message, with: "-")
                                            }
                                        }
                                        Button("Reply", systemImage: "arrowshape.turn.up.left") {
                                            replyingTo = message
                                            composerFocused = true
                                        }
                                        if message.attachment == nil {
                                            Button("Copy", systemImage: "doc.on.doc") {
                                                UIPasteboard.general.string = message.content
                                            }
                                        }
                                    }
                                case let .sharedTask(sharedTask):
                                    SharedTaskChatCard(
                                        item: sharedTask,
                                        isSearchMatch: currentSearchMatches.contains(item.id),
                                        isSelectedSearchResult: selectedSearchResultID == item.id
                                    )
                                case let .sharedContact(sharedContact):
                                    SharedContactChatCard(
                                        item: sharedContact,
                                        showsSentStatus: item.id == presentation.lastSentItemID,
                                        isSearchMatch: currentSearchMatches.contains(item.id),
                                        isSelectedSearchResult: selectedSearchResultID == item.id
                                    )
                                case let .calendarInvite(invite):
                                    SharedCalendarInviteChatCard(
                                        item: invite,
                                        isSearchMatch: currentSearchMatches.contains(item.id),
                                        isSelectedSearchResult: selectedSearchResultID == item.id
                                    )
                                case let .sharedBoard(sharedBoard):
                                    SharedBoardChatCard(
                                        item: sharedBoard,
                                        isSearchMatch: currentSearchMatches.contains(item.id),
                                        isSelectedSearchResult: selectedSearchResultID == item.id
                                    )
                                }
                            }
                            .id(item.id)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .onGeometryChange(for: CGFloat.self) { geometry in
                    let space = NamedCoordinateSpace.named("conversationViewport")
                    guard let viewport = geometry.bounds(of: space) else { return 0 }
                    return geometry.size.height - viewport.maxY
                } action: { distanceFromBottom in
                    // Only update view state at threshold crossings, keeping scrolling smooth.
                    let isAwayFromBottom = distanceFromBottom > 80
                    if isScrolledAwayFromBottom != isAwayFromBottom {
                        isScrolledAwayFromBottom = isAwayFromBottom
                    }
                }
            }
            .coordinateSpace(name: "conversationViewport")
            // Scope interactive dismissal to the timeline, outside the composer.
            .scrollDismissesKeyboard(.interactively)
            .onTapGesture { dismissComposerKeyboard() }
            .conversationBottomInitialAnchor()
            .overlay(alignment: .bottom) {
                if isScrolledAwayFromBottom, !currentTimeline.isEmpty {
                    Button {
                        markReadAndScroll(proxy: proxy, animated: !reduceMotion)
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .frame(width: 32, height: 32)
                            .taskifyGlassControl(in: Circle())
                            .shadow(color: .black.opacity(0.2), radius: 6, y: 2)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Scroll to latest message")
                    .accessibilityIdentifier("chatScrollToBottom")
                    .padding(.bottom, 12)
                }
            }
            .safeAreaInset(edge: .top, spacing: 6) {
                VStack(spacing: 7) {
                    if isStranger {
                        strangerSafetyBar
                            .padding(.horizontal, 12)
                    }
                    if isSearchingConversation {
                        conversationSearchBar(proxy: proxy)
                            .padding(.horizontal, 12)
                    }
                }
            }
            .onAppear {
                if let initialTimelineItemID {
                    selectedSearchResultID = initialTimelineItemID
                    protectsInitialScrollTarget = true
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(1))
                        protectsInitialScrollTarget = false
                    }
                }
                markReadAndScroll(
                    proxy: proxy,
                    targetID: initialTimelineItemID,
                    animated: false
                )
            }
            .onChange(of: currentTimeline.count) { _, _ in
                if protectsInitialScrollTarget, let initialTimelineItemID {
                    markReadAndScroll(
                        proxy: proxy,
                        targetID: initialTimelineItemID,
                        animated: false
                    )
                    return
                }
                if isSearchingConversation, !searchQuery.isEmpty {
                    // Still inside the thread, so arrivals during in-thread search count as
                    // read too; the search overlay must not steal the scroll, but marking
                    // must not be skipped.
                    model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
                    selectNewestSearchResult(proxy: proxy)
                } else {
                    markReadAndScroll(proxy: proxy, animated: true)
                }
            }
            .onChange(of: searchQuery) { _, _ in
                scheduleNewestSearchResult(proxy: proxy)
            }
        }
        .background(TaskifyAppBackground())
        .task(id: peerPublicKey) {
            // Bot commands: seed from the persisted cache instantly, then
            // reconcile with the peer's relays in the background. 1:1 chats
            // only — the published NIP-51 list is the bot signal.
            guard group == nil, !isSelfConversation else {
                botCommands = []
                return
            }
            botCommands = model.botCommands(publicKey: peerPublicKey) ?? []
            await model.refreshBotCommands(publicKey: peerPublicKey)
            botCommands = model.botCommands(publicKey: peerPublicKey) ?? []
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            conversationHeader
        }
        .safeAreaInset(edge: .bottom, spacing: 8) {
            Group {
                if hasLeftGroup {
                    restrictedConversationFooter(
                        title: "You left this group",
                        actionTitle: "Rejoin",
                        systemImage: "arrow.uturn.forward.circle"
                    ) {
                        model.setDirectMessageGroupLeft(peerPublicKey, left: false)
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                    .padding(.horizontal, 12)
                } else if isBlocked {
                    restrictedConversationFooter(
                        title: "This sender is blocked",
                        actionTitle: "Unblock",
                        systemImage: "hand.raised.slash"
                    ) {
                        model.setDirectMessagePeerBlocked(peerPublicKey, blocked: false)
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                    .padding(.horizontal, 12)
                } else {
                    composer
                }
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .sheet(isPresented: $showingGroupDetails) {
            GroupConversationDetailsView(groupID: peerPublicKey)
                .environment(model)
        }
        .sheet(isPresented: $showingContactDetails) {
            NavigationStack {
                NostrContactDetailView(
                    contactPublicKey: peerPublicKey,
                    fallbackDisplayName: contactDetailFallbackName
                )
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showingContactDetails = false }
                    }
                }
            }
            .environment(model)
            .preferredColorScheme(.dark)
            .tint(TaskifyTheme.accent)
        }
        .sheet(isPresented: $showingContactSharePicker) {
            ShareContactPickerSheet { contact in
                await shareContact(contact)
            }
            .environment(model)
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $photoSelections,
            maxSelectionCount: NostrDirectMessageAttachment.maximumBatchCount,
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .automatic
        )
        .onChange(of: photoSelections) { _, selections in
            guard !selections.isEmpty else { return }
            attachmentPreparationTask = Task { await stagePhotoSelections(selections) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let URLs) = result, !URLs.isEmpty else {
                if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
                return
            }
            attachmentPreparationTask = Task {
                for URL in URLs { await stageFile(URL) }
            }
        }
        .onDisappear {
            // Leaving the thread reads it through. The reactive onChange mark handles messages
            // seen arriving, but it can miss: arrivals during in-thread search take the search
            // branch, and once the message store hits its 400-message cap a new arrival also
            // drops the oldest, leaving the timeline count — the onChange signal — unchanged.
            // Anything that reached the snapshot while this view was open was displayed in it,
            // so the list must not badge the thread afterwards.
            model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
            attachmentPreparationTask?.cancel()
            timelineScrollTask?.cancel()
            renderCache.clear()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { renderCache.clear() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            renderCache.clear()
        }
        .onChange(of: model.identityPublicKey) { _, _ in
            renderCache.clear()
            attachmentPreparationTask?.cancel()
            attachmentDrafts.removeAll()
            draft = ""
            replyingTo = nil
        }
        .task(id: peerPublicKey) {
            await model.prepareDirectMessageRecipient(peerPublicKey)
        }
        .confirmationDialog(
            "Delete this conversation?",
            isPresented: $confirmingConversationDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete Conversation", role: .destructive) {
                model.deleteDirectMessageThread(peerPublicKey: peerPublicKey)
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the conversation from this device and suppresses immediate relay replays.")
        }
    }

    private var conversationHeader: some View {
        ZStack {
            Button {
                if group != nil {
                    showingGroupDetails = true
                } else if canShowContactDetails {
                    showingContactDetails = true
                }
            } label: {
                VStack(spacing: 2) {
                    ChatPeerAvatar(
                        contact: contact,
                        publicKey: peerPublicKey,
                        size: 42,
                        group: group,
                        recentMessages: messages
                    )
                    Text(conversationTitle)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(1)
                    if let group {
                        Text("\(group.memberPublicKeys.count) members")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                }
                .frame(maxWidth: 220)
            }
            .buttonStyle(.plain)
            .disabled(group == nil && !canShowContactDetails)
            .accessibilityLabel(group == nil ? "Open contact details" : "Open group details")

            HStack {
                HeaderIconButton(systemName: "chevron.left", accessibilityLabel: "Back to chats") {
                    dismiss()
                }

                Spacer()

                Menu {
                    Button {
                        toggleConversationSearch()
                    } label: {
                        Label(
                            isSearchingConversation ? "Close Search" : "Search Conversation",
                            systemImage: "magnifyingglass"
                        )
                    }
                    if group != nil {
                        Button {
                            showingGroupDetails = true
                        } label: {
                            Label("Group Details", systemImage: "person.3")
                        }
                    } else if canShowContactDetails {
                        Button {
                            showingContactDetails = true
                        } label: {
                            Label("Contact Details", systemImage: "person.crop.circle")
                        }
                    }
                    Button {
                        model.archiveDirectMessageThread(peerPublicKey: peerPublicKey)
                        dismiss()
                    } label: {
                        Label("Archive Conversation", systemImage: "archivebox")
                    }
                    Button(role: .destructive) {
                        confirmingConversationDeletion = true
                    } label: {
                        Label("Delete Conversation", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .bold))
                        .frame(width: 42, height: 42)
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Conversation actions")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.07))
                .frame(height: 0.5)
        }
    }

    private var strangerSafetyBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.headline)
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 1) {
                Text("Unknown sender")
                    .font(.caption.bold())
                    .foregroundStyle(TaskifyTheme.primaryText)
                Text("Only reply if you recognize this account.")
                    .font(.caption2)
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }

            Spacer(minLength: 4)

            Button(isBlocked ? "Unblock" : "Block") {
                model.setDirectMessagePeerBlocked(peerPublicKey, blocked: !isBlocked)
                UINotificationFeedbackGenerator().notificationOccurred(isBlocked ? .success : .warning)
            }
            .font(.caption.bold())
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)

            Button {
                addStrangerToContacts()
            } label: {
                if isAddingContact {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Add")
                }
            }
            .font(.caption.bold())
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(isAddingContact)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.orange.opacity(0.24), lineWidth: 1)
        )
    }

    private func restrictedConversationFooter(
        title: String,
        actionTitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)
            Spacer()
            Button(action: action) {
                Label(actionTitle, systemImage: systemImage)
                    .font(.subheadline.bold())
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
        }
        .padding(10)
        .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func addStrangerToContacts() {
        guard !isAddingContact else { return }
        isAddingContact = true
        let relay = messages.flatMap { $0.relayURLs ?? [] }.first
        Task {
            do {
                _ = try await model.saveNostrContact(
                    publicKeyValue: peerPublicKey,
                    petname: nil,
                    relayURL: relay
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isAddingContact = false
        }
    }

    private func conversationSearchBar(proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(TaskifyTheme.secondaryText)

            TextField("Search conversation", text: $searchQuery)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($searchFocused)
                .submitLabel(.search)

            Text(searchResultPositionLabel)
                .font(.caption.monospacedDigit())
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(minWidth: 34)

            Button {
                moveSearchResult(by: -1, proxy: proxy)
            } label: {
                Image(systemName: "chevron.up")
                    .frame(width: 28, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(searchResults.isEmpty)
            .accessibilityLabel("Previous search result")

            Button {
                moveSearchResult(by: 1, proxy: proxy)
            } label: {
                Image(systemName: "chevron.down")
                    .frame(width: 28, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(searchResults.isEmpty)
            .accessibilityLabel("Next search result")

            Button(action: closeConversationSearch) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 30, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close conversation search")
        }
        .font(.subheadline)
        .foregroundStyle(TaskifyTheme.primaryText)
        .padding(.horizontal, 13)
        .frame(height: 48)
        .taskifyGlassControl(in: Capsule())
    }

    private var searchResultPositionLabel: String {
        guard let index = selectedSearchResultIndex, !searchResults.isEmpty else { return "0/0" }
        return "\(index + 1)/\(searchResults.count)"
    }

    private func toggleConversationSearch() {
        if isSearchingConversation {
            closeConversationSearch()
        } else {
            composerFocused = false
            isSearchingConversation = true
            DispatchQueue.main.async { searchFocused = true }
        }
    }

    private func closeConversationSearch() {
        searchSelectionTask?.cancel()
        searchSelectionTask = nil
        isSearchingConversation = false
        searchQuery = ""
        selectedSearchResultID = nil
        searchFocused = false
    }

    private func scheduleNewestSearchResult(proxy: ScrollViewProxy) {
        searchSelectionTask?.cancel()
        guard !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            selectedSearchResultID = nil
            return
        }
        searchSelectionTask = Task { @MainActor in
            do {
                try await Task.sleep(for: .milliseconds(120))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            selectNewestSearchResult(proxy: proxy)
        }
    }

    private func selectNewestSearchResult(proxy: ScrollViewProxy) {
        guard !searchResults.isEmpty else {
            selectedSearchResultID = nil
            return
        }
        selectedSearchResultID = searchResults.last?.id
        scrollToSelectedSearchResult(proxy: proxy)
    }

    private func moveSearchResult(by offset: Int, proxy: ScrollViewProxy) {
        guard !searchResults.isEmpty else { return }
        let currentIndex = selectedSearchResultIndex ?? searchResults.count - 1
        let nextIndex = (currentIndex + offset + searchResults.count) % searchResults.count
        selectedSearchResultID = searchResults[nextIndex].id
        scrollToSelectedSearchResult(proxy: proxy)
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func scrollToSelectedSearchResult(proxy: ScrollViewProxy) {
        guard let selectedSearchResultID else { return }
        Task { @MainActor in
            await Task.yield()
            withAnimation(.easeInOut(duration: 0.22)) {
                proxy.scrollTo(selectedSearchResultID, anchor: .center)
            }
        }
    }

    private var canSend: Bool {
        (!attachmentDrafts.isEmpty || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
            !isSending && !isSendingAttachment
    }

    /// Commands matching the typed "/" prefix, shown in the Telegram-style
    /// menu. Hidden once the draft stops matching (e.g. after inserting
    /// "/name " the trailing space matches nothing).
    private var visibleBotCommands: [BotCommand]? {
        guard group == nil,
              !isSearchingConversation,
              draft.hasPrefix("/"),
              !botCommands.isEmpty else { return nil }
        let query = String(draft.dropFirst()).lowercased()
        let matched = botCommands.filter { $0.name.hasPrefix(query) }
        return matched.isEmpty ? nil : matched
    }

    private func botCommandMenu(_ commands: [BotCommand]) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(commands) { command in
                    Button {
                        draft = "/\(command.name) "
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("/\(command.name)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TaskifyTheme.accent)
                            Spacer(minLength: 0)
                            Text(command.description)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Insert command \(command.name)")
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { geometry in
                min(geometry.size.height, 224)
            } action: { height in
                botCommandMenuHeight = height
            }
        }
        .frame(height: botCommandMenuHeight)
        .padding(.horizontal, 9)
    }

    /// Caption for the upload progress area: "file i of N" once a batch grows
    /// past a single file.
    private var attachmentUploadProgressText: String {
        let base = attachmentProgress?.message ?? "Preparing attachment…"
        guard attachmentUploadFileTotal > 1, attachmentProgress != .sendingMessage else { return base }
        return "Sending \(attachmentUploadFileIndex + 1) of \(attachmentUploadFileTotal) — \(base)"
    }

    /// Stages one more attachment, refusing past the batch cap. A refused
    /// draft is never retained, so its deinit cleans up the temp file.
    @MainActor
    private func appendDraft(_ draft: ChatAttachmentDraft) -> Bool {
        guard attachmentDrafts.count < NostrDirectMessageAttachment.maximumBatchCount else {
            model.errorMessage = "You can attach up to \(NostrDirectMessageAttachment.maximumBatchCount) files per message."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
        attachmentDrafts.append(draft)
        return true
    }

    @MainActor
    private func removeDraft(_ id: UUID) {
        attachmentDrafts.removeAll { $0.id == id }
        if attachmentDrafts.isEmpty { attachmentSendError = nil }
    }

    private var composer: some View {
        TaskifyGlassControlGroup(spacing: 4) {
        VStack(spacing: 6) {
            if let botMenuCommands = visibleBotCommands {
                botCommandMenu(botMenuCommands)
                    .padding(.vertical, 4)
                    .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 21, style: .continuous))
            }
            if let replyingTo {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(TaskifyTheme.accent)
                        .frame(width: 3, height: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Replying to \(replyTargetName(replyingTo))")
                            .font(.caption.bold())
                            .foregroundStyle(TaskifyTheme.accent)
                        Text(replyingTo.displayContent)
                            .font(.caption)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button {
                        self.replyingTo = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(TaskifyTheme.secondaryText)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSending)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 8)
                .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            HStack(alignment: .bottom, spacing: 9) {
                Menu {
                    // Compile-time simulator exclusion, not a runtime availability check:
                    // device users always get the entries, and the Simulator (no camera)
                    // never does.
                    #if !targetEnvironment(simulator)
                    Button {
                        showingCamera = true
                    } label: {
                        Label("Camera", systemImage: "camera")
                    }
                    Button {
                        showingDocumentScanner = true
                    } label: {
                        Label("Scan Document", systemImage: "doc.text.viewfinder")
                    }
                    #endif
                    Button {
                        showingPhotoPicker = true
                    } label: {
                        Label("Photo or Video", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showingFileImporter = true
                    } label: {
                        Label("Document", systemImage: "doc")
                    }
                    if group == nil {
                        Button {
                            showingContactSharePicker = true
                        } label: {
                            Label("Share Contact", systemImage: "person.crop.circle.badge.plus")
                        }
                    }
                } label: {
                    Group {
                        if isSendingAttachment {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .semibold))
                        }
                    }
                    .frame(width: 42, height: 42)
                    .taskifyGlassControl(in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isSending || isSendingAttachment)
                .accessibilityLabel(isSendingAttachment ? "Preparing attachment" : "Add attachment")

                VStack(alignment: .leading, spacing: 8) {
                    if !attachmentDrafts.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(attachmentDrafts) { attachmentDraft in
                                    TaskifyAttachmentDraftPreview(fileURL: attachmentDraft.fileURL,
                                        name: attachmentDraft.name, mimeType: attachmentDraft.mimeType,
                                        size: attachmentDraft.size, isBusy: isSending) {
                                            removeDraft(attachmentDraft.id)
                                        }
                                }
                            }
                            .padding(.horizontal, 9)
                            .padding(.top, 8)
                        }
                        if isSending {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(attachmentUploadProgressText)
                                    .font(.caption).foregroundStyle(.secondary)
                                if let fraction = attachmentProgress?.fractionCompleted {
                                    ProgressView(value: fraction)
                                }
                                if attachmentProgress != .sendingMessage {
                                    Button("Cancel upload") { attachmentSendTask?.cancel() }
                                        .font(.caption).buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 9)
                        }
                        if let attachmentSendError {
                            Text(attachmentSendError).font(.caption).foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 9)
                        }
                        Divider().padding(.horizontal, 9)
                    }
                    HStack(alignment: .bottom, spacing: 4) {
                        let composerPrompt = attachmentDrafts.isEmpty ? "Message" : "Add comment or Send"
                        ZStack(alignment: .topLeading) {
                            if draft.isEmpty {
                                Text(composerPrompt)
                                    .font(.body)
                                    .foregroundStyle(TaskifyTheme.secondaryText)
                                    .padding(.top, 10)
                                    .allowsHitTesting(false)
                            }
                            ChatComposerTextView(
                                text: $draft,
                                isFocused: $composerFocused,
                                isEnabled: !isSending,
                                dismissKeyboard: isSearchingConversation,
                                accessibilityLabel: composerPrompt,
                                onSubmit: send,
                                pasteAttachment: pasteAttachmentProviders
                            )
                        }
                        .padding(.leading, 15)
                        .frame(maxWidth: .infinity, alignment: .leading)

                        Button(action: send) {
                            Group {
                                if isSending { ProgressView().tint(.white) }
                                else {
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 17, weight: .bold))
                                }
                            }
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .taskifyGlassControl(in: Circle(), tint: TaskifyTheme.accent.opacity(0.72),
                                fallbackFill: TaskifyTheme.accent)
                        }
                        .buttonStyle(.plain)
                        .opacity(canSend ? 1 : 0.45)
                        .disabled(!canSend)
                        .accessibilityLabel(attachmentDrafts.isEmpty ? "Send message" : "Send attachments")
                    }
                }
                .padding(3)
                .taskifyGlassControl(in: RoundedRectangle(cornerRadius: 21, style: .continuous))
            }
        }
        // Each control floats on its own glass surface; the spacing between them
        // stays transparent so the conversation remains visible underneath.
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .fullScreenCover(isPresented: $showingCamera) {
            TaskAttachmentCameraPicker(
                onCapture: { image in
                    showingCamera = false
                    attachmentPreparationTask?.cancel()
                    attachmentPreparationTask = Task { await stageCapturedPhoto(image) }
                },
                onCancel: { showingCamera = false }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showingDocumentScanner) {
            TaskAttachmentDocumentScanner(
                onScan: { pages in
                    showingDocumentScanner = false
                    attachmentPreparationTask?.cancel()
                    attachmentPreparationTask = Task { await stageScannedDocument(pages) }
                },
                onCancel: { showingDocumentScanner = false },
                onError: { error in
                    showingDocumentScanner = false
                    model.errorMessage = error.localizedDescription
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
            )
            .ignoresSafeArea()
        }
        }
    }

    /// Tapping the timeline while the keyboard is open closes it. The FocusState alone
    /// can't resign a UITextView, so drop first responder explicitly too.
    @MainActor
    private func dismissComposerKeyboard() {
        composerFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let capturedReply = replyingTo
        let capturedAttachments = attachmentDrafts
        let account = model.identityPublicKey
        attachmentSendError = nil
        attachmentProgress = capturedAttachments.first.map { .encrypting(completed: 0, total: $0.size) }
        attachmentUploadFileTotal = capturedAttachments.count
        attachmentUploadFileIndex = 0
        isSending = true
        attachmentSendTask = Task {
            // All-or-nothing: every file uploads before anything is sent, and a
            // failed upload leaves the drafts staged so a retry reuses the
            // per-draft cached uploads instead of re-uploading everything.
            var uploadingName: String?
            do {
                if !capturedAttachments.isEmpty {
                    var uploaded: [NostrDirectMessageAttachment] = []
                    uploaded.reserveCapacity(capturedAttachments.count)
                    for (index, draftAttachment) in capturedAttachments.enumerated() {
                        attachmentUploadFileIndex = index
                        attachmentProgress = .encrypting(completed: 0, total: draftAttachment.size)
                        uploadingName = draftAttachment.name
                        let attachment: NostrDirectMessageAttachment
                        if let uploadedCached = draftAttachment.uploadedAttachment {
                            attachment = uploadedCached
                        } else {
                            attachment = try await TaskAttachmentUploadService.shared.uploadChatAttachment(
                                fileURL: draftAttachment.fileURL, name: draftAttachment.name,
                                mimeType: draftAttachment.mimeType, progress: { progress in
                                    Task { @MainActor in
                                        guard isSending, attachmentProgress != .sendingMessage else { return }
                                        attachmentProgress = progress
                                    }
                                })
                            // If queueing fails, a retry can reuse the completed upload.
                            draftAttachment.uploadedAttachment = attachment
                        }
                        uploaded.append(attachment)
                    }
                    uploadingName = nil
                    try Task.checkCancellation()
                    guard account == model.identityPublicKey else { throw NostrDirectMessageError.identityUnavailable }
                    attachmentProgress = .sendingMessage
                    try await model.sendDirectMessageAttachments(to: peerPublicKey, attachments: uploaded,
                        replyToEventID: capturedReply?.rumorEventID, comment: content)
                } else {
                    try await model.sendDirectMessage(to: peerPublicKey, content: content,
                        replyToEventID: capturedReply?.rumorEventID)
                }
                attachmentDrafts.removeAll()
                draft = ""
                replyingTo = nil
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                if !(error is CancellationError), (error as? URLError)?.code != .cancelled {
                    if !capturedAttachments.isEmpty {
                        if let failedName = uploadingName {
                            attachmentSendError = "\(failedName): \(error.localizedDescription)"
                        } else {
                            attachmentSendError = error.localizedDescription
                        }
                    } else {
                        model.errorMessage = error.localizedDescription
                    }
                    UINotificationFeedbackGenerator().notificationOccurred(.error)
                }
            }
            isSending = false
            attachmentProgress = nil
            attachmentSendTask = nil
            composerFocused = true
        }
    }

    private func shareContact(_ contact: NostrContact) async -> Bool {
        do {
            try await model.sendSharedContact(
                contactPublicKey: contact.publicKey,
                to: peerPublicKey
            )
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        } catch {
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    @MainActor
    private func stagePhotoSelections(_ selections: [PhotosPickerItem]) async {
        guard !isSending, !isSendingAttachment else { photoSelections = []; return }
        isSendingAttachment = true
        defer { photoSelections = []; isSendingAttachment = false }
        for selection in selections {
            var imported: URL?
            do {
                guard let file = try await selection.loadTransferable(type: TaskifyPhotoFile.self) else {
                    throw ChatAttachmentError.unreadableFile
                }
                imported = file.url
                try Task.checkCancellation()
                let size = try AttachmentFiles.size(file.url)
                guard size > 0 else { throw AttachmentFileError.empty }
                let type = selection.supportedContentTypes.first ?? .data
                let staged = ChatAttachmentDraft(fileURL: file.url,
                    name: "\(type.conforms(to: .movie) ? "Video" : "Photo").\(type.preferredFilenameExtension ?? "bin")",
                    mimeType: type.preferredMIMEType ?? "application/octet-stream", size: size)
                imported = nil
                guard appendDraft(staged) else { continue }
                attachmentSendError = nil
                composerFocused = true
            } catch {
                if let imported { try? FileManager.default.removeItem(at: imported) }
                guard !Task.isCancelled else { return }
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    @MainActor
    private func stageFile(_ fileURL: URL) async {
        guard !isSending, !isSendingAttachment else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        var imported: URL?
        do {
            let values = try fileURL.resourceValues(forKeys: [.contentTypeKey, .nameKey])
            let url = try await AttachmentFiles.work { try AttachmentFiles.importFile(fileURL) }
            imported = url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(url)
            guard size > 0 else { throw AttachmentFileError.empty }
            let staged = ChatAttachmentDraft(fileURL: url, name: values.name ?? fileURL.lastPathComponent,
                mimeType: values.contentType?.preferredMIMEType ?? "application/octet-stream", size: size)
            imported = nil
            guard appendDraft(staged) else { return }
            attachmentSendError = nil
            composerFocused = true
        } catch {
            if let imported { try? FileManager.default.removeItem(at: imported) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func pasteAttachmentProviders(_ providers: [NSItemProvider]) -> Bool {
        guard Self.clipboardAttachmentSource(in: providers) != nil else { return false }
        guard !isSending, !isSendingAttachment else { return true }
        attachmentPreparationTask?.cancel()
        attachmentPreparationTask = Task { await stageClipboardAttachment(providers) }
        return true
    }

    @MainActor
    private func stageCapturedPhoto(_ image: UIImage) async {
        guard !isSending, !isSendingAttachment else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        var staged: URL?
        do {
            guard let jpegData = image.jpegData(compressionQuality: 0.88) else {
                throw AttachmentFileError.invalidFile
            }
            let url = try await AttachmentFiles.work { try AttachmentFiles.write(jpegData) }
            staged = url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(url)
            let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
            let draftAttachment = ChatAttachmentDraft(
                fileURL: url,
                name: "photo-\(timestamp).jpg",
                mimeType: "image/jpeg",
                size: size
            )
            staged = nil
            guard appendDraft(draftAttachment) else { return }
            attachmentSendError = nil
            composerFocused = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func stageScannedDocument(_ pages: [UIImage]) async {
        guard !isSending, !isSendingAttachment, !pages.isEmpty else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        var staged: URL?
        do {
            let pdfData = try await AttachmentFiles.work {
                try TaskAttachmentPDFRenderer.pdfData(from: pages)
            }
            let url = try await AttachmentFiles.work { try AttachmentFiles.write(pdfData) }
            staged = url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(url)
            let timestamp = Int(Date().timeIntervalSince1970 * 1_000)
            let draftAttachment = ChatAttachmentDraft(
                fileURL: url,
                name: "scan-\(timestamp).pdf",
                mimeType: "application/pdf",
                size: size
            )
            staged = nil
            guard appendDraft(draftAttachment) else { return }
            attachmentSendError = nil
            composerFocused = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            if let staged { try? FileManager.default.removeItem(at: staged) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func stageClipboardAttachment(_ providers: [NSItemProvider]) async {
        guard !isSending, !isSendingAttachment,
              let source = Self.clipboardAttachmentSource(in: providers) else { return }
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        var imported: URL?
        do {
            let staged: (url: URL, name: String, type: UTType?)
            if let type = source.contentType {
                let url = try await Self.importClipboardRepresentation(
                    from: source.provider,
                    contentType: type
                )
                let baseName = source.provider.suggestedName?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let fallbackName: String
                if type.conforms(to: .image) { fallbackName = "Pasted Image" }
                else if type.conforms(to: .movie) { fallbackName = "Pasted Video" }
                else if type.conforms(to: .audio) { fallbackName = "Pasted Audio" }
                else { fallbackName = "Pasted File" }
                let suppliedName = baseName.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
                let name = URL(fileURLWithPath: suppliedName).pathExtension.isEmpty
                    ? "\(suppliedName).\(type.preferredFilenameExtension ?? "bin")"
                    : suppliedName
                staged = (url, name, type)
            } else {
                let fileURL = try await Self.clipboardFileURL(from: source.provider)
                let values = try fileURL.resourceValues(forKeys: [.contentTypeKey, .nameKey])
                let url = try await AttachmentFiles.work { try AttachmentFiles.importFile(fileURL) }
                staged = (
                    url,
                    values.name ?? fileURL.lastPathComponent,
                    values.contentType ?? UTType(filenameExtension: fileURL.pathExtension)
                )
            }
            imported = staged.url
            try Task.checkCancellation()
            let size = try AttachmentFiles.size(staged.url)
            guard size > 0 else { throw AttachmentFileError.empty }
            let draftAttachment = ChatAttachmentDraft(
                fileURL: staged.url,
                name: staged.name,
                mimeType: staged.type?.preferredMIMEType ?? "application/octet-stream",
                size: size
            )
            imported = nil
            guard appendDraft(draftAttachment) else { return }
            attachmentSendError = nil
            composerFocused = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            if let imported { try? FileManager.default.removeItem(at: imported) }
            guard !Task.isCancelled else { return }
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private struct ClipboardAttachmentSource {
        let provider: NSItemProvider
        let contentType: UTType?
    }

    private static func clipboardAttachmentSource(
        in providers: [NSItemProvider]
    ) -> ClipboardAttachmentSource? {
        // If the clipboard can paste as text at all, text wins: plain or styled text
        // copies must never stage as a file attachment, no matter what companion types
        // the source app registers. Media with no text representation (a copied
        // screenshot, video, or file) still stages as an attachment below.
        let hasTextRepresentation = UIPasteboard.general.hasStrings || providers.contains { provider in
            provider.registeredTypeIdentifiers.compactMap(UTType.init).contains {
                $0.conforms(to: .text)
            }
        }
        if hasTextRepresentation { return nil }
        for provider in providers {
            let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
            let contentType = types.first {
                $0.conforms(to: .image) || $0.conforms(to: .movie) || $0.conforms(to: .audio)
            } ?? types.first {
                $0.conforms(to: .data) &&
                    !$0.conforms(to: .text) &&
                    !$0.conforms(to: .url)
            }
            if let contentType { return ClipboardAttachmentSource(provider: provider, contentType: contentType) }
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                return ClipboardAttachmentSource(provider: provider, contentType: nil)
            }
        }
        return nil
    }

    private static func importClipboardRepresentation(
        from provider: NSItemProvider,
        contentType: UTType
    ) async throws -> URL {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadFileRepresentation(forTypeIdentifier: contentType.identifier) { url, error in
                    do {
                        if let error { throw error }
                        guard let url else { throw AttachmentFileError.invalidFile }
                        // The provider owns this URL only for the duration of its callback.
                        continuation.resume(returning: try AttachmentFiles.importFile(url))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } catch {
            return try await withCheckedThrowingContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: contentType.identifier) { data, fallbackError in
                    do {
                        if let fallbackError { throw fallbackError }
                        guard let data else { throw AttachmentFileError.invalidFile }
                        continuation.resume(returning: try AttachmentFiles.write(data))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    private static func clipboardFileURL(from provider: NSItemProvider) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(
                forTypeIdentifier: UTType.fileURL.identifier,
                options: nil
            ) { value, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url = value as? URL {
                    continuation.resume(returning: url)
                } else if let data = value as? Data,
                          let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: AttachmentFileError.invalidFile)
                }
            }
        }
    }

    private func shouldShowDayDivider(at index: Int, in currentTimeline: [ChatTimelineItem]) -> Bool {
        guard currentTimeline.indices.contains(index) else { return false }
        guard index > 0 else { return true }
        let current = Date(timeIntervalSince1970: TimeInterval(currentTimeline[index].timestamp))
        let previous = Date(timeIntervalSince1970: TimeInterval(currentTimeline[index - 1].timestamp))
        return !Calendar.current.isDate(current, inSameDayAs: previous)
    }

    private func isMessageGrouped(at currentIndex: Int, with previousIndex: Int, in currentTimeline: [ChatTimelineItem]) -> Bool {
        guard currentTimeline.indices.contains(currentIndex), currentTimeline.indices.contains(previousIndex),
              case let .message(current) = currentTimeline[currentIndex],
              case let .message(previous) = currentTimeline[previousIndex] else {
            return false
        }
        guard current.replyToEventID == nil,
              current.isIncoming == previous.isIncoming,
              current.senderPublicKey == previous.senderPublicKey,
              current.createdAt - previous.createdAt <= 5 * 60 else { return false }
        let currentDate = Date(timeIntervalSince1970: TimeInterval(current.createdAt))
        let previousDate = Date(timeIntervalSince1970: TimeInterval(previous.createdAt))
        return Calendar.current.isDate(currentDate, inSameDayAs: previousDate)
    }

    private func senderName(for publicKey: String) -> String {
        if publicKey == model.identityPublicKey { return "You" }
        if let contact = model.nostrContact(publicKey: publicKey) { return contact.displayName }
        guard let key = NostrPublicKey.parse(publicKey),
              let npub = NostrPublicKey.npub(from: key) else { return "Member" }
        return "\(npub.prefix(8))…"
    }

    private func replyTargetName(_ message: NostrDirectMessage) -> String {
        message.isIncoming ? senderName(for: message.senderPublicKey) : "yourself"
    }

    private func react(to message: NostrDirectMessage, with emoji: String) {
        let ownReaction = model.directMessageReactions(for: message).first {
            $0.senderPublicKey == model.identityPublicKey
        }
        let value = ownReaction?.emoji == emoji ? "-" : emoji
        Task {
            do {
                try await model.sendDirectMessageReaction(to: message, emoji: value)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    private func markReadAndScroll(
        proxy: ScrollViewProxy,
        targetID: String? = nil,
        animated: Bool
    ) {
        model.markDirectMessageThreadRead(peerPublicKey: peerPublicKey)
        timelineScrollTask?.cancel()
        guard let timelineItemID = targetID ?? timeline.last?.id else { return }
        timelineScrollTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            if animated {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(timelineItemID, anchor: targetID == nil ? .bottom : .center)
                }
                return
            }

            proxy.scrollTo(timelineItemID, anchor: targetID == nil ? .bottom : .center)
            do {
                try await Task.sleep(for: .milliseconds(50))
            } catch {
                return
            }
            if !Task.isCancelled {
                proxy.scrollTo(timelineItemID, anchor: targetID == nil ? .bottom : .center)
            }
        }
    }
}

private struct ChatDayDivider: View {
    let timestamp: Int

    private var label: String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    var body: some View {
        Text(label)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(TaskifyTheme.secondaryText)
            .opacity(0.72)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 5)
            .accessibilityLabel("Messages from \(label)")
    }
}

private struct SharedTaskChatCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedInboxItem
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var canAccept: Bool {
        guard let board = model.selectedBoard else { return false }
        return board.kind != .bible
    }

    private var detailCount: Int {
        (item.task.subtasks?.count ?? 0) + (item.task.documents?.count ?? 0)
    }

    private var completedSubtaskCount: Int {
        item.task.subtasks?.filter(\.completed).count ?? 0
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Image(systemName: item.task.isAssignment ? "person.crop.circle.badge.checkmark" : "checklist")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(TaskifyTheme.accent)
                .frame(width: 30, height: 30)
                .background(TaskifyTheme.accent.opacity(0.16), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Label(
                        item.task.isAssignment ? "ASSIGNMENT" : "SHARED TASK",
                        systemImage: "lock.fill"
                    )
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.7)
                    .foregroundStyle(TaskifyTheme.accent)

                    Spacer()

                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(item.task.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let note = item.task.note?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !note.isEmpty {
                        Text(note)
                            .font(.subheadline)
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .lineLimit(4)
                    }
                }

                if item.task.dueDate != nil || item.task.priority != nil || detailCount > 0 {
                    ViewThatFits(in: .horizontal) {
                        metadata
                        metadata.fixedSize(horizontal: true, vertical: false)
                    }
                }

                if item.status == .pending {
                    pendingActions
                } else {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(statusColor.opacity(0.13), in: Capsule())
                }

                if item.status == .pending, !canAccept {
                    Text("Choose a task board before adding this task.")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(
                        isSelectedSearchResult
                            ? TaskifyTheme.accent
                            : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                        lineWidth: isSelectedSearchResult ? 2 : 1
                    )
            )

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "\(item.task.isAssignment ? "Assignment" : "Shared task"), \(item.task.title), from \(item.sender.displayName)"
        )
    }

    private var metadata: some View {
        HStack(spacing: 12) {
            if let dueDate = item.task.dueDate {
                Label(
                    dueDate.formatted(
                        date: .abbreviated,
                        time: item.task.dueTimeEnabled == true ? .shortened : .omitted
                    ),
                    systemImage: "calendar"
                )
            }
            if let priority = item.task.priority {
                Label(priorityLabel(priority), systemImage: "exclamationmark")
                    .foregroundStyle(priorityColor(priority))
            }
            if let subtasks = item.task.subtasks, !subtasks.isEmpty {
                Label("\(completedSubtaskCount)/\(subtasks.count)", systemImage: "checklist")
            }
            if let documents = item.task.documents, !documents.isEmpty {
                Label("\(documents.count)", systemImage: "paperclip")
            }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(TaskifyTheme.tertiaryText)
    }

    @ViewBuilder
    private var pendingActions: some View {
        if item.task.isAssignment {
            HStack(spacing: 7) {
                responseButton("Decline", status: .declined, tint: .red)
                responseButton("Maybe", status: .tentative, tint: .orange)
                responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
                    .disabled(!canAccept)
            }
        } else {
            HStack(spacing: 8) {
                Button {
                    withAnimation(.snappy) { model.dismissSharedInboxItem(item.id) }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                }
                .buttonStyle(.bordered)

                responseButton("Add Task", status: .accepted, tint: TaskifyTheme.accent)
                    .disabled(!canAccept)
            }
        }
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            let succeeded: Bool = withAnimation(.snappy) {
                model.respondToSharedInboxItem(item.id, status: status)
            }
            UINotificationFeedbackGenerator().notificationOccurred(succeeded ? .success : .error)
        } label: {
            Text(title)
                .font(.caption.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 36)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
    }

    private var statusLabel: String {
        switch item.status {
        case .pending: "Awaiting response"
        case .accepted: "Added to your tasks"
        case .declined: "Declined"
        case .tentative: "Maybe"
        case .deleted: "Removed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .pending: "clock"
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .pending: TaskifyTheme.secondaryText
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .deleted: TaskifyTheme.tertiaryText
        }
    }

    private func priorityLabel(_ rawValue: Int) -> String {
        switch rawValue {
        case 3: "High"
        case 2: "Medium"
        default: "Low"
        }
    }

    private func priorityColor(_ rawValue: Int) -> Color {
        switch rawValue {
        case 3: .red
        case 2: .orange
        default: .blue
        }
    }
}

private struct SharedContactChatCard: View {
    @Environment(AppModel.self) private var model
    @State private var isSaving = false
    let item: SharedContactInboxItem
    let showsSentStatus: Bool
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var isInContacts: Bool {
        guard let publicKey = item.contact.publicKey else { return false }
        return model.nostrContact(publicKey: publicKey) != nil
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if !item.isIncoming {
                Spacer(minLength: 28)
            }

            if item.isIncoming {
                sharedContactAvatar
            }

            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("SHARED CONTACT", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(TaskifyTheme.accent)
                    Spacer()
                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                HStack(spacing: 11) {
                    contactPhoto
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.contact.primaryName)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(TaskifyTheme.primaryText)
                            .lineLimit(2)
                        if let nip05 = item.contact.nip05 {
                            Text(nip05)
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        } else {
                            Text(item.contact.shortNpub)
                                .font(.caption.monospaced())
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                }

                if let lud16 = item.contact.lud16 {
                    Label(lud16, systemImage: "bolt.fill")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                        .lineLimit(1)
                }

                if item.isIncoming {
                    if item.status == .pending {
                        HStack(spacing: 8) {
                            Button {
                                withAnimation(.snappy) {
                                    model.dismissSharedContactInboxItem(item.id)
                                }
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            } label: {
                                Text("Dismiss")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 36)
                            }
                            .buttonStyle(.bordered)

                            Button { saveContact() } label: {
                                Group {
                                    if isSaving {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Text(isInContacts ? "Confirm" : "Add Contact")
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isSaving)
                        }
                    } else {
                        Label(
                            item.status == .accepted ? "In Contacts" : "Dismissed",
                            systemImage: item.status == .accepted ? "person.crop.circle.badge.checkmark" : "xmark.circle"
                        )
                        .font(.caption.weight(.bold))
                        .foregroundStyle(item.status == .accepted ? Color.green : TaskifyTheme.secondaryText)
                    }
                } else if showsSentStatus {
                    Label("Sent", systemImage: "checkmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TaskifyTheme.secondaryText)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(searchBorder)

            if item.isIncoming {
                Spacer(minLength: 28)
            }
        }
        .frame(maxWidth: .infinity, alignment: item.isIncoming ? .leading : .trailing)
    }

    private var sharedContactAvatar: some View {
        Image(systemName: "person.crop.circle.badge.plus")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(TaskifyTheme.accent)
            .frame(width: 30, height: 30)
            .background(TaskifyTheme.accent.opacity(0.16), in: Circle())
    }

    @ViewBuilder
    private var contactPhoto: some View {
        if let picture = item.contact.picture, let URL = URL(string: picture) {
            AsyncImage(url: URL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    contactPhotoFallback
                }
            }
            .frame(width: 52, height: 52)
            .clipShape(Circle())
        } else {
            contactPhotoFallback
        }
    }

    private var contactPhotoFallback: some View {
        Circle()
            .fill(TaskifyTheme.accent.opacity(0.18))
            .overlay(
                Text(String(item.contact.primaryName.prefix(1)).uppercased())
                    .font(.headline)
                    .foregroundStyle(TaskifyTheme.accent)
            )
            .frame(width: 52, height: 52)
    }

    private var searchBorder: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .stroke(
                isSelectedSearchResult
                    ? TaskifyTheme.accent
                    : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                lineWidth: isSelectedSearchResult ? 2 : 1
            )
    }

    private func saveContact() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            do {
                try await model.acceptSharedContactInboxItem(item.id)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSaving = false
        }
    }
}

private struct SharedBoardChatCard: View {
    @Environment(AppModel.self) private var model
    let item: SharedBoardInboxItem
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var boardName: String {
        let trimmed = item.board.boardName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Shared board" : trimmed
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            sharedBoardAvatar

            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("SHARED BOARD", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(TaskifyTheme.accent)
                    Spacer()
                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(boardName)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(2)
                    Text("Add this board to your workspace")
                        .font(.caption)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                }

                if item.status == .pending {
                    HStack(spacing: 8) {
                        Button {
                            withAnimation(.snappy) {
                                model.dismissSharedBoardInboxItem(item.id)
                            }
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        } label: {
                            Text("Dismiss")
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                        }
                        .buttonStyle(.bordered)

                        Button { joinBoard() } label: {
                            Text("Add Board")
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    Label(
                        item.status == .accepted ? "Added" : "Dismissed",
                        systemImage: item.status == .accepted ? "checkmark.circle.fill" : "xmark.circle"
                    )
                    .font(.caption.weight(.bold))
                    .foregroundStyle(item.status == .accepted ? Color.green : TaskifyTheme.secondaryText)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(searchBorder)

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sharedBoardAvatar: some View {
        Image(systemName: "square.grid.2x2")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(TaskifyTheme.accent)
            .frame(width: 30, height: 30)
            .background(TaskifyTheme.accent.opacity(0.16), in: Circle())
    }

    private var searchBorder: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .stroke(
                isSelectedSearchResult
                    ? TaskifyTheme.accent
                    : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                lineWidth: isSelectedSearchResult ? 2 : 1
            )
    }

    private func joinBoard() {
        withAnimation(.snappy) {
            _ = model.acceptSharedBoardInboxItem(item.id)
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}

private struct SharedCalendarInviteChatCard: View {
    @Environment(AppModel.self) private var model
    @State private var isResponding = false
    @State private var responseError: String?
    let item: SharedCalendarInviteInboxItem
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Image(systemName: "calendar.badge.plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.orange)
                .frame(width: 30, height: 30)
                .background(Color.orange.opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 11) {
                HStack {
                    Label("EVENT INVITE", systemImage: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(.orange)
                    Spacer()
                    Text(item.receivedAt, style: .time)
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.tertiaryText)
                }

                Text(item.event.displayTitle)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(TaskifyTheme.primaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Label(whenLabel, systemImage: "calendar")
                    .font(.subheadline)
                    .foregroundStyle(TaskifyTheme.secondaryText)

                if item.status == .pending {
                    HStack(spacing: 7) {
                        responseButton("Decline", status: .declined, tint: .red)
                        responseButton("Maybe", status: .tentative, tint: .orange)
                        responseButton("Accept", status: .accepted, tint: TaskifyTheme.accent)
                    }
                } else {
                    Label(statusLabel, systemImage: statusSymbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(statusColor.opacity(0.13), in: Capsule())
                }

                if let responseError {
                    Text(responseError)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(
                        isSelectedSearchResult
                            ? TaskifyTheme.accent
                            : (isSearchMatch ? TaskifyTheme.accent.opacity(0.48) : Color.clear),
                        lineWidth: isSelectedSearchResult ? 2 : 1
                    )
            )

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var whenLabel: String {
        guard let start = item.event.startDate else {
            return item.event.start ?? "Date to be announced"
        }
        if item.event.isAllDay {
            guard let end = item.event.endDate, !Calendar.current.isDate(start, inSameDayAs: end) else {
                return start.formatted(date: .long, time: .omitted)
            }
            return "\(start.formatted(date: .abbreviated, time: .omitted)) – \(end.formatted(date: .abbreviated, time: .omitted))"
        }
        guard let end = item.event.endDate else {
            return start.formatted(date: .abbreviated, time: .shortened)
        }
        if Calendar.current.isDate(start, inSameDayAs: end) {
            return "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .omitted, time: .shortened))"
        }
        return "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .abbreviated, time: .shortened))"
    }

    private func responseButton(
        _ title: String,
        status: SharedInboxItemStatus,
        tint: Color
    ) -> some View {
        Button {
            respond(status: status)
        } label: {
            Group {
                if isResponding {
                    ProgressView().controlSize(.mini)
                } else {
                    Text(title)
                }
            }
            .font(.caption.weight(.semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 36)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .disabled(isResponding)
    }

    private func respond(status: SharedInboxItemStatus) {
        guard !isResponding else { return }
        isResponding = true
        responseError = nil
        Task {
            do {
                try await model.respondToSharedCalendarInvite(item.id, status: status)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                responseError = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isResponding = false
        }
    }

    private var statusLabel: String {
        switch item.status {
        case .accepted: "Accepted · Added to Taskify"
        case .declined: "Declined"
        case .tentative: "Maybe · Added to Taskify"
        case .pending: "Awaiting response"
        case .deleted: "Dismissed"
        }
    }

    private var statusSymbol: String {
        switch item.status {
        case .accepted: "checkmark.circle.fill"
        case .declined: "xmark.circle.fill"
        case .tentative: "questionmark.circle.fill"
        case .pending: "clock"
        case .deleted: "trash"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .accepted: .green
        case .declined: .red
        case .tentative: .orange
        case .pending: TaskifyTheme.secondaryText
        case .deleted: TaskifyTheme.tertiaryText
        }
    }
}

private struct DirectMessageMarkdownText: View {
    private let renderCache: ChatConversationRenderCache
    private let document: NostrChatMarkdownDocument
    private let isIncoming: Bool
    @State private var copiedCode: String?

    init(markdown: String, isIncoming: Bool, renderCache: ChatConversationRenderCache) {
        self.renderCache = renderCache
        document = renderCache.document(markdown)
        self.isIncoming = isIncoming
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                blockView(block)
                    .padding(.top, topPadding(for: block, at: index))
            }
        }
        .textSelection(.enabled)
        .tint(isIncoming ? TaskifyTheme.accent : Color.white)
        .environment(\.openURL, OpenURLAction { url in
            guard let code = NostrChatMarkdown.copiedCode(from: url) else {
                return .systemAction
            }
            copy(code)
            return .handled
        })
        .overlay(alignment: .topTrailing) {
            if copiedCode != nil {
                Label("Copied", systemImage: "checkmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.78), in: Capsule())
                    .offset(y: -29)
                    .transition(.scale.combined(with: .opacity))
                    .allowsHitTesting(false)
            }
        }
        .task(id: copiedCode) {
            guard copiedCode != nil else { return }
            do {
                try await Task.sleep(for: .seconds(1.25))
            } catch {
                return
            }
            withAnimation(.easeOut(duration: 0.18)) {
                copiedCode = nil
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: NostrChatMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let content):
            inlineText(content, font: .system(size: 16))
        case let .heading(level, content):
            inlineText(content, font: headingFont(level: level))
        case let .unorderedListItem(depth, content):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("•")
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 12, alignment: .trailing)
                inlineText(content, font: .system(size: 16))
            }
            .padding(.leading, CGFloat(depth) * 15)
        case let .orderedListItem(depth, number, content):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(number).")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(minWidth: 18, alignment: .trailing)
                inlineText(content, font: .system(size: 16))
            }
            .padding(.leading, CGFloat(depth) * 15)
        case let .blockQuote(depth, content):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(foregroundColor.opacity(0.38))
                    .frame(width: 3)
                inlineText(content, font: .system(size: 16).italic())
                    .foregroundStyle(foregroundColor.opacity(0.88))
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 12)
        case let .codeBlock(language, content):
            VStack(alignment: .leading, spacing: 5) {
                if let language {
                    Text(language.uppercased())
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(foregroundColor.opacity(0.62))
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(content)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(foregroundColor)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(10)
            .background(codeBackground, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .onTapGesture { copy(content) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Copies code")
        case .thematicBreak:
            Rectangle()
                .fill(foregroundColor.opacity(0.24))
                .frame(minWidth: 120, maxWidth: .infinity, minHeight: 1, maxHeight: 1)
        }
    }

    private func inlineText(_ markdown: String, font: Font) -> some View {
        Text(styledInlineMarkdown(markdown))
            .font(font)
            .foregroundStyle(foregroundColor)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func styledInlineMarkdown(_ markdown: String) -> AttributedString {
        var attributed = renderCache.inline(markdown)
        let runs = attributed.runs.map { run in
            (
                range: run.range,
                intent: run.inlinePresentationIntent,
                link: run.link
            )
        }
        for run in runs {
            if run.intent?.contains(.code) == true {
                let code = String(attributed[run.range].characters)
                attributed[run.range].font = .system(
                    size: 14.5,
                    weight: .medium,
                    design: .monospaced
                )
                attributed[run.range].foregroundColor = foregroundColor
                attributed[run.range].backgroundColor = codeBackground
                attributed[run.range].link = NostrChatMarkdown.copyURL(for: code)
                continue
            }
            if let link = run.link, !isSafeExternalLink(link) {
                attributed[run.range].link = nil
            }
        }
        return attributed
    }

    private var foregroundColor: Color {
        isIncoming ? TaskifyTheme.primaryText : .white
    }

    private var codeBackground: Color {
        isIncoming ? Color.white.opacity(0.12) : Color.black.opacity(0.2)
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1: .system(size: 22, weight: .bold)
        case 2: .system(size: 20, weight: .bold)
        case 3: .system(size: 18, weight: .bold)
        default: .system(size: 16, weight: .semibold)
        }
    }

    private func topPadding(for block: NostrChatMarkdownBlock, at index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        let previous = document.blocks[index - 1]
        if isListItem(block), isListItem(previous) { return 4 }
        if isBlockQuote(block), isBlockQuote(previous) { return 4 }
        return 10
    }

    private func isListItem(_ block: NostrChatMarkdownBlock) -> Bool {
        switch block {
        case .unorderedListItem, .orderedListItem: true
        default: false
        }
    }

    private func isBlockQuote(_ block: NostrChatMarkdownBlock) -> Bool {
        if case .blockQuote = block { return true }
        return false
    }

    private func isSafeExternalLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "https" || scheme == "http" || scheme == "mailto"
    }

    private func copy(_ code: String) {
        guard !code.isEmpty else { return }
        UIPasteboard.general.string = code
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation(.spring(response: 0.22, dampingFraction: 0.8)) {
            copiedCode = code
        }
    }
}

private struct DirectMessageBubble: View, Equatable {
    let renderCache: ChatConversationRenderCache
    let message: NostrDirectMessage
    let repliedMessage: NostrDirectMessage?
    let reactions: [NostrDirectMessageReaction]
    let senderName: String?
    let senderContact: NostrContact?
    let showsSenderAvatar: Bool
    let isGroupedWithPrevious: Bool
    let isGroupedWithNext: Bool
    let showsSentStatus: Bool
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var links: [URL] {
        Array(TaskContentLinks.allURLs(in: message.content).prefix(2))
    }

    /// A Cashu token pasted or forwarded as plain chat text rather than sent through the formal
    /// NUT-18 payment-request flow. Only offered for incoming messages — the sender already has
    /// their own record of a token they sent.
    private var detectedPaymentToken: String? {
        guard message.isIncoming, message.attachment == nil else { return nil }
        return CashuPaymentRequestContract.firstTokenSubstring(in: message.content)
    }

    var body: some View {
        // No per-row DragGesture here: a drag recognizer attached to every bubble races the
        // scroll view's pan recognizer on each touch-down and scrolling becomes sticky to the
        // point of immobility (an earlier swipe-left timestamp reveal did exactly that). The
        // timestamp is available through the bubble's context menu instead.
        VStack(spacing: repliedMessage == nil ? 0 : 2) {
            if let repliedMessage {
                DirectMessageReplyContext(
                    renderCache: renderCache,
                    message: repliedMessage,
                    responseIsIncoming: message.isIncoming,
                    responseHasAvatar: showsSenderAvatar
                )
            }

            HStack(alignment: .bottom, spacing: 7) {
                if !message.isIncoming { Spacer(minLength: 68) }

                if showsSenderAvatar {
                    Group {
                        if !isGroupedWithNext {
                            ChatPeerAvatar(
                                contact: senderContact,
                                publicKey: message.senderPublicKey,
                                size: 34
                            )
                        } else {
                            Color.clear.frame(width: 34, height: 1)
                        }
                    }
                }

                VStack(alignment: message.isIncoming ? .leading : .trailing, spacing: 3) {
                    if message.isIncoming, let senderName {
                        Text(senderName)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(TaskifyTheme.secondaryText)
                            .padding(.leading, 2)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        if let attachment = message.attachment {
                            DirectMessageAttachmentView(attachment: attachment)
                        } else if let detectedPaymentToken {
                            DirectMessagePaymentCard(token: detectedPaymentToken)
                        } else {
                            DirectMessageMarkdownText(
                                markdown: message.content,
                                isIncoming: message.isIncoming,
                                renderCache: renderCache
                            )

                            ForEach(links, id: \.absoluteString) { url in
                                DirectMessageLinkCard(url: url, isIncoming: message.isIncoming)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background {
                        bubbleShape
                            .fill(
                                message.isIncoming
                                    ? Color(red: 44 / 255, green: 44 / 255, blue: 48 / 255).opacity(0.98)
                                    : TaskifyTheme.accent
                            )
                    }
                    .overlay(alignment: message.isIncoming ? .topTrailing : .topLeading) {
                        if !reactions.isEmpty {
                            DirectMessageReactionBadge(
                                reactions: reactions,
                                isIncoming: message.isIncoming
                            )
                            .offset(x: message.isIncoming ? 10 : -10, y: -30)
                        }
                    }
                    .padding(.top, reactions.isEmpty ? 0 : 30)

                    if !message.isIncoming, let deliveryState = message.deliveryState,
                       deliveryState != .sent || showsSentStatus {
                        HStack(spacing: 3) {
                            Image(systemName: deliveryStateSymbol(deliveryState))
                            Text(deliveryStateLabel(deliveryState))
                        }
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(
                            deliveryState == .failed ? Color.red : TaskifyTheme.tertiaryText
                        )
                        .accessibilityLabel("Message \(deliveryStateLabel(deliveryState))")
                    }
                }

                if message.isIncoming { Spacer(minLength: 68) }
            }
        }
        .padding(.vertical, isGroupedWithPrevious && repliedMessage == nil ? 1 : 4)
        .contentShape(Rectangle())
        .background {
            if isSearchMatch {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TaskifyTheme.accent.opacity(isSelectedSearchResult ? 0.18 : 0.06))
            }
        }
        .overlay {
            if isSelectedSearchResult {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TaskifyTheme.accent.opacity(0.9), lineWidth: 1.5)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isSelectedSearchResult)
    }

    private var bubbleShape: DirectMessageBubbleShape {
        DirectMessageBubbleShape(
            isIncoming: message.isIncoming,
            showsTail: !isGroupedWithNext
        )
    }

    private func deliveryStateSymbol(_ state: NostrDirectMessageDeliveryState) -> String {
        switch state {
        case .queued: "clock"
        case .sent: "checkmark"
        case .failed: "exclamationmark.circle.fill"
        }
    }

    private func deliveryStateLabel(_ state: NostrDirectMessageDeliveryState) -> String {
        switch state {
        case .queued: "Sending…"
        case .sent: "Sent"
        case .failed: "Failed"
        }
    }
}

private struct DirectMessageReplyContext: View {
    let renderCache: ChatConversationRenderCache
    let message: NostrDirectMessage
    let responseIsIncoming: Bool
    let responseHasAvatar: Bool

    private var bubbleShape: DirectMessageBubbleShape {
        DirectMessageBubbleShape(
            isIncoming: message.isIncoming,
            showsTail: true
        )
    }

    private var strokeColor: Color {
        message.isIncoming ? Color.white.opacity(0.34) : TaskifyTheme.accent.opacity(0.82)
    }

    private var textColor: Color {
        message.isIncoming ? TaskifyTheme.secondaryText : TaskifyTheme.accent
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                if !message.isIncoming { Spacer(minLength: 68) }

                Text(renderCache.inline(message.displayContent))
                    .font(.caption)
                    .foregroundStyle(textColor)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(message.isIncoming ? .leading : .trailing)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .frame(maxWidth: 310, alignment: message.isIncoming ? .leading : .trailing)
                    .background {
                        bubbleShape.fill(Color.black.opacity(0.42))
                    }
                    .overlay {
                        bubbleShape.stroke(strokeColor, lineWidth: 1)
                    }

                if message.isIncoming { Spacer(minLength: 68) }
            }
            .padding(.leading, message.isIncoming && responseHasAvatar ? 41 : 0)

            ReplyConnectorShape(isIncoming: responseIsIncoming)
                .stroke(
                    Color.white.opacity(0.22),
                    style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 31, height: 18)
                .frame(maxWidth: .infinity, alignment: responseIsIncoming ? .leading : .trailing)
                .padding(.leading, responseIsIncoming ? (responseHasAvatar ? 52 : 12) : 0)
                .padding(.trailing, responseIsIncoming ? 0 : 12)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("In reply to \(message.displayContent)")
    }
}

private struct DirectMessageReactionBadge: View {
    let reactions: [NostrDirectMessageReaction]
    let isIncoming: Bool

    private let badgeFill = Color(red: 37 / 255, green: 37 / 255, blue: 41 / 255)

    private var emojis: [String] {
        reactions.reduce(into: [String]()) { values, reaction in
            if !values.contains(reaction.emoji) { values.append(reaction.emoji) }
        }
    }

    var body: some View {
        HStack(spacing: -4) {
            ForEach(emojis, id: \.self) { emoji in
                let count = reactions.filter { $0.emoji == emoji }.count
                ZStack {
                    Circle()
                        .fill(badgeFill)
                    Circle()
                        .stroke(Color.white.opacity(0.13), lineWidth: 0.7)
                    Text(emoji)
                        .font(.system(size: 20))
                }
                .frame(width: 38, height: 38)
                .overlay(alignment: .topTrailing) {
                    if count > 1 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color.white.opacity(0.9))
                            .frame(width: 15, height: 15)
                            .background(Color(red: 79 / 255, green: 79 / 255, blue: 84 / 255), in: Circle())
                            .offset(x: 2, y: -2)
                    }
                }
            }
        }
        .overlay(alignment: isIncoming ? .bottomTrailing : .bottomLeading) {
            ZStack {
                Circle()
                    .frame(width: 9, height: 9)
                Circle()
                    .frame(width: 4.5, height: 4.5)
                    .offset(x: isIncoming ? 7 : -7, y: 8)
            }
            .foregroundStyle(badgeFill)
            .offset(x: isIncoming ? 1 : -1, y: 5)
        }
        .shadow(color: Color.black.opacity(0.28), radius: 2, y: 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Reactions: \(emojis.joined(separator: ", "))")
    }
}

private struct ReplyConnectorShape: Shape {
    let isIncoming: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        if isIncoming {
            path.move(to: CGPoint(x: rect.maxX - 2, y: rect.minY + 2))
            path.addCurve(
                to: CGPoint(x: rect.minX + 2, y: rect.maxY - 2),
                control1: CGPoint(x: rect.minX + 11, y: rect.minY + 2),
                control2: CGPoint(x: rect.minX + 2, y: rect.minY + 9)
            )
        } else {
            path.move(to: CGPoint(x: rect.minX + 2, y: rect.minY + 2))
            path.addCurve(
                to: CGPoint(x: rect.maxX - 2, y: rect.maxY - 2),
                control1: CGPoint(x: rect.maxX - 11, y: rect.minY + 2),
                control2: CGPoint(x: rect.maxX - 2, y: rect.minY + 9)
            )
        }
        return path
    }
}

private struct DirectMessageBubbleShape: Shape {
    let isIncoming: Bool
    let showsTail: Bool

    func path(in rect: CGRect) -> Path {
        let radius = min(CGFloat(18), rect.height / 2)
        guard showsTail else {
            return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect)
        }

        // Messages uses a compact tail that grows out of the bottom corner. Keep its height
        // independent from the body radius: tying the two together makes a one-line bubble's
        // tail start near its vertical midpoint and leaves the whole corner looking pinched.
        let tailWidth: CGFloat = 6
        let tailHeight = min(CGFloat(11), max(CGFloat(7), rect.height * 0.3))
        // The tail protrudes from the body's layout bounds instead of consuming horizontal
        // space inside them. That keeps the bodies and text of consecutive messages aligned.
        let bodyLeft = rect.minX
        let bodyRight = rect.maxX
        let top = rect.minY
        let bottom = rect.maxY
        var path = Path()

        if isIncoming {
            path.move(to: CGPoint(x: bodyLeft + radius, y: top))
            path.addLine(to: CGPoint(x: bodyRight - radius, y: top))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight, y: top + radius),
                control: CGPoint(x: bodyRight, y: top)
            )
            path.addLine(to: CGPoint(x: bodyRight, y: bottom - radius))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight - radius, y: bottom),
                control: CGPoint(x: bodyRight, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft + 16, y: bottom))
            path.addCurve(
                to: CGPoint(x: rect.minX - tailWidth, y: bottom),
                control1: CGPoint(x: bodyLeft + 10, y: bottom),
                control2: CGPoint(x: rect.minX - tailWidth + 4, y: bottom)
            )
            path.addCurve(
                to: CGPoint(x: bodyLeft, y: bottom - tailHeight),
                control1: CGPoint(x: rect.minX - tailWidth + 4, y: bottom),
                control2: CGPoint(x: bodyLeft, y: bottom - 5)
            )
            path.addLine(to: CGPoint(x: bodyLeft, y: top + radius))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft + radius, y: top),
                control: CGPoint(x: bodyLeft, y: top)
            )
        } else {
            path.move(to: CGPoint(x: bodyLeft + radius, y: top))
            path.addLine(to: CGPoint(x: bodyRight - radius, y: top))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight, y: top + radius),
                control: CGPoint(x: bodyRight, y: top)
            )
            path.addLine(to: CGPoint(x: bodyRight, y: bottom - tailHeight))
            path.addCurve(
                to: CGPoint(x: rect.maxX + tailWidth, y: bottom),
                control1: CGPoint(x: bodyRight, y: bottom - 5),
                control2: CGPoint(x: rect.maxX + tailWidth - 4, y: bottom)
            )
            path.addCurve(
                to: CGPoint(x: bodyRight - 16, y: bottom),
                control1: CGPoint(x: rect.maxX + tailWidth - 4, y: bottom),
                control2: CGPoint(x: bodyRight - 10, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft + radius, y: bottom))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft, y: bottom - radius),
                control: CGPoint(x: bodyLeft, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft, y: top + radius))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft + radius, y: top),
                control: CGPoint(x: bodyLeft, y: top)
            )
        }

        path.closeSubpath()
        return path
    }
}

private struct DirectMessageLinkCard: View {
    @Environment(\.openURL) private var openURL
    let url: URL
    let isIncoming: Bool

    private var host: String {
        url.host(percentEncoded: false)?.replacingOccurrences(of: "www.", with: "")
            ?? url.absoluteString
    }

    private var faviconURL: URL? { TaskContentLinks.faviconURL(for: url) }

    var body: some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: 10) {
                faviconIcon
                    .foregroundStyle(isIncoming ? TaskifyTheme.accent : .white)
                    .frame(width: 34, height: 34)
                    .background(
                        isIncoming ? TaskifyTheme.accent.opacity(0.16) : Color.black.opacity(0.14),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(TaskContentLinks.fallbackTitle(for: url))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                        .lineLimit(2)
                    Text(host)
                        .font(.caption2)
                        .foregroundStyle(isIncoming ? TaskifyTheme.secondaryText : Color.white.opacity(0.72))
                        .lineLimit(1)
                }

                Spacer(minLength: 2)
                Image(systemName: "arrow.up.right")
                    .font(.caption2.bold())
                    .foregroundStyle(isIncoming ? TaskifyTheme.secondaryText : Color.white.opacity(0.8))
            }
            .padding(8)
            .frame(maxWidth: 270, alignment: .leading)
            .background(
                isIncoming ? Color.white.opacity(0.055) : Color.black.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 13, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(Color.white.opacity(0.10), lineWidth: 0.7)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open link to \(host)")
    }

    @ViewBuilder
    private var faviconIcon: some View {
        if let faviconURL {
            AsyncImage(url: faviconURL) { phase in
                if case let .success(image) = phase {
                    image
                        .resizable()
                        .scaledToFit()
                        .padding(7)
                } else {
                    Image(systemName: "link")
                        .font(.subheadline.bold())
                }
            }
        } else {
            Image(systemName: "link")
                .font(.subheadline.bold())
        }
    }
}

/// A Cashu token sent as plain chat text rather than through the formal payment-request flow.
/// Redeeming reuses the wallet's normal receive sheet unchanged — this view only recognizes the
/// token and offers a shortcut into that review-before-claim flow, never claims funds itself.
private struct DirectMessagePaymentCard: View {
    @EnvironmentObject private var wallet: WalletViewModel
    let token: String
    @State private var showingReceiveSheet = false

    private var summary: CashuOfflineTokenSummary? {
        CashuWalletService.offlineTokenSummary(token)
    }

    var body: some View {
        Button {
            showingReceiveSheet = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "bitcoinsign.circle.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(TaskifyTheme.accent)
                    .frame(width: 34, height: 34)
                    .background(TaskifyTheme.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.map { "\($0.amount.formatted()) sats" } ?? "Cashu token received")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TaskifyTheme.primaryText)
                    Text(summary?.memo ?? "Tap to redeem")
                        .font(.caption2)
                        .foregroundStyle(TaskifyTheme.secondaryText)
                        .lineLimit(1)
                }

                Spacer(minLength: 2)
                Image(systemName: "arrow.down.circle")
                    .font(.caption2.bold())
                    .foregroundStyle(TaskifyTheme.secondaryText)
            }
            .padding(8)
            .frame(maxWidth: 270, alignment: .leading)
            .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(Color.white.opacity(0.10), lineWidth: 0.7)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary.map { "Redeem \($0.amount) sat Cashu token" } ?? "Redeem Cashu token")
        .sheet(isPresented: $showingReceiveSheet) {
            ReceiveCashuSheet(wallet: wallet, initialToken: token)
        }
    }
}

private struct DirectMessageAttachmentView: View {
    let attachment: NostrDirectMessageAttachment
    var compact = false

    @State private var image: UIImage?
    @State private var isLoading = false
    @State private var failed = false
    @State private var previewURL: URL?
    @State private var retryID = UUID()

    var body: some View {
        Button(action: openAttachment) {
            Group {
                if compact {
                    compactPreview
                } else if attachment.isImage {
                    imagePreview
                } else {
                    filePreview
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .task(id: retryID) {
            guard attachment.isImage else { return }
            await loadImage()
        }
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { old, new in
            if let old, old != new { try? FileManager.default.removeItem(at: old) }
        }
        .accessibilityLabel("Open \(attachment.displayName)")
    }

    private var compactPreview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(Color.black.opacity(0.2))

            if attachment.isImage, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            } else if failed {
                VStack(spacing: 7) {
                    Image(systemName: "arrow.clockwise")
                        .font(.title2.weight(.semibold))
                    Text("Retry")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(TaskifyTheme.secondaryText)
            } else if isLoading {
                ProgressView()
            } else {
                VStack(spacing: 8) {
                    Image(systemName: attachmentIcon)
                        .font(.title2)
                    Text(attachment.displayName)
                        .font(.caption.weight(.semibold))
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                .foregroundStyle(TaskifyTheme.primaryText)
                .padding(10)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 150)
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 0.8)
        )
    }

    @ViewBuilder
    private var imagePreview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.black.opacity(0.2))

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .frame(height: imageHeight)
                    .clipped()
            } else if failed {
                VStack(spacing: 7) {
                    Image(systemName: "arrow.clockwise")
                        .font(.title3.weight(.semibold))
                    Text("Photo unavailable · Retry")
                        .font(.caption.weight(.medium))
                }
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(maxWidth: .infinity, minHeight: 150)
            } else {
                VStack(spacing: 8) {
                    ProgressView()
                    Text("Decrypting photo")
                        .font(.caption2)
                }
                .foregroundStyle(TaskifyTheme.secondaryText)
                .frame(maxWidth: .infinity, minHeight: 150)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: imageHeight)
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 0.8)
        )
    }

    private var filePreview: some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(0.1))
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: attachmentIcon)
                        .font(.title3)
                }
            }
            .frame(width: 44, height: 50)

            VStack(alignment: .leading, spacing: 3) {
                Text(attachment.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                HStack(spacing: 5) {
                    Text(fileKind)
                    if let size = attachment.size {
                        Text("·")
                        Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    }
                }
                .font(.caption2)
                .foregroundStyle(TaskifyTheme.secondaryText)
            }
            Spacer(minLength: 3)
            Image(systemName: failed ? "arrow.clockwise" : "arrow.up.forward.app")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TaskifyTheme.secondaryText)
        }
        .padding(9)
        .frame(minWidth: 220)
        .background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(TaskifyTheme.border, lineWidth: 0.8)
        )
    }

    private var imageHeight: CGFloat {
        guard let width = attachment.width,
              let height = attachment.height,
              width > 0 else { return 190 }
        return min(250, max(140, 265 * CGFloat(height) / CGFloat(width)))
    }

    private var attachmentIcon: String { attachment.detailIcon }

    private var fileKind: String { attachment.detailKindLabel }

    @MainActor
    private func loadImage() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
            guard !Task.isCancelled else { return }
            guard let decoded = await DirectMessageAttachmentImageLoader.shared.image(
                fileURL: file,
                cacheKey: attachment.cacheKey,
                maximumPixelSize: 1_080
            ) else {
                throw ChatAttachmentError.unreadableFile
            }
            image = decoded
            failed = false
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }

    private func openAttachment() {
        if failed && attachment.isImage {
            failed = false
            retryID = UUID()
            return
        }
        isLoading = true
        Task { @MainActor in
            defer { isLoading = false }
            do {
                let file = try await DirectMessageAttachmentDataLoader.shared.file(for: attachment)
                previewURL = try DirectMessageAttachmentDataLoader.previewFile(
                    file: file,
                    attachment: attachment
                )
                failed = false
            } catch {
                failed = true
            }
        }
    }
}

private actor DirectMessageAttachmentDataLoader {
    static let shared = DirectMessageAttachmentDataLoader()
    private var files: [String: URL] = [:]
    private var order: [String] = []

    func file(for attachment: NostrDirectMessageAttachment) async throws -> URL {
        if let file = files[attachment.cacheKey], FileManager.default.fileExists(atPath: file.path) { return file }
        if let cached = await DirectMessageAttachmentDiskCache.shared.file(forKey: attachment.cacheKey) {
            remember(cached, forKey: attachment.cacheKey)
            return cached
        }
        guard let url = URL(string: attachment.url) else { throw ChatAttachmentError.invalidURL }
        let ciphertext = try await AttachmentDownload.file(from: url, limit: AttachmentFiles.maximumBytes + 16)
        defer { try? FileManager.default.removeItem(at: ciphertext) }
        let plaintext = try await AttachmentFiles.work {
            try AttachmentFileCrypto.decryptChat(ciphertext, attachment: attachment)
        }
        // The disk cache owns stored files from here on; if storing fails, the
        // plaintext temp file still works and is purged with other temporary files.
        let stored = await DirectMessageAttachmentDiskCache.shared.store(plaintext, forKey: attachment.cacheKey)
        remember(stored ?? plaintext, forKey: attachment.cacheKey)
        return stored ?? plaintext
    }

    private func remember(_ file: URL, forKey key: String) {
        files[key] = file
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > 2 {
            files.removeValue(forKey: order.removeFirst())
        }
    }

    nonisolated static func previewFile(file: URL, attachment: NostrDirectMessageAttachment) throws -> URL {
        let directory = try AttachmentFiles.directory().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try AttachmentFiles.protect(directory)
        let cleaned = attachment.displayName.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "Attachment" : String(cleaned.prefix(160))
        let url = directory.appendingPathComponent(name)
        try FileManager.default.copyItem(at: file, to: url)
        try AttachmentFiles.protect(url)
        return url
    }
}

/// Persistently caches decrypted chat attachments so returning to a conversation or
/// relaunching the app renders immediately instead of re-downloading and
/// re-decrypting every image and file again. Entries live in the OS-managed caches
/// directory, are keyed by the full attachment descriptor (URL + key + nonce — a
/// key therefore maps to exactly one plaintext), and are evicted least-recently-used
/// once the total size exceeds `byteLimit`. Files carry the same owner-only
/// permissions and first-unlock protection as every other Taskify media file.
private actor DirectMessageAttachmentDiskCache {
    static let shared = DirectMessageAttachmentDiskCache()

    /// Bounds total disk usage; decrypted attachments are already capped at 500 MB
    /// individually by `AttachmentFiles.maximumBytes`.
    private static let byteLimit = 256 * 1_024 * 1_024

    private let directory: URL

    init() {
        // The system may empty the caches directory under storage pressure; that is
        // acceptable for a cache — the loader just falls back to downloading again.
        let fileManager = FileManager.default
        let base = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        directory = base.appendingPathComponent("TaskifyChatAttachments", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                          attributes: [.posixPermissions: 0o700])
        try? AttachmentFiles.protect(directory)
    }

    private func filename(forKey key: String) -> String {
        Data(SHA256.hash(data: Data(key.utf8))).hexString
    }

    /// Returns the cached plaintext for `key`, refreshing its recency so eviction
    /// is least-recently-used.
    func file(forKey key: String) -> URL? {
        let fileManager = FileManager.default
        let url = directory.appendingPathComponent(filename(forKey: key))
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        touchRecency(of: url)
        return url
    }

    /// Moves a freshly decrypted file into the cache, evicting least-recently-used
    /// entries past the byte limit. Returns the cache URL, or nil if storing failed.
    func store(_ file: URL, forKey key: String) -> URL? {
        let fileManager = FileManager.default
        let destination = directory.appendingPathComponent(filename(forKey: key))
        if fileManager.fileExists(atPath: destination.path) {
            try? fileManager.removeItem(at: file)
            touchRecency(of: destination)
            return destination
        }
        do {
            try fileManager.moveItem(at: file, to: destination)
        } catch {
            return nil
        }
        try? AttachmentFiles.protect(destination)
        trimToByteLimit()
        return destination
    }

    private func touchRecency(of url: URL) {
        var mutableURL = url
        var values = URLResourceValues()
        values.contentModificationDate = Date()
        try? mutableURL.setResourceValues(values)
    }

    private func trimToByteLimit() {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: keys
        ) else { return }
        var candidates: [(url: URL, size: Int, date: Date)] = []
        var total = 0
        for entry in entries {
            guard let values = try? entry.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true,
                  let size = values.fileSize else { continue }
            total += size
            candidates.append((entry, size, values.contentModificationDate ?? .distantPast))
        }
        guard total > Self.byteLimit else { return }
        for entry in candidates.sorted(by: { $0.date < $1.date }) {
            guard total > Self.byteLimit else { break }
            if (try? FileManager.default.removeItem(at: entry.url)) != nil {
                total -= entry.size
            }
        }
    }
}

private actor DirectMessageAttachmentImageLoader {
    static let shared = DirectMessageAttachmentImageLoader()

    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 64 * 1_024 * 1_024
        return cache
    }()

    func image(
        fileURL: URL,
        cacheKey: String,
        maximumPixelSize: CGFloat
    ) async -> UIImage? {
        let key = "\(Int(maximumPixelSize))::\(cacheKey)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let image = await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else {
                return nil as UIImage?
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                options as CFDictionary
            ) else {
                return nil
            }
            return UIImage(cgImage: thumbnail)
        }.value
        guard let image else { return nil }
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        cache.setObject(image, forKey: key, cost: cost)
        return image
    }

    nonisolated static func dimensions(data: Data) async -> (width: Int, height: Int)? {
        await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                    as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
                return nil
            }
            return (width.intValue, height.intValue)
        }.value
    }
}

private extension NostrDirectMessageAttachment {
    var cacheKey: String {
        "\(url)::\(keyHex)::\(nonceHex)"
    }

    var detailIcon: String {
        if isVideo { return "video.fill" }
        if isAudio { return "waveform" }
        if mimeType.lowercased().contains("pdf") { return "doc.richtext.fill" }
        return "doc.fill"
    }

    var detailKindLabel: String {
        if isVideo { return "VIDEO" }
        if isAudio { return "AUDIO" }
        if mimeType.lowercased().contains("pdf") { return "PDF" }
        return "FILE"
    }
}

private enum ChatAttachmentError: LocalizedError {
    case invalidURL
    case unreadableFile
    case downloadFailed(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL: "The attachment URL is invalid."
        case .unreadableFile: "The selected attachment could not be read."
        case .downloadFailed(let status): "The attachment server returned an error (\(status))."
        }
    }
}

/// Starts the conversation at the bottom without pinning it there. The unscoped
/// `defaultScrollAnchor(.bottom)` re-applies the anchor every time the content size
/// changes — which happens constantly in a `LazyVStack` while the user scrolls up and
/// older rows are realized, or when relay traffic mutates the timeline mid-drag — and
/// each re-application yanks the scroll position back toward the bottom, so swipes
/// never glide. On iOS 18+, scoping the anchor to the initial offset keeps the
/// chat-open behavior and frees the scroll. On iOS 17 there is no scoped variant, so
/// apply no anchor at all: the `onAppear` mark-read path already scrolls to the newest
/// message, and a momentary settle there beats a thread that fights the finger.
private extension View {
    @ViewBuilder
    func conversationBottomInitialAnchor() -> some View {
        if #available(iOS 18.0, *) {
            self
                .defaultScrollAnchor(.bottom, for: .initialOffset)
        }
    }
}
