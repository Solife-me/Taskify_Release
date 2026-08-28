import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import TaskifyCore
import UIKit
import UniformTypeIdentifiers

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
        return model.nostrContact(publicKey: model.identityPublicKey)
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
                        if searchText.isEmpty, !showingStrangers, !strangerThreads.isEmpty {
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
                        }

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

                        ForEach(filteredThreads) { thread in
                            NavigationLink(value: ChatConversationRoute(
                                peerPublicKey: thread.peerPublicKey
                            )) {
                                DirectMessageThreadRow(
                                    thread: thread,
                                    contact: model.nostrContact(publicKey: thread.peerPublicKey),
                                    group: model.groupConversation(id: thread.peerPublicKey),
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
            return "Shared contact: \(contact.contact.primaryName)"
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
                text: item.contact.primaryName,
                systemImage: "person.crop.circle.badge.plus",
                timestamp: Int(item.receivedAt.timeIntervalSince1970),
                senderName: item.sender.displayName
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
                isGroup: group != nil
            )

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(group?.displayName ?? contact?.displayName ?? latestStructuredPreview?.senderName ?? shortPublicKey)
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
    var isGroup = false

    var body: some View {
        Group {
            if isGroup {
                ZStack {
                    Circle().fill(TaskifyTheme.accent.opacity(0.22))
                    Image(systemName: "person.3.fill")
                        .font(.system(size: size * 0.36))
                        .foregroundStyle(TaskifyTheme.primaryText)
                }
                .frame(width: size, height: size)
                .overlay(Circle().stroke(TaskifyTheme.border, lineWidth: 1))
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
            .overlay {
                if model.nostrContacts.isEmpty {
                    ContentUnavailableView(
                        "No Contacts Yet",
                        systemImage: "person.2",
                        description: Text("Add or sync a contact before starting a new conversation.")
                    )
                }
            }
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

private enum GroupConversationDetailsTab: String, CaseIterable, Identifiable {
    case info = "Info"
    case photos = "Photos"
    case links = "Links"

    var id: String { rawValue }
}

private struct GroupConversationLink: Identifiable {
    let id: String
    let url: URL
    let senderPublicKey: String
    let createdAt: Int
}

private struct GroupConversationDetailsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var draftName = ""
    @State private var isEditingName = false
    @State private var isSaving = false
    @State private var statusMessage: String?
    @State private var errorMessage: String?
    @State private var selectedTab = GroupConversationDetailsTab.info
    let groupID: String

    private var group: NostrGroupConversation? { model.groupConversation(id: groupID) }
    private var messages: [NostrDirectMessage] { model.directMessages(with: groupID) }
    private var attachmentMessages: [NostrDirectMessage] {
        messages.filter { $0.attachment != nil }
    }
    private var links: [GroupConversationLink] {
        messages.flatMap { message in
            TaskContentLinks.allURLs(in: message.content).enumerated().map { index, url in
                GroupConversationLink(
                    id: "\(message.rumorEventID)-\(index)",
                    url: url,
                    senderPublicKey: message.senderPublicKey,
                    createdAt: message.createdAt
                )
            }
        }
    }

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
                                isGroup: true
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

                        groupDetailsTabs

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

    private var groupDetailsTabs: some View {
        HStack(spacing: 0) {
            ForEach(GroupConversationDetailsTab.allCases) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedTab = tab }
                } label: {
                    VStack(spacing: 8) {
                        Text(tab.rawValue)
                            .font(.subheadline.weight(selectedTab == tab ? .bold : .semibold))
                            .foregroundStyle(
                                selectedTab == tab ? TaskifyTheme.primaryText : TaskifyTheme.secondaryText
                            )
                        Capsule()
                            .fill(selectedTab == tab ? TaskifyTheme.accent : Color.clear)
                            .frame(height: 3)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private func tabContent(_ group: NostrGroupConversation) -> some View {
        switch selectedTab {
        case .info:
            infoContent(group)
        case .photos:
            attachmentContent
        case .links:
            linkContent
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
    private var attachmentContent: some View {
        if attachmentMessages.isEmpty {
            ContentUnavailableView(
                "No Shared Attachments",
                systemImage: "photo.on.rectangle.angled",
                description: Text("Photos and files shared with this group will appear here.")
            )
            .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 140), spacing: 12)],
                    spacing: 12
                ) {
                    ForEach(attachmentMessages) { message in
                        if let attachment = message.attachment {
                            DirectMessageAttachmentView(attachment: attachment, compact: true)
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    @ViewBuilder
    private var linkContent: some View {
        if links.isEmpty {
            ContentUnavailableView(
                "No Shared Links",
                systemImage: "link",
                description: Text("Web links shared in group messages will appear here.")
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
                            Text(linkMetadata(link))
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

    private func linkMetadata(_ link: GroupConversationLink) -> String {
        let sender = participantName(
            link.senderPublicKey,
            contact: model.nostrContact(publicKey: link.senderPublicKey)
        )
        let date = Date(timeIntervalSince1970: TimeInterval(link.createdAt))
            .formatted(date: .abbreviated, time: .shortened)
        return "\(sender) · \(date)"
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

private struct DirectMessageConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @FocusState private var composerFocused: Bool
    @FocusState private var searchFocused: Bool
    @State private var draft = ""
    @State private var isSending = false
    @State private var isSendingAttachment = false
    @State private var replyingTo: NostrDirectMessage?
    @State private var showingPhotoPicker = false
    @State private var photoSelection: PhotosPickerItem?
    @State private var showingFileImporter = false
    @State private var showingContactSharePicker = false
    @State private var showingGroupDetails = false
    @State private var isSearchingConversation = false
    @State private var searchQuery = ""
    @State private var selectedSearchResultID: String?
    @State private var searchSelectionTask: Task<Void, Never>?
    @State private var protectsInitialScrollTarget = false
    @State private var isAddingContact = false
    @State private var confirmingConversationDeletion = false
    let peerPublicKey: String
    let initialTimelineItemID: String?

    private var contact: NostrContact? { model.nostrContact(publicKey: peerPublicKey) }
    private var group: NostrGroupConversation? { model.groupConversation(id: peerPublicKey) }
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
                    $0.sender.publicKey.caseInsensitiveCompare(peerPublicKey) == .orderedSame
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
    private var timeline: [ChatTimelineItem] {
        let items =
            messages.map(ChatTimelineItem.message)
                + sharedTasks.map(ChatTimelineItem.sharedTask)
                + sharedContacts.map(ChatTimelineItem.sharedContact)
                + calendarInvites.map(ChatTimelineItem.calendarInvite)
                + sharedBoards.map(ChatTimelineItem.sharedBoard)

        // `created_at` has one-second precision. Keep the order established by the message store
        // for ties; an event-ID tiebreaker is effectively random and can flip a just-sent message
        // behind the response that followed it.
        return items.enumerated()
            .sorted {
                if $0.element.timestamp != $1.element.timestamp {
                    return $0.element.timestamp < $1.element.timestamp
                }
                return $0.offset < $1.offset
            }
            .map(\.element)
    }
    private var structuredSenderName: String? {
        var values: [(Date, String)] = sharedTasks.map { ($0.receivedAt, $0.sender.displayName) }
        values += sharedContacts.map { ($0.receivedAt, $0.sender.displayName) }
        values += calendarInvites.map { ($0.receivedAt, $0.sender.displayName) }
        values += sharedBoards.map { ($0.receivedAt, $0.sender.displayName) }
        return values.max { $0.0 < $1.0 }?.1
    }
    private var isStranger: Bool {
        group == nil && contact == nil && peerPublicKey != model.identityPublicKey
    }
    private var isBlocked: Bool { model.isDirectMessagePeerBlocked(peerPublicKey) }
    private var hasLeftGroup: Bool { group != nil && model.hasLeftDirectMessageGroup(peerPublicKey) }
    private var conversationTitle: String {
        group?.displayName ?? contact?.displayName ?? structuredSenderName ?? "Message"
    }
    private var searchResults: [ChatTimelineItem] {
        timeline.filter {
            $0.matchesSearch(searchQuery, senderName: senderName(for:))
        }
    }
    private var selectedSearchResultIndex: Int? {
        guard let selectedSearchResultID else { return nil }
        return searchResults.firstIndex { $0.id == selectedSearchResultID }
    }

    var body: some View {
        // Computed once per body evaluation instead of read as plain computed properties from
        // inside the per-row closure below. The timeline, reply lookup, reactions, sender
        // metadata, and search matches all scan model-wide collections; rebuilding any of them
        // from each visible row makes a short scroll perform dozens of full-history passes.
        let currentTimeline = timeline
        let currentMessages = currentTimeline.compactMap { item -> NostrDirectMessage? in
            guard case let .message(message) = item else { return nil }
            return message
        }
        var messageLookup: [String: NostrDirectMessage] = [:]
        messageLookup.reserveCapacity(currentMessages.count * 2)
        for message in currentMessages {
            messageLookup[message.rumorEventID] = message
            messageLookup[message.wrapEventID] = message
        }
        let reactionLookup = model.directMessageReactionLookup(peerPublicKey: peerPublicKey)
        let currentSearchMatches = Set(
            currentTimeline.lazy
                .filter {
                    !searchQuery.isEmpty &&
                        $0.matchesSearch(searchQuery, senderName: senderName(for:))
                }
                .map(\.id)
        )
        let senderContacts = Dictionary(
            model.nostrContacts.map { ($0.publicKey, $0) },
            uniquingKeysWith: { _, newest in newest }
        )
        let senderNames = Dictionary(
            uniqueKeysWithValues: Set(currentMessages.map(\.senderPublicKey)).map {
                ($0, senderName(for: $0))
            }
        )

        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if currentTimeline.isEmpty {
                        VStack(spacing: 12) {
                            ChatPeerAvatar(
                                contact: contact,
                                publicKey: peerPublicKey,
                                size: 72,
                                isGroup: group != nil
                            )
                            Text(group?.displayName ?? contact?.displayName ?? structuredSenderName ?? "New conversation")
                                .font(.headline)
                            Text("Messages are end-to-end encrypted with your Nostr identity.")
                                .font(.caption)
                                .foregroundStyle(TaskifyTheme.secondaryText)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.horizontal, 30)
                        .padding(.top, 70)
                    } else {
                        ForEach(Array(currentTimeline.enumerated()), id: \.element.id) { index, item in
                            if shouldShowDayDivider(at: index, in: currentTimeline) {
                                ChatDayDivider(timestamp: item.timestamp)
                            }

                            switch item {
                            case let .message(message):
                                let groupedWithPrevious = isMessageGrouped(at: index, with: index - 1, in: currentTimeline)
                                let groupedWithNext = isMessageGrouped(at: index + 1, with: index, in: currentTimeline)
                                let reactions = (reactionLookup[message.rumorEventID] ?? [])
                                    + (message.wrapEventID == message.rumorEventID
                                        ? []
                                        : reactionLookup[message.wrapEventID] ?? [])
                                DirectMessageBubble(
                                    message: message,
                                    repliedMessage: message.replyToEventID.flatMap {
                                        messageLookup[$0]
                                    },
                                    reactions: reactions,
                                    senderName: group != nil && message.isIncoming && !groupedWithPrevious
                                        ? senderNames[message.senderPublicKey] : nil,
                                    senderContact: group != nil && message.isIncoming
                                        ? senderContacts[message.senderPublicKey] : nil,
                                    showsSenderAvatar: group != nil && message.isIncoming,
                                    isGroupedWithPrevious: groupedWithPrevious,
                                    isGroupedWithNext: groupedWithNext,
                                    isSearchMatch: currentSearchMatches.contains(item.id),
                                    isSelectedSearchResult: selectedSearchResultID == item.id
                                )
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
                                .id(item.id)
                            case let .sharedTask(sharedTask):
                                SharedTaskChatCard(
                                    item: sharedTask,
                                    isSearchMatch: currentSearchMatches.contains(item.id),
                                    isSelectedSearchResult: selectedSearchResultID == item.id
                                )
                                .id(item.id)
                            case let .sharedContact(sharedContact):
                                SharedContactChatCard(
                                    item: sharedContact,
                                    isSearchMatch: currentSearchMatches.contains(item.id),
                                    isSelectedSearchResult: selectedSearchResultID == item.id
                                )
                                .id(item.id)
                            case let .calendarInvite(invite):
                                SharedCalendarInviteChatCard(
                                    item: invite,
                                    isSearchMatch: currentSearchMatches.contains(item.id),
                                    isSelectedSearchResult: selectedSearchResultID == item.id
                                )
                                .id(item.id)
                            case let .sharedBoard(sharedBoard):
                                SharedBoardChatCard(
                                    item: sharedBoard,
                                    isSearchMatch: currentSearchMatches.contains(item.id),
                                    isSelectedSearchResult: selectedSearchResultID == item.id
                                )
                                .id(item.id)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .conversationBottomInitialAnchor()
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
        .sheet(isPresented: $showingContactSharePicker) {
            ShareContactPickerSheet { contact in
                await shareContact(contact)
            }
            .environment(model)
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $photoSelection,
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .automatic
        )
        .onChange(of: photoSelection) { _, selection in
            guard let selection else { return }
            Task { await sendPhotoSelection(selection) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let URLs) = result, let URL = URLs.first else {
                if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
                return
            }
            Task { await sendFile(URL) }
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
                if group != nil { showingGroupDetails = true }
            } label: {
                VStack(spacing: 2) {
                    ChatPeerAvatar(
                        contact: contact,
                        publicKey: peerPublicKey,
                        size: 42,
                        isGroup: group != nil
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
            .disabled(group == nil)

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
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !isSending && !isSendingAttachment
    }

    private var composer: some View {
        VStack(spacing: 6) {
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
                }
                .padding(.horizontal, 9)
            }

            HStack(alignment: .bottom, spacing: 9) {
                Menu {
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
                .accessibilityLabel(isSendingAttachment ? "Sending attachment" : "Add attachment")

                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit { send() }
                    .padding(.horizontal, 15)
                    .padding(.vertical, 11)
                    .taskifyGlassControl(in: Capsule())

                Button {
                    send()
                } label: {
                    Group {
                        if isSending {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "paperplane.fill")
                                .font(.system(size: 16, weight: .bold))
                        }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .taskifyGlassControl(
                        in: Circle(),
                        tint: TaskifyTheme.accent.opacity(0.72),
                        fallbackFill: TaskifyTheme.accent
                    )
                }
                .buttonStyle(.plain)
                .opacity(canSend ? 1 : 0.45)
                .disabled(!canSend)
                .accessibilityLabel("Send message")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 5)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.5)
        }
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !isSending else { return }
        let capturedReply = replyingTo
        draft = ""
        replyingTo = nil
        isSending = true
        Task {
            do {
                try await model.sendDirectMessage(
                    to: peerPublicKey,
                    content: content,
                    replyToEventID: capturedReply?.rumorEventID
                )
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                draft = content
                replyingTo = capturedReply
                model.errorMessage = error.localizedDescription
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            isSending = false
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
    private func sendPhotoSelection(_ selection: PhotosPickerItem) async {
        defer { photoSelection = nil }
        do {
            guard let data = try await selection.loadTransferable(type: Data.self), !data.isEmpty else {
                throw ChatAttachmentError.unreadableFile
            }
            let contentType = selection.supportedContentTypes.first ?? .data
            let mimeType = contentType.preferredMIMEType ?? "application/octet-stream"
            let prefix = contentType.conforms(to: .movie) ? "Video" : "Photo"
            let name = "\(prefix).\(contentType.preferredFilenameExtension ?? "bin")"
            let dimensions = contentType.conforms(to: .image)
                ? await DirectMessageAttachmentImageLoader.dimensions(data: data)
                : nil
            try await sendAttachment(
                data: data,
                name: name,
                mimeType: mimeType,
                width: dimensions?.width,
                height: dimensions?.height
            )
        } catch {
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func sendFile(_ fileURL: URL) async {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer {
            if accessing { fileURL.stopAccessingSecurityScopedResource() }
        }
        do {
            let values = try fileURL.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey, .nameKey])
            if let size = values.fileSize, size > TaskDocumentContract.maximumUploadBytes {
                throw TaskAttachmentUploadError.fileTooLarge
            }
            let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
            let type = values.contentType
            let dimensions = type?.conforms(to: .image) == true
                ? await DirectMessageAttachmentImageLoader.dimensions(data: data)
                : nil
            try await sendAttachment(
                data: data,
                name: values.name ?? fileURL.lastPathComponent,
                mimeType: type?.preferredMIMEType ?? "application/octet-stream",
                width: dimensions?.width,
                height: dimensions?.height
            )
        } catch {
            model.errorMessage = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    @MainActor
    private func sendAttachment(
        data: Data,
        name: String,
        mimeType: String,
        width: Int?,
        height: Int?
    ) async throws {
        guard !isSending, !isSendingAttachment else { return }
        let capturedReply = replyingTo
        isSendingAttachment = true
        defer { isSendingAttachment = false }
        let attachment = try await TaskAttachmentUploadService.shared.uploadChatAttachment(
            data: data,
            name: name,
            mimeType: mimeType,
            width: width,
            height: height
        )
        try await model.sendDirectMessageAttachment(
            to: peerPublicKey,
            attachment: attachment,
            replyToEventID: capturedReply?.rumorEventID
        )
        replyingTo = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
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
        guard let timelineItemID = targetID ?? timeline.last?.id else { return }
        Task { @MainActor in
            await Task.yield()
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
    let isSearchMatch: Bool
    let isSelectedSearchResult: Bool

    private var isInContacts: Bool {
        guard let publicKey = item.contact.publicKey else { return false }
        return model.nostrContact(publicKey: publicKey) != nil
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            sharedContactAvatar

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
            }
            .padding(14)
            .frame(maxWidth: 340, alignment: .leading)
            .taskifyGlass(cornerRadius: 20)
            .overlay(searchBorder)

            Spacer(minLength: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

private struct DirectMessageBubble: View {
    let message: NostrDirectMessage
    let repliedMessage: NostrDirectMessage?
    let reactions: [NostrDirectMessageReaction]
    let senderName: String?
    let senderContact: NostrContact?
    let showsSenderAvatar: Bool
    let isGroupedWithPrevious: Bool
    let isGroupedWithNext: Bool
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
                            Text(message.content)
                                .font(.system(size: 16))
                                .foregroundStyle(message.isIncoming ? TaskifyTheme.primaryText : Color.white)
                                .textSelection(.enabled)

                            ForEach(links, id: \.absoluteString) { url in
                                DirectMessageLinkCard(url: url, isIncoming: message.isIncoming)
                            }
                        }
                    }
                    .padding(.leading, message.isIncoming && !isGroupedWithNext ? 18 : 14)
                    .padding(.trailing, !message.isIncoming && !isGroupedWithNext ? 18 : 14)
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
            isGroupedWithPrevious: isGroupedWithPrevious,
            isGroupedWithNext: isGroupedWithNext
        )
    }
}

private struct DirectMessageReplyContext: View {
    let message: NostrDirectMessage
    let responseIsIncoming: Bool
    let responseHasAvatar: Bool

    private var bubbleShape: DirectMessageBubbleShape {
        DirectMessageBubbleShape(
            isIncoming: message.isIncoming,
            isGroupedWithPrevious: false,
            isGroupedWithNext: false
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

                Text(message.displayContent)
                    .font(.caption)
                    .foregroundStyle(textColor)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(message.isIncoming ? .leading : .trailing)
                    .padding(.leading, message.isIncoming ? 17 : 12)
                    .padding(.trailing, message.isIncoming ? 12 : 17)
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
    let isGroupedWithPrevious: Bool
    let isGroupedWithNext: Bool

    func path(in rect: CGRect) -> Path {
        let showsTail = !isGroupedWithNext
        let tailWidth: CGFloat = showsTail ? 7 : 0
        let bodyLeft = rect.minX + (isIncoming ? tailWidth : 0)
        let bodyRight = rect.maxX - (isIncoming ? 0 : tailWidth)
        let top = rect.minY
        let bottom = rect.maxY
        // Short one-line and reply-preview bubbles can be under 38 points tall. Clamp the
        // radius so their top and bottom curves never cross when the path is drawn manually.
        let farRadius = min(CGFloat(19), rect.height / 2)
        let groupedRadius = min(CGFloat(7), farRadius)
        let topNearRadius = isGroupedWithPrevious ? groupedRadius : farRadius
        var path = Path()

        if isIncoming {
            path.move(to: CGPoint(x: bodyLeft + topNearRadius, y: top))
            path.addLine(to: CGPoint(x: bodyRight - farRadius, y: top))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight, y: top + farRadius),
                control: CGPoint(x: bodyRight, y: top)
            )
            path.addLine(to: CGPoint(x: bodyRight, y: bottom - farRadius))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight - farRadius, y: bottom),
                control: CGPoint(x: bodyRight, y: bottom)
            )

            if showsTail {
                path.addLine(to: CGPoint(x: bodyLeft + 18, y: bottom))
                path.addCurve(
                    to: CGPoint(x: bodyLeft + 7, y: bottom - 5),
                    control1: CGPoint(x: bodyLeft + 13, y: bottom),
                    control2: CGPoint(x: bodyLeft + 10, y: bottom - 1)
                )
                path.addCurve(
                    to: CGPoint(x: rect.minX + 0.5, y: bottom),
                    control1: CGPoint(x: bodyLeft + 5, y: bottom - 3),
                    control2: CGPoint(x: rect.minX + 4, y: bottom)
                )
                path.addCurve(
                    to: CGPoint(x: bodyLeft, y: bottom - farRadius),
                    control1: CGPoint(x: rect.minX + 6, y: bottom - 2),
                    control2: CGPoint(x: bodyLeft, y: bottom - 10)
                )
            } else {
                path.addLine(to: CGPoint(x: bodyLeft + groupedRadius, y: bottom))
                path.addQuadCurve(
                    to: CGPoint(x: bodyLeft, y: bottom - groupedRadius),
                    control: CGPoint(x: bodyLeft, y: bottom)
                )
            }

            path.addLine(to: CGPoint(x: bodyLeft, y: top + topNearRadius))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft + topNearRadius, y: top),
                control: CGPoint(x: bodyLeft, y: top)
            )
        } else {
            path.move(to: CGPoint(x: bodyLeft + farRadius, y: top))
            path.addLine(to: CGPoint(x: bodyRight - topNearRadius, y: top))
            path.addQuadCurve(
                to: CGPoint(x: bodyRight, y: top + topNearRadius),
                control: CGPoint(x: bodyRight, y: top)
            )

            if showsTail {
                path.addLine(to: CGPoint(x: bodyRight, y: bottom - farRadius))
                path.addCurve(
                    to: CGPoint(x: rect.maxX - 0.5, y: bottom),
                    control1: CGPoint(x: bodyRight, y: bottom - 10),
                    control2: CGPoint(x: rect.maxX - 6, y: bottom - 2)
                )
                path.addCurve(
                    to: CGPoint(x: bodyRight - 7, y: bottom - 5),
                    control1: CGPoint(x: rect.maxX - 4, y: bottom),
                    control2: CGPoint(x: bodyRight - 5, y: bottom - 3)
                )
                path.addCurve(
                    to: CGPoint(x: bodyRight - 18, y: bottom),
                    control1: CGPoint(x: bodyRight - 10, y: bottom - 1),
                    control2: CGPoint(x: bodyRight - 13, y: bottom)
                )
            } else {
                path.addLine(to: CGPoint(x: bodyRight, y: bottom - groupedRadius))
                path.addQuadCurve(
                    to: CGPoint(x: bodyRight - groupedRadius, y: bottom),
                    control: CGPoint(x: bodyRight, y: bottom)
                )
            }

            path.addLine(to: CGPoint(x: bodyLeft + farRadius, y: bottom))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft, y: bottom - farRadius),
                control: CGPoint(x: bodyLeft, y: bottom)
            )
            path.addLine(to: CGPoint(x: bodyLeft, y: top + farRadius))
            path.addQuadCurve(
                to: CGPoint(x: bodyLeft + farRadius, y: top),
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

    private var attachmentIcon: String {
        if attachment.isVideo { return "video.fill" }
        if attachment.isAudio { return "waveform" }
        if attachment.mimeType.lowercased().contains("pdf") { return "doc.richtext.fill" }
        return "doc.fill"
    }

    private var fileKind: String {
        if attachment.isVideo { return "VIDEO" }
        if attachment.isAudio { return "AUDIO" }
        if attachment.mimeType.lowercased().contains("pdf") { return "PDF" }
        return "FILE"
    }

    @MainActor
    private func loadImage() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let data = try await DirectMessageAttachmentDataLoader.shared.data(for: attachment)
            guard !Task.isCancelled else { return }
            guard let decoded = await DirectMessageAttachmentImageLoader.shared.image(
                data: data,
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
                let data = try await DirectMessageAttachmentDataLoader.shared.data(for: attachment)
                previewURL = try DirectMessageAttachmentDataLoader.previewFile(
                    data: data,
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
    private let cache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.totalCostLimit = 64 * 1_024 * 1_024
        return cache
    }()

    func data(for attachment: NostrDirectMessageAttachment) async throws -> Data {
        let cacheKey = attachment.cacheKey as NSString
        if let cached = cache.object(forKey: cacheKey) { return cached as Data }
        guard let URL = URL(string: attachment.url) else { throw ChatAttachmentError.invalidURL }
        let (ciphertext, response) = try await URLSession.shared.data(from: URL)
        if let response = response as? HTTPURLResponse,
           !(200..<300).contains(response.statusCode) {
            throw ChatAttachmentError.downloadFailed(response.statusCode)
        }
        guard ciphertext.count <= TaskDocumentContract.maximumUploadBytes + 16 else {
            throw TaskAttachmentUploadError.fileTooLarge
        }
        let plaintext = try NostrDirectMessageAttachmentCrypto.decrypt(
            ciphertext,
            attachment: attachment
        )
        guard plaintext.count <= TaskDocumentContract.maximumUploadBytes else {
            throw TaskAttachmentUploadError.fileTooLarge
        }
        cache.setObject(plaintext as NSData, forKey: cacheKey, cost: plaintext.count)
        return plaintext
    }

    nonisolated static func previewFile(
        data: Data,
        attachment: NostrDirectMessageAttachment
    ) throws -> URL {
        let safeName = safeFilename(attachment.displayName, mimeType: attachment.mimeType)
        let identifier = attachment.sha256 ?? String(attachment.keyHex.prefix(16))
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TaskifyChatPreviews", isDirectory: true)
            .appendingPathComponent(identifier, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let URL = directory.appendingPathComponent(safeName, isDirectory: false)
        try data.write(to: URL, options: .atomic)
        return URL
    }

    nonisolated private static func safeFilename(_ value: String, mimeType: String) -> String {
        let cleaned = value
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.contains(".") { return String(cleaned.prefix(180)) }
        let type = UTType(mimeType: mimeType)
        return "\(String(cleaned.prefix(160)))\(type?.preferredFilenameExtension.map { ".\($0)" } ?? "")"
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
        data: Data,
        cacheKey: String,
        maximumPixelSize: CGFloat
    ) async -> UIImage? {
        let key = "\(Int(maximumPixelSize))::\(cacheKey)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let image = await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
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
