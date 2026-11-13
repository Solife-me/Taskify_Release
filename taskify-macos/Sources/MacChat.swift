import AppKit
import Observation
import SwiftUI
import TaskifyCore
import TaskifyWatchShared

/// Drafts live outside `MacWorkspace`'s `@State` so typing only invalidates the composer that
/// reads the current conversation's text, not the sidebar, split view, or chat timeline.
@MainActor
@Observable
final class MacChatDraftStore {
    private var drafts: [String: String] = [:]

    func text(for peer: String) -> String {
        drafts[peer, default: ""]
    }

    func setText(_ text: String, for peer: String) {
        if text.isEmpty {
            drafts.removeValue(forKey: peer)
        } else {
            drafts[peer] = text
        }
    }

    func removeAll() {
        drafts.removeAll()
    }
}

struct MacChatView: View {
    let search: String
    let drafts: MacChatDraftStore
    @Binding var selection: String?
    @Environment(AppModel.self) private var model
    @State private var showNew = false
    @State private var showArchived = false
    @State private var showContacts = false
    @State private var taskDropPeer: String?
    private var peers: [String] {
        let values = model.directMessageThreads.map(\.peerPublicKey) + model.nostrContacts.map(\.publicKey)
        return Array(Set(values)).filter { peer in
            model.isDirectMessageThreadArchived(peer) == showArchived &&
            (search.isEmpty || name(peer).localizedCaseInsensitiveContains(search) || model.directMessages(with: peer).contains { $0.content.localizedCaseInsensitiveContains(search) })
        }.sorted { lhs, rhs in
            let a = model.directMessages(with: lhs).last?.createdAt ?? 0
            let b = model.directMessages(with: rhs).last?.createdAt ?? 0
            return a == b ? name(lhs) < name(rhs) : a > b
        }
    }
    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                HStack {
                    Toggle("Archived", isOn: $showArchived).toggleStyle(.checkbox)
                    Spacer()
                    Button { showContacts = true } label: { Image(systemName: "person.2") }.help("Contacts")
                    Button { showNew = true } label: { Image(systemName: "square.and.pencil") }.help("New Conversation")
                }.padding(14)
                List(selection: $selection) {
                    ForEach(peers, id: \.self) { peer in
                        HStack(spacing: 10) {
                            Text(String(name(peer).prefix(1)).uppercased()).font(.headline)
                                .frame(width: 36, height: 36).background(Color.accentColor.opacity(0.12), in: Circle())
                            VStack(alignment: .leading, spacing: 5) {
                                Text(name(peer)).font(.headline).lineLimit(1)
                                Text(model.directMessages(with: peer).last?.displayContent ?? "Start a conversation")
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            Spacer(minLength: 0)
                            if let count = model.directMessageThreads.first(where: { $0.peerPublicKey == peer })?.unreadCount, count > 0 {
                                Text("\(count)").font(.caption2.bold()).padding(5).background(Color.accentColor, in: Circle()).foregroundStyle(.white)
                            }
                        }.padding(.vertical, 5).tag(peer)
                            .contentShape(Rectangle())
                            .background(
                                taskDropPeer == peer ? Color.accentColor.opacity(0.14) : Color.clear,
                                in: RoundedRectangle(cornerRadius: 7)
                            )
                            .contextMenu {
                                Button(showArchived ? "Unarchive" : "Archive") {
                                    if showArchived { model.unarchiveDirectMessageThread(peerPublicKey: peer) }
                                    else { model.archiveDirectMessageThread(peerPublicKey: peer) }
                                }
                                Button(model.isDirectMessagePeerBlocked(peer) ? "Unblock" : "Block") {
                                    model.setDirectMessagePeerBlocked(peer, blocked: !model.isDirectMessagePeerBlocked(peer))
                                }
                            }
                            .dropDestination(for: String.self) { values, _ in
                                shareDroppedTasks(values, with: peer)
                            } isTargeted: { targeted in
                                if targeted { taskDropPeer = peer }
                                else if taskDropPeer == peer { taskDropPeer = nil }
                            }
                    }
                }.listStyle(.sidebar)
            }.frame(minWidth: 230, idealWidth: 280, maxWidth: 340)
            if let selection {
                MacConversation(peer: selection, title: name(selection),
                    composer: Binding(
                        get: { drafts.text(for: selection) },
                        set: { drafts.setText($0, for: selection) }
                    ))
                    .id(selection).frame(minWidth: 340)
            } else {
                ContentUnavailableView("Your Conversations", systemImage: "bubble.left.and.bubble.right", description: Text("Choose a conversation or start a new one."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.sheet(isPresented: $showNew) { MacNewConversation { selection = $0 } }
            .sheet(isPresented: $showContacts) { MacContactsView() }
    }
    private func name(_ peer: String) -> String {
        model.groupConversation(id: peer)?.displayName ?? model.nostrContact(publicKey: peer)?.displayName ?? String(peer.prefix(16))
    }
    private func shareDroppedTasks(_ values: [String], with peer: String) -> Bool {
        let taskIDs = Array(Set(values)).filter { model.task(withID: $0) != nil }
        guard !taskIDs.isEmpty,
              !model.isDirectMessagePeerBlocked(peer),
              !model.hasLeftDirectMessageGroup(peer) else { return false }
        taskDropPeer = nil
        Task { @MainActor in
            do {
                for taskID in taskIDs {
                    _ = try await model.sendSharedTask(
                        taskID: taskID,
                        recipientValue: peer,
                        assignment: false
                    )
                }
            } catch {
                model.errorMessage = error.localizedDescription
            }
        }
        return true
    }
}

private struct MacChatPresentation {
    let timeline: [MacChatTimelineItem]
    let messagesByID: [String: NostrDirectMessage]
    let hermesSessionsByListingMessageID: [String: HermesSessionListing]
}

/// Conversation history is independent of composer/search/send state. Cache the expensive merge,
/// sort and bot-response projection until chat or inbox content actually changes.
@MainActor
private final class MacChatRenderCache {
    private struct Key: Equatable {
        let revision: Int
        let identity: String
        let peer: String
        let botCommandsVersion: Int
    }

    private var key: Key?
    private var cachedPresentation: MacChatPresentation?

    func presentation(
        revision: Int,
        identity: String,
        peer: String,
        botCommandsVersion: Int,
        build: () -> MacChatPresentation
    ) -> MacChatPresentation {
        let nextKey = Key(
            revision: revision,
            identity: identity,
            peer: peer,
            botCommandsVersion: botCommandsVersion
        )
        if key == nextKey, let cachedPresentation { return cachedPresentation }
        let presentation = build()
        key = nextKey
        cachedPresentation = presentation
        return presentation
    }
}

private struct MacConversation: View {
    let peer: String
    let title: String
    @Binding var composer: String
    @Environment(AppModel.self) private var model
    @Environment(\.controlActiveState) private var activeState
    @State private var deleting = false
    @State private var groupDetails = false
    @State private var search = ""
    @State private var taskDropTargeted = false
    @State private var sharingDroppedTaskCount = 0
    @State private var timelineHistoryTask: Task<Void, Never>?
    @State private var loadedTimelineItemCount = MacChatTimelineWindow.initialPageSize
    @State private var isLoadingEarlierTimelineItems = false
    @State private var canLoadEarlierAtTop = false
    @State private var followsLatestMessage = true
    @State private var lastSearchResultID: String?
    @State private var renderCache = MacChatRenderCache()
    @State private var composerProxy = MacChatComposerProxy()
    private var isGroup: Bool { model.groupConversation(id: peer) != nil }
    private var presentation: MacChatPresentation {
        renderCache.presentation(
            revision: model.conversationRevision,
            identity: model.identityPublicKey,
            peer: peer,
            botCommandsVersion: model.botCommandsVersion
        ) {
            makePresentation()
        }
    }
    private var timeline: [MacChatTimelineItem] { presentation.timeline }
    private var isSearchingConversation: Bool {
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var visibleTimeline: [MacChatTimelineItem] {
        guard !isSearchingConversation else {
            return timeline.filter { $0.matchesSearch(search) }
        }
        let range = MacChatTimelineWindow.visibleRange(
            totalCount: timeline.count,
            loadedCount: loadedTimelineItemCount
        )
        return Array(timeline[range])
    }
    private var hasEarlierTimelineItems: Bool {
        !isSearchingConversation && visibleTimeline.count < timeline.count
    }
    /// A sender's back-to-back photos collapse into one stack, drawn by the newest photo.
    private var photoStacks: DirectMessagePhotoStacks.Grouping {
        DirectMessagePhotoStacks.group(visibleTimeline.map { item in
            if case .message(let message) = item { return message }
            return nil
        })
    }
    private var drawnVisibleTimeline: [MacChatTimelineItem] {
        let grouped = photoStacks
        return drawnTimeline(using: grouped)
    }
    private func drawnTimeline(using grouped: DirectMessagePhotoStacks.Grouping) -> [MacChatTimelineItem] {
        return visibleTimeline.filter { item in
            if case .message(let message) = item { return !grouped.stackedMessageIDs.contains(message.id) }
            return true
        }
    }
    private func makePresentation() -> MacChatPresentation {
        let messages = model.directMessages(with: peer)
        let sharedTasks = model.sharedInboxItems.filter {
            $0.status != .deleted && $0.conversationPublicKey.caseInsensitiveCompare(peer) == .orderedSame
        }
        let sharedContacts = model.sharedContactInboxItems.filter {
            $0.status != .deleted && $0.conversationPublicKey.caseInsensitiveCompare(peer) == .orderedSame
        }
        let calendarInvites = model.sharedCalendarInviteItems.filter {
            $0.status != .deleted && $0.conversationPublicKey.caseInsensitiveCompare(peer) == .orderedSame
        }
        let sharedBoards = model.sharedBoardInboxItems.filter {
            $0.status != .deleted && $0.sender.publicKey.caseInsensitiveCompare(peer) == .orderedSame
        }
        let structuredRumorIDs = Set(sharedTasks.map(\.rumorEventID) + calendarInvites.map(\.rumorEventID))
        let hermesProjection = HermesModelPickerProjection.project(
            messages: messages,
            enabled: !isGroup && model.isBot(publicKey: peer)
        )
        let items: [MacChatTimelineItem] =
            messages.filter {
                !structuredRumorIDs.contains($0.rumorEventID) &&
                    !hermesProjection.hiddenMessageIDs.contains($0.rumorEventID)
            }.map(MacChatTimelineItem.message)
                + sharedTasks.map(MacChatTimelineItem.sharedTask)
                + sharedContacts.map(MacChatTimelineItem.sharedContact)
                + calendarInvites.map(MacChatTimelineItem.calendarInvite)
                + sharedBoards.map(MacChatTimelineItem.sharedBoard)
        // Nostr timestamps have one-second resolution; preserve store order for ties so a reply
        // cannot move behind the message it answers.
        let timeline = items.enumerated()
            .sorted {
                $0.element.timestamp != $1.element.timestamp
                    ? $0.element.timestamp < $1.element.timestamp
                    : $0.offset < $1.offset
            }
            .map(\.element)
        var messagesByID: [String: NostrDirectMessage] = [:]
        messagesByID.reserveCapacity(messages.count * 2)
        for message in messages {
            messagesByID[message.rumorEventID] = message
            messagesByID[message.wrapEventID] = message
        }
        return MacChatPresentation(
            timeline: timeline,
            messagesByID: messagesByID,
            hermesSessionsByListingMessageID: hermesProjection.sessionsByListingMessageID
        )
    }
    var body: some View {
        let stacks = photoStacks
        let drawnItems = drawnTimeline(using: stacks)
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline)
                    Label("End-to-end encrypted", systemImage: "lock").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                TextField("Find in conversation", text: $search).textFieldStyle(.roundedBorder).frame(width: 200)
                Menu {
                    if model.groupConversation(id: peer) != nil {
                        Button("Group Details…") { groupDetails = true }
                        Button(model.isDirectMessageGroupMuted(peer) ? "Unmute Group" : "Mute Group") { model.setDirectMessageGroupMuted(peer, muted: !model.isDirectMessageGroupMuted(peer)) }
                        Button(model.hasLeftDirectMessageGroup(peer) ? "Rejoin Group" : "Leave Group") { model.setDirectMessageGroupLeft(peer, left: !model.hasLeftDirectMessageGroup(peer)) }
                    }
                    Button("Archive Conversation") { model.archiveDirectMessageThread(peerPublicKey: peer) }
                    Button("Delete Conversation…", role: .destructive) { deleting = true }
                } label: { Image(systemName: "ellipsis.circle") }
            }.padding(18)
            Divider()
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 14) {
                            if hasEarlierTimelineItems {
                                earlierTimelineLoader(proxy: proxy)
                            }
                            ForEach(drawnItems) { item in
                                MacChatTimelineRow(
                                    item: item,
                                    peer: peer,
                                    photoStack: {
                                        if case .message(let message) = item { return stacks.stacks[message.id] }
                                        return nil
                                    }(),
                                    sessionListing: {
                                        if case .message(let message) = item {
                                            return presentation.hermesSessionsByListingMessageID[message.id]
                                        }
                                        return nil
                                    }(),
                                    parent: { id in presentation.messagesByID[id] },
                                    reactions: { message in model.directMessageReactions(for: message) },
                                    reply: { composerProxy.reply(to: $0) },
                                    react: { target, emoji in
                                        Task {
                                            do {
                                                try await model.sendDirectMessageReaction(to: target, emoji: emoji)
                                            } catch {
                                                composerProxy.report(error.localizedDescription)
                                            }
                                        }
                                    },
                                    reportError: { composerProxy.report($0) }
                                ).id(item.id)
                            }
                        }
                        .padding(22)
                        .background {
                            GeometryReader { geometry in
                                let frame = geometry.frame(in: .named("mac-chat-scroll"))
                                Color.clear.preference(
                                    key: MacChatScrollMetricsKey.self,
                                    value: MacChatScrollMetrics(
                                        topOffset: frame.minY,
                                        contentHeight: frame.height
                                    )
                                )
                            }
                        }
                    }
                    .coordinateSpace(name: "mac-chat-scroll")
                    .onPreferenceChange(MacChatScrollMetricsKey.self) { metrics in
                        guard metrics.topOffset.isFinite, metrics.contentHeight > 0 else { return }
                        let distanceFromBottom = metrics.contentHeight + metrics.topOffset - viewport.size.height
                        // Preference changes arrive while AppKit is laying out; only write when the
                        // answer changes, so a growing composer cannot keep invalidating the graph.
                        let follows = distanceFromBottom <= 80
                        if follows != followsLatestMessage { followsLatestMessage = follows }
                        guard canLoadEarlierAtTop,
                              hasEarlierTimelineItems,
                              !isLoadingEarlierTimelineItems,
                              metrics.topOffset >= -24 else { return }
                        canLoadEarlierAtTop = false
                        loadEarlierTimelineItems(proxy: proxy)
                    }
                    .onAppear {
                        markRead()
                        revealNewestMessage(proxy: proxy, animated: false)
                    }
                    .onChange(of: timeline.count) { oldCount, newCount in
                        guard newCount > oldCount else { return }
                        loadedTimelineItemCount = min(
                            newCount,
                            loadedTimelineItemCount + (newCount - oldCount)
                        )
                    }
                    .onChange(of: timeline.last?.id) { _, _ in
                        markRead()
                        guard followsLatestMessage, !isSearchingConversation else { return }
                        revealNewestMessage(proxy: proxy, animated: true)
                    }
                    .onChange(of: search) { _, _ in
                        handleSearchChange(proxy: proxy)
                    }
                }
            }
            .background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
            Divider()
            MacChatComposer(peer: peer, composer: $composer, proxy: composerProxy)
                .padding(16)
        }
        .dropDestination(for: String.self) { values, _ in
            shareDroppedTasks(values)
        } isTargeted: { taskDropTargeted = $0 }
        .overlay {
            if taskDropTargeted || sharingDroppedTaskCount > 0 {
                VStack(spacing: 8) {
                    Image(systemName: sharingDroppedTaskCount > 0 ? "paperplane.fill" : "plus.bubble")
                        .font(.title2)
                        .foregroundStyle(Color.accentColor)
                    Text(sharingDroppedTaskCount > 0 ? "Sharing task…" : "Drop to share with \(title)")
                        .font(.headline)
                }
                .padding(.horizontal, 22)
                .padding(.vertical, 18)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
                .allowsHitTesting(false)
            }
        }
        .sheet(isPresented: $groupDetails) { MacGroupDetails(groupID: peer) }
        .confirmationDialog("Delete this conversation from this account's local history?", isPresented: $deleting) {
            Button("Delete Conversation", role: .destructive) { model.deleteDirectMessageThread(peerPublicKey: peer) }
            Button("Cancel", role: .cancel) {}
        }
        .task { await model.prepareDirectMessageRecipient(peer) }
        .onAppear {
            composerProxy.onSendStarted = { followsLatestMessage = true }
        }
        .onChange(of: activeState) { _, _ in markRead() }
        .onDisappear {
            timelineHistoryTask?.cancel()
            composerProxy.onSendStarted = nil
        }
    }
    private func markRead() { if activeState == .key { model.markDirectMessageThreadRead(peerPublicKey: peer) } }
    private func shareDroppedTasks(_ values: [String]) -> Bool {
        let taskIDs = Array(Set(values)).filter { model.task(withID: $0) != nil }
        guard !taskIDs.isEmpty,
              !model.isDirectMessagePeerBlocked(peer),
              !model.hasLeftDirectMessageGroup(peer) else { return false }
        taskDropTargeted = false
        sharingDroppedTaskCount = taskIDs.count
        Task { @MainActor in
            defer { sharingDroppedTaskCount = 0 }
            do {
                for taskID in taskIDs {
                    _ = try await model.sendSharedTask(
                        taskID: taskID,
                        recipientValue: peer,
                        assignment: false
                    )
                }
            } catch {
                composerProxy.report(error.localizedDescription)
            }
        }
        return true
    }
    private func revealNewestMessage(proxy: ScrollViewProxy, animated: Bool) {
        guard let newestID = drawnVisibleTimeline.last?.id else {
            followsLatestMessage = true
            return
        }
        followsLatestMessage = true
        Task { @MainActor in
            await Task.yield()
            if animated {
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(newestID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(newestID, anchor: .bottom)
            }
            // Lazy rows can revise their heights after the first pass; settle on the newest row.
            try? await Task.sleep(for: .milliseconds(50))
            proxy.scrollTo(newestID, anchor: .bottom)
            try? await Task.sleep(for: .milliseconds(150))
            proxy.scrollTo(newestID, anchor: .bottom)
            canLoadEarlierAtTop = true
        }
    }
    private func earlierTimelineLoader(proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 8) {
            if isLoadingEarlierTimelineItems { ProgressView().controlSize(.small) }
            Text(isLoadingEarlierTimelineItems ? "Loading earlier messages…" : "Scroll up for earlier messages")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 24)
        .accessibilityLabel("Earlier messages")
        .onAppear {
            guard canLoadEarlierAtTop, hasEarlierTimelineItems, !isLoadingEarlierTimelineItems else { return }
            canLoadEarlierAtTop = false
            loadEarlierTimelineItems(proxy: proxy)
        }
    }
    private func loadEarlierTimelineItems(proxy: ScrollViewProxy) {
        guard hasEarlierTimelineItems,
              !isLoadingEarlierTimelineItems,
              let previousOldestID = drawnVisibleTimeline.first?.id else { return }
        isLoadingEarlierTimelineItems = true
        timelineHistoryTask?.cancel()
        let nextCount = MacChatTimelineWindow.nextLoadedCount(
            current: loadedTimelineItemCount,
            totalCount: timeline.count
        )
        timelineHistoryTask = Task { @MainActor in
            await Task.yield()
            loadedTimelineItemCount = nextCount
            await Task.yield()
            guard !Task.isCancelled else { return }
            proxy.scrollTo(previousOldestID, anchor: .top)
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled else { return }
            proxy.scrollTo(previousOldestID, anchor: .top)
            isLoadingEarlierTimelineItems = false
            canLoadEarlierAtTop = true
            timelineHistoryTask = nil
        }
    }
    private func handleSearchChange(proxy: ScrollViewProxy) {
        if isSearchingConversation {
            Task { @MainActor in
                await Task.yield()
                guard let newestResultID = drawnVisibleTimeline.last?.id else {
                    lastSearchResultID = nil
                    return
                }
                lastSearchResultID = newestResultID
                followsLatestMessage = false
                proxy.scrollTo(newestResultID, anchor: .center)
            }
            return
        }

        if let lastSearchResultID,
           let index = timeline.firstIndex(where: { $0.id == lastSearchResultID }) {
            loadedTimelineItemCount = MacChatTimelineWindow.loadedCount(
                including: index,
                totalCount: timeline.count,
                minimum: loadedTimelineItemCount
            )
            Task { @MainActor in
                await Task.yield()
                proxy.scrollTo(lastSearchResultID, anchor: .center)
            }
        } else {
            revealNewestMessage(proxy: proxy, animated: false)
        }
        self.lastSearchResultID = nil
    }
}

