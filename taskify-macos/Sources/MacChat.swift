import SwiftUI
import TaskifyCore

struct MacChatView: View {
    let search: String
    @Binding var drafts: [String: String]
    @Binding var scrollPositions: [String: String]
    @Binding var selection: String?
    @Environment(AppModel.self) private var model
    @State private var showNew = false
    @State private var showArchived = false
    @State private var showContacts = false
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
                            .contextMenu {
                                Button(showArchived ? "Unarchive" : "Archive") {
                                    if showArchived { model.unarchiveDirectMessageThread(peerPublicKey: peer) }
                                    else { model.archiveDirectMessageThread(peerPublicKey: peer) }
                                }
                                Button(model.isDirectMessagePeerBlocked(peer) ? "Unblock" : "Block") {
                                    model.setDirectMessagePeerBlocked(peer, blocked: !model.isDirectMessagePeerBlocked(peer))
                                }
                            }
                    }
                }.listStyle(.sidebar)
            }.frame(minWidth: 230, idealWidth: 280, maxWidth: 340)
            if let selection {
                MacConversation(peer: selection, title: name(selection),
                    composer: Binding(get: { drafts[selection, default: ""] }, set: { drafts[selection] = $0 }),
                    scrollAnchor: Binding(get: { scrollPositions[selection] }, set: { scrollPositions[selection] = $0 }))
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
}

private struct MacConversation: View {
    let peer: String
    let title: String
    @Binding var composer: String
    @Binding var scrollAnchor: String?
    @Environment(AppModel.self) private var model
    @Environment(\.controlActiveState) private var activeState
    @StateObject private var attachments = MacAttachmentQueue()
    @State private var sending = false
    @State private var deleting = false
    @State private var groupDetails = false
    @State private var reply: NostrDirectMessage?
    @State private var error: String?
    @State private var search = ""
    @State private var isDropTargeted = false
    @State private var sendTask: Task<Void, Never>?
    private var messages: [NostrDirectMessage] { model.directMessages(with: peer) }
    private var isGroup: Bool { model.groupConversation(id: peer) != nil }
    private var visibleBotCommands: [BotCommand]? {
        guard !isGroup, composer.hasPrefix("/"), let commands = model.botCommands(publicKey: peer), !commands.isEmpty else { return nil }
        let query = String(composer.dropFirst()).lowercased()
        let matched = commands.filter { $0.name.hasPrefix(query) }
        return matched.isEmpty ? nil : matched
    }

