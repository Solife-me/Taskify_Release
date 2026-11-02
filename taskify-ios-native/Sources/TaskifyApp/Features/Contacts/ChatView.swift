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

struct ChatConversationRoute: Hashable {
    let peerPublicKey: String
    let timelineItemID: String?

    init(peerPublicKey: String, timelineItemID: String? = nil) {
        self.peerPublicKey = peerPublicKey
        self.timelineItemID = timelineItemID
    }
}

struct ChatMessageSearchHit: Identifiable {
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
    @State private var preferredChatColumn: NavigationSplitViewColumn = .sidebar
    @State private var chatColumnVisibility: NavigationSplitViewVisibility = .all
    @Environment(\.horizontalSizeClass) private var chatHorizontalSizeClass
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

        return conversationNavigation {
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
                                    Button {
                                        openConversation(result.route)
                                    } label: {
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
                                Button {
                                    openConversation(ChatConversationRoute(
                                        peerPublicKey: thread.peerPublicKey
                                    ))
                                } label: {
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
                                .listRowBackground(
                                    UIDevice.current.userInterfaceIdiom == .pad &&
                                        navigationPath.last?.peerPublicKey == thread.peerPublicKey
                                        ? TaskifyTheme.accent.opacity(0.12) : Color.clear
                                )
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

        }
        .sheet(isPresented: $showingContactDirectory) {
            NostrContactsDirectoryView()
                .environment(model)
        }
        .fullScreenCover(isPresented: $showingNewConversation) {
            NewConversationSheet { peerPublicKey in
                showingNewConversation = false
                openConversation(ChatConversationRoute(peerPublicKey: peerPublicKey))
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
                openConversation(ChatConversationRoute(peerPublicKey: groupID))
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
                navigationPath.removeAll { $0.peerPublicKey == thread.peerPublicKey }
                if navigationPath.isEmpty { preferredChatColumn = .sidebar }
                threadPendingDeletion = nil
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
            Button("Cancel", role: .cancel) { threadPendingDeletion = nil }
        } message: {
            Text("This removes the local history and briefly suppresses relay replays so the conversation stays deleted.")
        }
    }

    /// A stable split view lets iPadOS collapse columns as the window resizes without
    /// replacing the conversation's state (including an unsent message or attachment).
    @ViewBuilder
    private func conversationNavigation<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        if UIDevice.current.userInterfaceIdiom == .pad {
            NavigationSplitView(
                columnVisibility: $chatColumnVisibility,
                preferredCompactColumn: $preferredChatColumn
            ) {
                content()
                    .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
            } detail: {
                NavigationStack {
                    if let route = navigationPath.last {
                        conversation(route)
                            .id(route)
                    } else {
                        ContentUnavailableView(
                            "Select a Conversation",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("Choose a chat or start a new message.")
                        )
                        .background(TaskifyAppBackground())
                    }
                }
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            NavigationStack(path: $navigationPath) {
                content().navigationDestination(for: ChatConversationRoute.self) { route in
                    conversation(route)
                }
            }
        }
    }

    private func openConversation(_ route: ChatConversationRoute) {
        navigationPath = [route]
        preferredChatColumn = .detail
    }

    private func conversation(_ route: ChatConversationRoute) -> some View {
        DirectMessageConversationView(
            peerPublicKey: route.peerPublicKey,
            initialTimelineItemID: route.timelineItemID,
            onClose: {
                navigationPath = []
                preferredChatColumn = .sidebar
            },
            // Expanded, the conversation list sits beside the thread, so "back" has nowhere to
            // go; the thread offers the list's column instead. Collapsed (Slide Over, a narrow
            // Split View), it is a pushed screen and keeps its back button.
            conversationListVisibility: UIDevice.current.userInterfaceIdiom == .pad
                && chatHorizontalSizeClass == .regular ? $chatColumnVisibility : nil
        )
        .environment(model)
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
        navigationPath.removeAll { $0.peerPublicKey == thread.peerPublicKey }
        if navigationPath.isEmpty { preferredChatColumn = .sidebar }
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

struct SharedTaskDestinationSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: SharedInboxItem
    var asCopy = false
    @State private var boardID = ""
    @State private var listID = ""
    @State private var errorMessage: String?

    private struct DestinationList: Identifiable {
        let boardID: String
        let columnID: String
        let name: String
        var id: String { "\(boardID.count):\(boardID)\(columnID)" }
    }

    private var boards: [Board] {
        model.visibleBoards.filter { $0.kind != .bible }
    }
    private var board: Board? { boards.first { $0.id == boardID } }
    private var lists: [DestinationList] {
        guard let board else { return [] }
        let sources = board.kind == .compound
            ? model.compoundChildBoards(for: board.id).filter { $0.isVisible }
            : [board]
        return sources.filter { $0.kind == .list }.flatMap { source in
            source.columns.sorted { $0.order < $1.order }.map { column in
                DestinationList(boardID: source.id, columnID: column.id,
                    name: board.kind == .compound ? "\(source.name) • \(column.name)" : column.name)
            }
        }
    }
    private var selectedList: DestinationList? {
        lists.first { $0.id == listID } ?? lists.first
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(item.task.title).font(.headline)
                    Picker("Board", selection: $boardID) {
                        if boards.isEmpty { Text("No task boards available").tag("") }
                        ForEach(boards) { board in Text(board.name).tag(board.id) }
                    }
                    if let board, board.kind != .week {
                        Picker("List", selection: Binding(
                            get: { selectedList?.id ?? "" }, set: { listID = $0 }
                        )) {
                            if lists.isEmpty { Text("No lists available").tag("") }
                            ForEach(lists) { list in Text(list.name).tag(list.id) }
                        }
                    }
                } footer: {
                    if board?.kind == .week {
                        Text("Added on the task’s due date, or today if no date is set.")
                    } else if selectedList == nil {
                        Text("Choose a task board with an available list, or a week board.")
                    }
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(asCopy ? "Add Task Again" : "Add Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { accept() }
                        .disabled(board == nil || (board?.kind != .week && selectedList == nil))
                }
            }
            .onAppear {
                boardID = boards.first { $0.id == model.selectedBoardID }?.id ?? boards.first?.id ?? ""
            }
            .onChange(of: boardID) { _, _ in listID = ""; errorMessage = nil }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func accept() {
        guard let board else { return }
        let destinationBoardID = board.kind == .week ? board.id : selectedList?.boardID
        guard let destinationBoardID else { return }
        if model.respondToSharedInboxItem(item.id, status: .accepted,
            destinationBoardID: destinationBoardID,
            destinationColumnID: board.kind == .week ? nil : selectedList?.columnID,
            asCopy: asCopy
        ) {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } else {
            errorMessage = "Unable to add this task. Check the destination and try again."
        }
    }
}