/// A plain callback bridge keeps row actions out of the conversation's observed state. Replying
/// only updates the isolated composer instead of rebuilding the timeline.
@MainActor
final class MacChatComposerProxy {
    var onReply: ((NostrDirectMessage) -> Void)?
    var onError: ((String) -> Void)?
    var onSendStarted: (() -> Void)?

    func reply(to message: NostrDirectMessage) { onReply?(message) }
    func report(_ error: String) { onError?(error) }
}

/// Owns all high-frequency chat input state. The conversation above can stay cached while the
/// user types, stages attachments, records audio, or waits for a send to leave.
private struct MacChatComposer: View {
    let peer: String
    @Binding var composer: String
    let proxy: MacChatComposerProxy
    @Environment(AppModel.self) private var model
    @StateObject private var attachments = MacAttachmentQueue()
    @State private var audioRecorder = ChatAudioRecorder(
        directory: { try AttachmentFiles.directory() },
        onWillRecord: { MacChatAudioPlayback.shared.pauseForRecording() }
    )
    @State private var recordedAudio: ChatAudioRecorder.Recording?
    @State private var recordedAudioPlayer = ChatAudioDraftPlayer(
        onWillPlay: { MacChatAudioPlayback.shared.pauseForRecording() }
    )
    @State private var sending = false
    @State private var reply: NostrDirectMessage?
    @State private var error: String?
    @State private var isDropTargeted = false
    @State private var sendTask: Task<Void, Never>?