    // Shared items delivered to this conversation, correlated the same way the Inbox tab
    // correlates them — filtered here by peer instead of by pending status, so a responded-to
    // item still shows (with its resulting status) where it was actually shared.
    private var sharedTaskItems: [SharedInboxItem] {
        model.sharedInboxItems.filter { $0.status != .deleted && $0.conversationPublicKey.caseInsensitiveCompare(peer) == .orderedSame }
    }
    private var sharedContactItems: [SharedContactInboxItem] {
        model.sharedContactInboxItems.filter { $0.status != .deleted && $0.conversationPublicKey.caseInsensitiveCompare(peer) == .orderedSame }
    }
    private var calendarInviteItems: [SharedCalendarInviteInboxItem] {
        model.sharedCalendarInviteItems.filter { $0.status != .deleted && $0.conversationPublicKey.caseInsensitiveCompare(peer) == .orderedSame }
    }
    private var sharedBoardItems: [SharedBoardInboxItem] {
        model.sharedBoardInboxItems.filter { $0.status != .deleted && $0.sender.publicKey.caseInsensitiveCompare(peer) == .orderedSame }
    }
    /// Merges plain messages with correlated shared items, matching iOS's `ChatTimelineItem`
    /// construction exactly: a message whose rumor became a shared task or calendar invite is
    /// excluded (the correlated card replaces it), while shared contacts/boards are added
    /// alongside their message since those aren't excluded from the raw history.
    private var timeline: [MacChatTimelineItem] {
        let tasks = sharedTaskItems
        let invites = calendarInviteItems
        let structuredRumorIDs = Set(tasks.map(\.rumorEventID) + invites.map(\.rumorEventID))
        let items: [MacChatTimelineItem] =
            messages.filter { !structuredRumorIDs.contains($0.rumorEventID) }.map(MacChatTimelineItem.message)
                + tasks.map(MacChatTimelineItem.sharedTask)
                + sharedContactItems.map(MacChatTimelineItem.sharedContact)
                + invites.map(MacChatTimelineItem.calendarInvite)
                + sharedBoardItems.map(MacChatTimelineItem.sharedBoard)
        // Nostr timestamps have one-second resolution; break ties by original array order
        // (messages first, in their existing order) rather than by id, which would be effectively
        // random and could shuffle a reply in front of the message it replies to.
        return items.enumerated()
            .sorted { $0.element.timestamp != $1.element.timestamp ? $0.element.timestamp < $1.element.timestamp : $0.offset < $1.offset }
            .map(\.element)
    }
    private var visibleTimeline: [MacChatTimelineItem] {
        guard !search.isEmpty else { return timeline }
        return timeline.filter { $0.matchesSearch(search) }
    }
    var body: some View {
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
            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(visibleTimeline) { item in
                        MacChatTimelineRow(
                            item: item,
                            parent: { id in messages.first { $0.id == id } },
                            reactions: { message in model.directMessageReactions(for: message) },
                            reply: { reply = $0 },
                            react: { target, emoji in
                                Task { do { try await model.sendDirectMessageReaction(to: target, emoji: emoji) } catch { self.error = error.localizedDescription } }
                            },
                            reportError: { error = $0 }
                        ).id(item.id)
                    }
                    }.padding(22)
                }.background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
                    .scrollPosition(id: $scrollAnchor)
                    .onAppear {
                        if scrollAnchor == nil || !timeline.contains(where: { $0.id == scrollAnchor }) { scrollAnchor = timeline.last?.id }
                        markRead()
                    }
                    .onChange(of: timeline.last?.id) { _, id in
                        scrollAnchor = id
                        markRead()
                    }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                if let reply {
                    HStack { Text("Replying to: \(reply.displayContent)").font(.caption).lineLimit(1); Spacer(); Button("Cancel Reply") { self.reply = nil } }
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                if let commands = visibleBotCommands {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(commands) { command in
                                Button { composer = "/\(command.name) " } label: {
                                    HStack {
                                        Text("/\(command.name)").font(.subheadline.weight(.semibold)).foregroundStyle(Color.accentColor)
                                        Spacer(minLength: 8)
                                        Text(command.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }.padding(.horizontal, 10).padding(.vertical, 7).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }
                    }.frame(maxHeight: 160).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                }
                MacAttachmentQueueView(queue: attachments, busy: sending, onCancel: { sendTask?.cancel() })
                HStack(alignment: .bottom, spacing: 12) {
                    Button { attachments.chooseFiles() } label: { Image(systemName: "paperclip") }.disabled(sending || attachments.importing)
                    PasteButton(payloadType: URL.self) { urls in attachments.stage(urls) }
                        .labelStyle(.iconOnly).disabled(sending || attachments.importing || model.isDirectMessagePeerBlocked(peer))
                        .help("Paste Files")
                    TextField("Message", text: $composer, axis: .vertical).lineLimit(2...8).textFieldStyle(.plain)
                        .padding(10).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(isDropTargeted ? Color.accentColor : .clear, lineWidth: 2))
                    Button(action: send) { if sending { ProgressView().controlSize(.small) } else { Label("Send", systemImage: "arrow.up") } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(sending || attachments.importing || (composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.files.isEmpty) || model.isDirectMessagePeerBlocked(peer) || model.hasLeftDirectMessageGroup(peer))
                }
                .dropDestination(for: URL.self) { urls, _ in
                    guard !sending, !model.isDirectMessagePeerBlocked(peer) else { return false }
                    attachments.stage(urls)
                    return true
                } isTargeted: { isDropTargeted = $0 }
            }.padding(16)
        }
        .sheet(isPresented: $groupDetails) { MacGroupDetails(groupID: peer) }
        .confirmationDialog("Delete this conversation from this account's local history?", isPresented: $deleting) {
            Button("Delete Conversation", role: .destructive) { model.deleteDirectMessageThread(peerPublicKey: peer) }
            Button("Cancel", role: .cancel) {}
        }
        .task { await model.prepareDirectMessageRecipient(peer) }
        .task(id: peer) { if !isGroup { await model.refreshBotCommands(publicKey: peer) } }
        .onChange(of: activeState) { _, _ in markRead() }
    }
    private func markRead() { if activeState == .key { model.markDirectMessageThreadRead(peerPublicKey: peer) } }
    private func send() {
        let text = composer
        sending = true; error = nil
        sendTask = Task {
            defer { sending = false; sendTask = nil }
            do {
                if attachments.files.isEmpty {
                    try await model.sendDirectMessage(to: peer, content: text, replyToEventID: reply?.id)
                } else {
                    let uploaded = try await attachments.uploadChat()
                    attachments.progress = "Sending message…"
                    try await model.sendDirectMessageAttachments(to: peer, attachments: uploaded, replyToEventID: reply?.id, comment: text)
                    attachments.clear()
                }
                if composer == text { composer = "" }
                reply = nil
            } catch is CancellationError {
                attachments.progress = nil
            } catch { self.error = error.localizedDescription }
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
    var parent: (String) -> NostrDirectMessage?
    var reactions: (NostrDirectMessage) -> [NostrDirectMessageReaction]
    var reply: (NostrDirectMessage) -> Void
    var react: (NostrDirectMessage, String) -> Void
    var reportError: (String) -> Void

    var body: some View {
        switch item {
        case .message(let message):
            MacMessageRow(
                message: message,
                parent: message.replyToEventID.flatMap(parent),
                reactions: reactions(message),
                reply: reply,
                react: react,
                reportError: reportError
            )
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
    var reply: (NostrDirectMessage) -> Void
    var react: (NostrDirectMessage, String) -> Void
    var reportError: (String) -> Void
    @State private var redeemingToken: String?
    private var envelope: TaskifyShareEnvelope? { TaskifyShareEnvelope.decode(content: message.content) }
    private var paymentToken: String? {
        guard message.isIncoming, message.attachment == nil else { return nil }
        return CashuPaymentRequestContract.firstTokenSubstring(in: message.content)
    }

    var body: some View {
        HStack {
            if !message.isIncoming { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 5) {
                if let parent {
                    Text(parent.displayContent).font(.caption).lineLimit(2).foregroundStyle(.secondary).padding(.leading, 8)
                        .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor).frame(width: 2) }
                }
                content
                HStack {
                    Text(Date(timeIntervalSince1970: Double(message.createdAt)).formatted(date: .omitted, time: .shortened))
                    if !message.isIncoming { Text(message.deliveryState.map { String(describing: $0).capitalized } ?? "Queued") }
                }.font(.caption2).foregroundStyle(.secondary)
                if !reactions.isEmpty { Text(reactions.map(\.emoji).joined(separator: " ")).font(.caption) }
            }.padding(12)
                .background(message.isIncoming ? Color(nsColor: .controlBackgroundColor) : Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                .contextMenu {
                    Button("Reply") { reply(message) }
                    Button("Copy") { macCopy(message.content) }
                    ForEach(["❤️", "👍", "✅", "😂"], id: \.self) { emoji in
                        Button(emoji) { react(message, emoji) }
                    }
                }
            if message.isIncoming { Spacer(minLength: 60) }
        }
        .sheet(isPresented: Binding(get: { redeemingToken != nil }, set: { if !$0 { redeemingToken = nil } })) {
            MacQuickRedeemSheet(token: redeemingToken ?? "")
        }
    }

    @ViewBuilder private var content: some View {
        if let attachment = message.attachment {
            if attachment.mimeType.hasPrefix("image/") {
                MacChatImageAttachment(attachment: attachment)
            } else {
                Button("Save Attachment…") { Task { do { try await MacAttachmentExport.chat(attachment) } catch { reportError(error.localizedDescription) } } }
            }
        } else if case .assignmentResponse(let response) = envelope?.item {
            Label("Assignment \(response.status.rawValue)", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
        } else if envelope != nil {
            // A shared task/contact/event/board rumor: its card is rendered as its own,
            // correlated timeline item (see MacChatTimelineItem) — skip the raw envelope here so
            // it doesn't render twice.
            EmptyView()
        } else if let paymentToken {
            MacPaymentTokenCard(token: paymentToken) { redeemingToken = paymentToken }
        } else {
            Text(.init(message.displayContent)).textSelection(.enabled)
            ForEach(TaskContentLinks.allURLs(in: message.content), id: \.absoluteString) { url in
                MacLinkCard(url: url)
            }
        }
    }
}

private struct MacPaymentTokenCard: View {
    let token: String
    var redeem: () -> Void
    private var summary: CashuOfflineTokenSummary? { CashuWalletService.offlineTokenSummary(token) }
    var body: some View {
        Button(action: redeem) {
            HStack(spacing: 10) {
                Image(systemName: "bitcoinsign.circle.fill").font(.subheadline.bold()).foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32).background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.map { "\($0.amount) sats" } ?? "Cashu token received").font(.caption.weight(.semibold))
                    Text(summary?.memo.trimmedOrNil ?? "Click to redeem").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.down.circle").font(.caption2.bold()).foregroundStyle(.secondary)
            }.padding(8).frame(maxWidth: 270, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }
}

private struct MacQuickRedeemSheet: View {
    let token: String
    @EnvironmentObject private var wallet: WalletViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?
    @State private var resultMessage: String?
    private var summary: CashuOfflineTokenSummary? { CashuWalletService.offlineTokenSummary(token) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Redeem Ecash").font(.title2.bold())
            if let resultMessage {
                Label(resultMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                if let summary {
                    Text(wallet.formattedSats(summary.amount)).font(.system(size: 32, weight: .semibold, design: .rounded))
                    if let memo = summary.memo.trimmedOrNil { Text(memo).foregroundStyle(.secondary) }
                    Text(summary.mintURL).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("This token's amount couldn't be read, but you can still try to redeem it.").foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if busy { ProgressView().controlSize(.small) }
            }
            Spacer()
            HStack {
                Spacer()
                if resultMessage != nil {
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                } else {
                    Button("Cancel", role: .cancel) { dismiss() }.disabled(busy)
                    Button("Redeem") {
                        busy = true; error = nil
                        Task {
                            defer { busy = false }
                            do {
                                switch MacWalletOutcome(receive: try await wallet.submitReceive(token)) {
                                case .received(let sats): resultMessage = "Received \(wallet.formattedSats(sats))."
                                case .alreadyReceived: resultMessage = "This token was already received."
                                case .receiveQueued: resultMessage = "Receive queued. Retry from the Wallet tab if needed."
                                case .paid, .paymentPending: break
                                }
                            } catch { self.error = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).disabled(busy)
                }
            }
        }.padding(26).frame(width: 420, height: 320).interactiveDismissDisabled(busy)
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