    private var isGroup: Bool { model.groupConversation(id: peer) != nil }
    private var isAudioComposerActive: Bool { audioRecorder.isRecording || recordedAudio != nil }
    private var visibleBotCommands: [BotCommand]? {
        guard !isGroup,
              composer.hasPrefix("/"),
              let commands = model.botCommands(publicKey: peer),
              !commands.isEmpty else { return nil }
        let query = String(composer.dropFirst()).lowercased()
        let matched = commands.filter { $0.name.hasPrefix(query) }
        return matched.isEmpty ? nil : matched
    }
    private var canSend: Bool {
        !sending && !attachments.importing &&
            (!composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.files.isEmpty) &&
            !model.isDirectMessagePeerBlocked(peer) && !model.hasLeftDirectMessageGroup(peer)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let reply {
                HStack {
                    Text("Replying to: \(reply.displayContent)").font(.caption).lineLimit(1)
                    Spacer()
                    Button("Cancel Reply") { self.reply = nil }
                }
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if let commands = visibleBotCommands {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(commands) { command in
                            Button { composer = "/\(command.name) " } label: {
                                HStack {
                                    Text("/\(command.name)")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Color.accentColor)
                                    Spacer(minLength: 8)
                                    Text(command.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 160)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }
            MacAttachmentQueueView(queue: attachments, busy: sending, onCancel: { sendTask?.cancel() })
            if isAudioComposerActive {
                audioComposer
            } else {
                HStack(alignment: .bottom, spacing: 12) {
                    Button { attachments.chooseFiles() } label: { Image(systemName: "paperclip") }
                        .disabled(sending || attachments.importing)
                    PasteButton(payloadType: MacAttachmentTransferPayload.self) { payloads in
                        attachments.stage(payloads.map(\.source))
                    }
                    .labelStyle(.iconOnly)
                    .disabled(sending || attachments.importing || model.isDirectMessagePeerBlocked(peer))
                    .help("Paste Files")
                    .accessibilityIdentifier("chat-attachment-paste-button")
                    ZStack(alignment: .topLeading) {
                        if composer.isEmpty {
                            Text("Message")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .padding(.top, 12)
                                .padding(.leading, 2)
                                .allowsHitTesting(false)
                        }
                        MacChatComposerTextView(
                            text: $composer,
                            onSubmit: { if canSend { send() } }
                        )
                    }
                    .overlay(alignment: .trailing) {
                        if composer.isEmpty, attachments.files.isEmpty {
                            Button(action: startAudioRecording) {
                                Image(systemName: "waveform")
                                    .font(.title3)
                                    .foregroundStyle(.secondary)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(
                                sending || attachments.importing || audioRecorder.isRequestingPermission
                                    || model.isDirectMessagePeerBlocked(peer)
                            )
                            .help("Record Audio Message")
                            .accessibilityLabel("Record audio message")
                            .accessibilityIdentifier("chat-audio-record-button")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(isDropTargeted ? Color.accentColor : .clear, lineWidth: 2)
                    )
                    Button(action: send) {
                        if sending {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Send", systemImage: "arrow.up")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                }
                .dropDestination(for: URL.self) { urls, _ in
                    guard !sending, !model.isDirectMessagePeerBlocked(peer) else { return false }
                    attachments.stage(urls)
                    return true
                } isTargeted: { isDropTargeted = $0 }
            }
        }
        .task(id: peer) {
            if !isGroup { await model.refreshBotCommands(publicKey: peer) }
        }
        .onAppear {
            proxy.onReply = { message in reply = message }
            proxy.onError = { message in error = message }
        }
        .onDisappear {
            proxy.onReply = nil
            proxy.onError = nil
            audioRecorder.cancel()
            discardRecordedAudio()
        }
    }

    private var audioComposer: some View {
        HStack(spacing: 10) {
            if recordedAudio != nil, !audioRecorder.isRecording {
                Button(action: discardRecordedAudio) {
                    Image(systemName: "xmark")
                        .frame(width: 30, height: 30)
                        .background(.quaternary.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(sending)
                .help("Discard Recording")
                .accessibilityLabel("Cancel audio message")
            }
            ChatAudioComposerControls(
                recorder: audioRecorder,
                recording: recordedAudio,
                player: recordedAudioPlayer,
                isBusy: sending,
                accent: .accentColor,
                onStop: stopAudioRecording,
                onContinue: {
                    guard let recordedAudio else { return }
                    recordedAudioPlayer.stop()
                    startAudioRecording(continuing: recordedAudio)
                },
                onSend: sendRecordedAudio
            )
            .frame(maxWidth: .infinity)
            .background(.quaternary.opacity(0.4), in: Capsule())
        }
    }

    private func startAudioRecording() { startAudioRecording(continuing: nil) }
    private func startAudioRecording(continuing previous: ChatAudioRecorder.Recording?) {
        Task {
            do { try await audioRecorder.start(continuing: previous) }
            catch is CancellationError {}
            catch { self.error = error.localizedDescription }
        }
    }
    private func stopAudioRecording() {
        Task {
            do { recordedAudio = try await audioRecorder.finish() }
            catch { self.error = error.localizedDescription }
        }
    }
    private func sendRecordedAudio() {
        guard let recording = recordedAudio, !sending else { return }
        recordedAudioPlayer.stop()
        recordedAudio = nil
        attachments.stagePrepared(MacStagedFile(
            url: recording.fileURL,
            name: recording.suggestedName,
            mimeType: "audio/mp4"
        ))
        if canSend { send() }
    }
    private func discardRecordedAudio() {
        audioRecorder.cancel()
        recordedAudioPlayer.stop()
        if let recordedAudio { try? FileManager.default.removeItem(at: recordedAudio.fileURL) }
        recordedAudio = nil
    }
    private func send() {
        let text = composer
        let replyTarget = reply
        let hasAttachments = !attachments.files.isEmpty
        proxy.onSendStarted?()
        sending = true
        error = nil
        // Make the action feel immediate even when relay discovery or proof of work takes time.
        // Restore the draft only if the send fails and the user has not typed something new.
        composer = ""
        reply = nil
        sendTask = Task {
            defer { sending = false; sendTask = nil }
            do {
                if hasAttachments {
                    let uploaded = try await attachments.uploadChat(
                        identity: model.cachedIdentity,
                        settingsDefaults: model.accountDefaults
                    )
                    attachments.progress = "Sending message…"
                    try await model.sendDirectMessageAttachments(
                        to: peer,
                        attachments: uploaded,
                        replyToEventID: replyTarget?.id,
                        comment: text
                    )
                    attachments.clear()
                } else {
                    try await model.sendDirectMessage(
                        to: peer,
                        content: text,
                        replyToEventID: replyTarget?.id
                    )
                }
            } catch is CancellationError {
                attachments.progress = nil
                restoreFailedDraft(text, reply: replyTarget, ifEmpty: composer.isEmpty && !text.isEmpty)
            } catch {
                self.error = error.localizedDescription
                restoreFailedDraft(text, reply: replyTarget, ifEmpty: composer.isEmpty && !text.isEmpty)
            }
        }
    }
    private func restoreFailedDraft(_ text: String, reply: NostrDirectMessage?, ifEmpty isEmpty: Bool) {
        guard isEmpty else { return }
        composer = text
        self.reply = reply
    }
}

private struct MacChatScrollMetrics: Equatable {
    let topOffset: CGFloat
    let contentHeight: CGFloat
}

private struct MacChatScrollMetricsKey: PreferenceKey {
    static var defaultValue = MacChatScrollMetrics(topOffset: 0, contentHeight: 0)

    static func reduce(value: inout MacChatScrollMetrics, nextValue: () -> MacChatScrollMetrics) {
        value = nextValue()
    }
}

private struct MacChatComposerTextView: NSViewRepresentable {
    @Binding var text: String
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> NSScrollView {
        let coordinator = context.coordinator
        let view = MacChatComposerField()
        view.delegate = coordinator
        view.font = NSFont.preferredFont(forTextStyle: .body)
        view.textColor = .labelColor
        view.drawsBackground = false
        view.focusRingType = .none
        view.isRichText = false
        view.allowsUndo = true
        view.importsGraphics = false
        view.textContainerInset = .zero
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.onSubmit = { [weak coordinator] in coordinator?.parent.onSubmit() }
        view.setAccessibilityIdentifier("chat-composer")

        let scrollView = NSScrollView()
        scrollView.documentView = view
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scrollView.documentView as? MacChatComposerField else { return }
        // No intrinsic-size invalidation here: update passes run inside SwiftUI's layout, and
        // marking the hosting view's subtree for another constraint update from there is what
        // makes the window abort once a long draft starts resizing the composer on every key.
        if view.string != text { view.string = text }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let view = nsView.documentView as? MacChatComposerField,
              let width = proposal.width, width.isFinite, width > 0
        else { return nil }
        return CGSize(width: width, height: Self.height(of: view, width: width))
    }

    /// Measures the draft without laying out the live text view. Forcing TextKit layout
    /// (`ensureLayout`/`usedRect`) on a descendant of the hosting view from inside SwiftUI's
    /// measurement re-enters AppKit's layout pass; a long draft can keep re-invalidating the
    /// window until it aborts. A plain text measurement has no side effects.
    private static func height(of view: MacChatComposerField, width: CGFloat) -> CGFloat {
        let font = view.font ?? NSFont.preferredFont(forTextStyle: .body)
        let padding = view.textContainer?.lineFragmentPadding ?? 0
        let available = max(1, width - padding * 2)
        let bounds = (view.string as NSString).boundingRect(
            with: CGSize(width: available, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        )
        return MacChatComposerMetrics.height(
            contentHeight: bounds.height,
            lineHeight: font.ascender - font.descender + font.leading
        )
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacChatComposerTextView

        init(parent: MacChatComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? MacChatComposerField else { return }
            parent.text = view.string
        }
    }
}

final class MacChatComposerField: NSTextView {
    var onSubmit: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        switch MacChatComposerKeyCommand.command(
            keyCode: event.keyCode,
            shift: event.modifierFlags.contains(.shift)
        ) {
        case .send:
            onSubmit?()
        case .newline:
            insertNewline(nil)
            scrollRangeToVisible(selectedRange())
        case .passThrough:
            super.keyDown(with: event)
        }
    }
}

/// A conversation's timeline mixes plain messages with shared tasks/contacts/events/boards
/// delivered to the same peer — see `MacConversation.timeline` for how these are merged and
/// de-duplicated against the raw message history, mirroring iOS's `ChatTimelineItem`.
private enum MacChatTimelineItem: Identifiable {
    case message(NostrDirectMessage)
    case sharedTask(SharedInboxItem)
    case sharedContact(SharedContactInboxItem)
    case calendarInvite(SharedCalendarInviteInboxItem)
    case sharedBoard(SharedBoardInboxItem)

    var id: String {
        switch self {
        case .message(let item): "message-\(item.id)"
        case .sharedTask(let item): "shared-task-\(item.id)"
        case .sharedContact(let item): "shared-contact-\(item.id)"
        case .calendarInvite(let item): "calendar-invite-\(item.id)"
        case .sharedBoard(let item): "shared-board-\(item.id)"
        }
    }
    var timestamp: TimeInterval {
        switch self {
        case .message(let item): Double(item.createdAt)
        case .sharedTask(let item): item.receivedAt.timeIntervalSince1970
        case .sharedContact(let item): item.receivedAt.timeIntervalSince1970
        case .calendarInvite(let item): item.receivedAt.timeIntervalSince1970
        case .sharedBoard(let item): item.receivedAt.timeIntervalSince1970
        }
    }
    func matchesSearch(_ query: String) -> Bool {
        switch self {
        case .message(let item): item.displayContent.localizedCaseInsensitiveContains(query)
        case .sharedTask(let item): item.task.title.localizedCaseInsensitiveContains(query)
        case .sharedContact(let item):
            (item.contact.displayName ?? item.contact.name ?? item.contact.npub).localizedCaseInsensitiveContains(query)
        case .calendarInvite(let item): (item.event.title ?? "").localizedCaseInsensitiveContains(query)
        case .sharedBoard(let item): (item.board.boardName ?? "").localizedCaseInsensitiveContains(query)
        }
    }
}

private struct MacChatTimelineRow: View {
    let item: MacChatTimelineItem
    let peer: String
    var photoStack: [NostrDirectMessage]? = nil
    var sessionListing: HermesSessionListing? = nil
    var parent: (String) -> NostrDirectMessage?
    var reactions: (NostrDirectMessage) -> [NostrDirectMessageReaction]
    var reply: (NostrDirectMessage) -> Void
    var react: (NostrDirectMessage, String) -> Void
    var reportError: (String) -> Void

    var body: some View {
        switch item {
        case .message(let message):
            if let sessionListing {
                HStack(alignment: .top, spacing: 0) {
                    MacHermesSessionPicker(peerPublicKey: peer, listing: sessionListing)
                    Spacer(minLength: 60)
                }
            } else {
                MacMessageRow(
                    message: message,
                    parent: message.replyToEventID.flatMap(parent),
                    reactions: (photoStack ?? [message]).flatMap(reactions),
                    photoStack: photoStack,
                    reply: reply,
                    react: react,
                    reportError: reportError
                )
            }
        case .sharedTask(let task):
            aligned(incoming: true) { MacSharedTaskCard(item: task) }
        case .sharedContact(let contact):
            aligned(incoming: contact.isIncoming) { MacSharedContactCard(item: contact) }
        case .calendarInvite(let invite):
            aligned(incoming: true) { MacCalendarInviteCard(item: invite) }
        case .sharedBoard(let board):
            aligned(incoming: true) { MacSharedBoardCard(item: board) }
        }
    }

    private func aligned<Content: View>(incoming: Bool, @ViewBuilder card: () -> Content) -> some View {
        HStack {
            if !incoming { Spacer(minLength: 60) }
            card()
            if incoming { Spacer(minLength: 60) }
        }
    }
}

/// Hermes reports `/sessions` as text. Once a verified bot listing is recognized, replace that
/// text with tappable sessions; choosing one sends the validated `/resume <id>` command.
private struct MacHermesSessionPicker: View {
    @Environment(AppModel.self) private var model
    let peerPublicKey: String
    let listing: HermesSessionListing
    @State private var resumingSessionID: String?
    @State private var sentSessionID: String?
    @State private var actionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                Image(systemName: "rectangle.stack")
                    .font(.subheadline)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 29, height: 29)
                    .background(Color.accentColor.opacity(0.13), in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text("Named sessions").font(.subheadline.bold())
                    Text("Choose a session to resume")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Text("\(listing.sessions.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(listing.sessions, id: \.sessionId) { session in
                        sessionButton(session)
                    }
                }
            }
            .frame(height: min(CGFloat(listing.sessions.count) * 54, 432))

            if let actionError {
                Text(actionError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 9))
            }
        }
        .padding(12)
        .frame(maxWidth: 540, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 15))
        .overlay {
            RoundedRectangle(cornerRadius: 15)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        }
    }

    private func sessionButton(_ session: HermesSession) -> some View {
        Button {
            resume(session)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(session.sessionId)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 4)
                if resumingSessionID == session.sessionId {
                    ProgressView().controlSize(.small)
                } else if sentSessionID == session.sessionId {
                    Label("Sent", systemImage: "checkmark")
                        .font(.caption2)
                        .foregroundStyle(.green)
                } else if session.isCurrent {
                    Text("Current").font(.caption2).foregroundStyle(.secondary)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            session.isCurrent ? Color.accentColor.opacity(0.10) : Color(nsColor: .underPageBackgroundColor),
            in: RoundedRectangle(cornerRadius: 9)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 9)
                .stroke(
                    session.isCurrent ? Color.accentColor.opacity(0.4) : Color.primary.opacity(0.08),
                    lineWidth: 1
                )
        }
        .disabled(resumingSessionID != nil)
        .opacity(resumingSessionID == nil || resumingSessionID == session.sessionId ? 1 : 0.46)
        .accessibilityLabel("Resume session: \(session.title)")
        .accessibilityValue(session.isCurrent ? "Current" : "")
    }

    private func resume(_ session: HermesSession) {
        guard resumingSessionID == nil else { return }
        resumingSessionID = session.sessionId
        sentSessionID = nil
        actionError = nil
        Task { @MainActor in
            defer { resumingSessionID = nil }
            do {
                try await model.sendDirectMessage(
                    to: peerPublicKey,
                    content: HermesSessionMenuParser.resumeCommand(sessionId: session.sessionId)
                )
                sentSessionID = session.sessionId
            } catch {
                actionError = error.localizedDescription
            }
        }
    }
}

private struct MacSharedTaskCard: View {
    let item: SharedInboxItem
    @Environment(AppModel.self) private var model
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(item.task.assignment == true ? "ASSIGNMENT" : "SHARED TASK", systemImage: "checklist")
                .font(.system(size: 10, weight: .bold)).foregroundStyle(Color.accentColor)
            Text(item.task.title).font(.headline)
            if let note = item.task.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(4)
            }
            if let subtasks = item.task.subtasks, !subtasks.isEmpty {
                Label("\(subtasks.filter(\.completed).count)/\(subtasks.count)", systemImage: "checklist").font(.caption2).foregroundStyle(.secondary)
            }
            if item.status == .pending {
                HStack {
                    Button("Accept") { _ = model.respondToSharedInboxItem(item.id, status: .accepted) }
                    Button("Tentative") { _ = model.respondToSharedInboxItem(item.id, status: .tentative) }
                    Button("Decline") { _ = model.respondToSharedInboxItem(item.id, status: .declined) }
                }.controlSize(.small)
            } else {
                Text(item.status.rawValue.capitalized).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }.padding(12).frame(maxWidth: 300, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct MacSharedContactCard: View {
    let item: SharedContactInboxItem
    @Environment(AppModel.self) private var model
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("SHARED CONTACT", systemImage: "person.crop.circle").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.accentColor)
            Text(item.contact.displayName.trimmedOrNil ?? item.contact.name.trimmedOrNil ?? item.contact.npub).font(.headline)
            if let about = item.contact.about.trimmedOrNil { Text(about).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
            if item.isIncoming {
                if item.status == .pending {
                    HStack {
                        Button("Save Contact") { Task { do { try await model.acceptSharedContactInboxItem(item.id) } catch { model.errorMessage = error.localizedDescription } } }
                        Button("Dismiss") { model.dismissSharedContactInboxItem(item.id) }
                    }.controlSize(.small)
                } else {
                    Text(item.status.rawValue.capitalized).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
        }.padding(12).frame(maxWidth: 300, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct MacCalendarInviteCard: View {
    let item: SharedCalendarInviteInboxItem
    @Environment(AppModel.self) private var model
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("SHARED EVENT", systemImage: "calendar").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.accentColor)
            Text(item.event.title ?? "Calendar invitation").font(.headline)
            if let start = formattedISO(item.event.start) { Text(start).font(.caption).foregroundStyle(.secondary) }
            if item.status == .pending {
                HStack {
                    ForEach([SharedInboxItemStatus.accepted, .tentative, .declined], id: \.rawValue) { status in
                        Button(status.rawValue.capitalized) {
                            Task { do { try await model.respondToSharedCalendarInvite(item.id, status: status) } catch { self.error = error.localizedDescription } }
                        }
                    }
                }.controlSize(.small)
            } else {
                Text(item.status.rawValue.capitalized).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption2).foregroundStyle(.red) }
        }.padding(12).frame(maxWidth: 300, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct MacSharedBoardCard: View {
    let item: SharedBoardInboxItem
    @Environment(AppModel.self) private var model
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("SHARED BOARD", systemImage: "square.grid.2x2").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.accentColor)
            Text(item.board.boardName ?? "Shared board").font(.headline)
            if item.status == .pending {
                HStack {
                    Button("Join") { _ = model.acceptSharedBoardInboxItem(item.id) }
                    Button("Dismiss") { model.dismissSharedBoardInboxItem(item.id) }
                }.controlSize(.small)
            } else {
                Text(item.status.rawValue.capitalized).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }.padding(12).frame(maxWidth: 300, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// One message row, its own view so the conversation's `ForEach` stays a simple expression —
/// folding this much conditional content (attachment/payment/shared-item/link variants) directly
/// into the `ForEach` closure overwhelmed the type checker.
private struct MacMessageRow: View {
    let message: NostrDirectMessage
    let parent: NostrDirectMessage?
    let reactions: [NostrDirectMessageReaction]
    /// The sender's consecutive photos this message stands for, oldest first, when it hosts a
    /// photo stack.
    var photoStack: [NostrDirectMessage]? = nil
    var reply: (NostrDirectMessage) -> Void
    var react: (NostrDirectMessage, String) -> Void
    var reportError: (String) -> Void
    private var envelope: TaskifyShareEnvelope? { TaskifyShareEnvelope.decode(content: message.content) }
    private var paymentToken: String? {
        guard message.isIncoming, message.attachment == nil else { return nil }
        return CashuTokenText.firstTokenSubstring(in: message.content)
    }
    private var attachments: [NostrDirectMessageAttachment] { (photoStack ?? [message]).compactMap(\.attachment) }
    /// A stack reports its least-delivered photo.
    private var deliveryState: NostrDirectMessageDeliveryState? {
        let states = (photoStack ?? [message]).compactMap(\.deliveryState)
        if states.contains(.failed) { return .failed }
        if states.contains(.queued) { return .queued }
        return states.isEmpty ? nil : .sent
    }

    var body: some View {
        HStack {
            if !message.isIncoming { Spacer(minLength: 60) }
            if message.attachment != nil {
                // Attachments carry their own shape, so no message bubble around them.
                VStack(alignment: message.isIncoming ? .leading : .trailing, spacing: 5) {
                    replyContext
                    HStack(alignment: .center, spacing: 10) {
                        attachmentContent
                        if message.isIncoming, attachments.allSatisfy(\.isImage) {
                            MacChatPhotoSaveButton(attachments: attachments, reportError: reportError)
                        }
                    }
                    metadata
                }
                .contextMenu {
                    messageActions
                    Divider()
                    MacChatAttachmentMenu(attachments: attachments, reportError: reportError)
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    replyContext
                    content
                    metadata
                }.padding(12)
                    .background(message.isIncoming ? Color(nsColor: .controlBackgroundColor) : Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                    .contextMenu {
                        messageActions
                        Button("Copy") { macCopy(message.content) }
                    }
            }
            if message.isIncoming { Spacer(minLength: 60) }
        }
    }

    @ViewBuilder private var replyContext: some View {
        if let parent {
            Text(parent.displayContent).font(.caption).lineLimit(2).foregroundStyle(.secondary).padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor).frame(width: 2) }
        }
    }

    @ViewBuilder private var metadata: some View {
        HStack {
            Text(Date(timeIntervalSince1970: Double(message.createdAt)).formatted(date: .omitted, time: .shortened))
            if !message.isIncoming { Text(deliveryState.map { String(describing: $0).capitalized } ?? "Queued") }
        }.font(.caption2).foregroundStyle(.secondary)
        if !reactions.isEmpty { Text(reactions.map(\.emoji).joined(separator: " ")).font(.caption) }
    }

    @ViewBuilder private var messageActions: some View {
        Button("Reply") { reply(message) }
        ForEach(["❤️", "👍", "✅", "😂"], id: \.self) { emoji in
            Button(emoji) { react(message, emoji) }
        }
    }

    @ViewBuilder private var attachmentContent: some View {
        if let photoStack, photoStack.count > 1 {
            MacChatPhotoStack(attachments: attachments, reportError: reportError)
        } else if let attachment = message.attachment {
            if attachment.isImage {
                MacChatPhotoBubble(attachment: attachment, reportError: reportError)
            } else if attachment.isAudio {
                MacChatAudioAttachment(attachment: attachment)
            } else {
                MacChatFileRow(attachment: attachment, reportError: reportError)
            }
        }
    }

    @ViewBuilder private var content: some View {
        if case .assignmentResponse(let response) = envelope?.item {
            Label("Assignment \(response.status.rawValue)", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
        } else if envelope != nil {
            // A shared task/contact/event/board rumor: its card is rendered as its own,
            // correlated timeline item (see MacChatTimelineItem) — skip the raw envelope here so
            // it doesn't render twice.
            EmptyView()
        } else if let paymentToken {
            MacPaymentTokenCard(token: paymentToken)
        } else {
            MacChatMarkdownText(markdown: message.displayContent)
            ForEach(TaskContentLinks.allURLs(in: message.content), id: \.absoluteString) { url in
                MacLinkCard(url: url)
            }
        }
    }
}

/// Chat Markdown with the same click-to-copy code affordance as iPhone and the PWA. The shared
/// parser keeps headings, lists, quotes and fenced blocks consistent with the other native apps;
/// ordinary links still open normally, while its private inline-code links are handled locally.
private struct MacChatMarkdownText: View {
    private let document: NostrChatMarkdownDocument
    @State private var copiedCode: String?

    init(markdown: String) {
        document = NostrChatMarkdown.document(markdown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                blockView(block)
                    .padding(.top, topPadding(for: block, at: index))
            }
        }
        .textSelection(.enabled)
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
            inlineText(content, font: .body)
        case let .heading(level, content):
            inlineText(content, font: headingFont(level: level))
        case let .unorderedListItem(depth, content):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("•")
                    .font(.body.weight(.bold))
                    .frame(width: 12, alignment: .trailing)
                inlineText(content, font: .body)
            }
            .padding(.leading, CGFloat(depth) * 15)
        case let .orderedListItem(depth, number, content):
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("\(number).")
                    .font(.callout.weight(.semibold))
                    .frame(minWidth: 18, alignment: .trailing)
                inlineText(content, font: .body)
            }
            .padding(.leading, CGFloat(depth) * 15)
        case let .blockQuote(depth, content):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.primary.opacity(0.38))
                    .frame(width: 3)
                inlineText(content, font: .body.italic())
                    .foregroundStyle(Color.primary.opacity(0.88))
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 12)
        case let .codeBlock(language, content):
            VStack(alignment: .leading, spacing: 5) {
                if let language {
                    Text(language.uppercased())
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.primary.opacity(0.62))
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(content)
                        .font(.system(size: 13, design: .monospaced))
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
                .fill(Color.primary.opacity(0.24))
                .frame(minWidth: 120, maxWidth: .infinity, minHeight: 1, maxHeight: 1)
        }
    }

    private func inlineText(_ markdown: String, font: Font) -> some View {
        Text(styledInlineMarkdown(markdown))
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func styledInlineMarkdown(_ markdown: String) -> AttributedString {
        var attributed = NostrChatMarkdown.inlineAttributedString(markdown)
        let runs = attributed.runs.map { run in
            (range: run.range, intent: run.inlinePresentationIntent, link: run.link)
        }
        for run in runs {
            if run.intent?.contains(.code) == true {
                let code = String(attributed[run.range].characters)
                attributed[run.range].font = .system(
                    size: 13,
                    weight: .medium,
                    design: .monospaced
                )
                attributed[run.range].foregroundColor = .labelColor
                attributed[run.range].backgroundColor = .quaternaryLabelColor
                attributed[run.range].link = NostrChatMarkdown.copyURL(for: code)
                continue
            }
            if let link = run.link, !isSafeExternalLink(link) {
                attributed[run.range].link = nil
            }
        }
        return attributed
    }

    private var codeBackground: Color {
        Color.primary.opacity(0.08)
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        case 3: .headline
        default: .body.weight(.semibold)
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
        macCopy(code)
        withAnimation(.spring(response: 0.22, dampingFraction: 0.8)) {
            copiedCode = code
        }
    }
}

/// A Cashu token sent as plain chat text. The Mac app has no wallet, so it is never redeemed
/// here: the card copies the token for the user to redeem in another Cashu wallet.
private struct MacPaymentTokenCard: View {
    let token: String
    @State private var copied = false
    var body: some View {
        Button {
            macCopySecret(token)
            copied = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "bitcoinsign.circle.fill").font(.subheadline.bold()).foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32).background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Cashu token received").font(.caption.weight(.semibold))
                    Text(copied ? "Copied — paste it into another Cashu wallet" : "Not redeemed").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Label(copied ? "Copied" : "Copy Token", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption2.bold()).foregroundStyle(Color.accentColor)
            }.padding(8).frame(maxWidth: 270, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(2.5))
                copied = false
            }
    }
}

private struct MacLinkCard: View {
    let url: URL
    @Environment(\.openURL) private var openURL
    private var host: String { url.host(percentEncoded: false)?.replacingOccurrences(of: "www.", with: "") ?? url.absoluteString }
    var body: some View {
        Button { openURL(url) } label: {
            HStack(spacing: 10) {
                Image(systemName: "link").font(.subheadline.bold()).foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32).background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(TaskContentLinks.fallbackTitle(for: url)).font(.caption.weight(.semibold)).lineLimit(2)
                    Text(host).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.caption2.bold()).foregroundStyle(.secondary)
            }.padding(8).frame(maxWidth: 270, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }
}

private struct MacNewConversation: View {
    var select: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipient = ""
    @State private var name = ""
    @State private var group = false
    @State private var members = Set<String>()
    @State private var saveContact = false
    @State private var error: String?
    @State private var working = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("New Conversation").font(.title2.bold())
            Toggle("Group Conversation", isOn: $group)
            TextField(group ? "Group name" : "Contact name (optional)", text: $name)
            if group {
                List(model.nostrContacts) { contact in
                    Toggle(contact.displayName, isOn: Binding(get: { members.contains(contact.publicKey) }, set: { if $0 { members.insert(contact.publicKey) } else { members.remove(contact.publicKey) } }))
                }
            } else {
                TextField("npub or public key", text: $recipient)
                Toggle("Save to contacts", isOn: $saveContact)
                List(model.nostrContacts) { contact in
                    Button(contact.displayName) { select(contact.publicKey); dismiss() }.buttonStyle(.plain)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Open Conversation") {
                    working = true
                    Task {
                        defer { working = false }
                        do {
                            if group { select(try model.createGroupConversation(name: name, memberPublicKeys: members.sorted())) }
                            else {
                                guard let key = NostrPublicKey.parse(recipient) else { throw NostrDirectMessageError.invalidRecipient }
                                if saveContact { _ = try await model.saveNostrContact(publicKeyValue: recipient, petname: name.isEmpty ? nil : name, relayURL: nil) }
                                select(key.hexString)
                            }
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent).disabled(working)
            }
        }.padding(24).frame(width: 480, height: 500)
    }
}

private struct MacGroupDetails: View {
    let groupID: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var error: String?
    @State private var saving = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Group Details").font(.title2.bold())
            TextField("Group name", text: $name)
            List(model.groupConversation(id: groupID)?.memberPublicKeys ?? [], id: \.self) { key in
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.nostrContact(publicKey: key)?.displayName ?? (key == model.identityPublicKey ? "You" : String(key.prefix(16))))
                    Text(key).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.disabled(saving)
                Spacer()
                Button("Save Name") {
                    saving = true
                    Task {
                        defer { saving = false }
                        do { _ = try await model.renameGroupConversation(groupID: groupID, name: name); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 500, height: 430).onAppear { name = model.groupConversation(id: groupID)?.name ?? "" }
            .interactiveDismissDisabled(saving)
    }
}
