import SwiftUI
import TaskifyCore

struct MacChatView: View {
    let search: String
    @Binding var drafts: [String: String]
    @Binding var scrollPositions: [String: String]
    @Environment(AppModel.self) private var model
    @State private var selection: String?
    @State private var showNew = false
    @State private var showArchived = false
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
    private var messages: [NostrDirectMessage] { model.directMessages(with: peer) }
    private var isGroup: Bool { model.groupConversation(id: peer) != nil }
    private var visibleBotCommands: [BotCommand]? {
        guard !isGroup, composer.hasPrefix("/"), let commands = model.botCommands(publicKey: peer), !commands.isEmpty else { return nil }
        let query = String(composer.dropFirst()).lowercased()
        let matched = commands.filter { $0.name.hasPrefix(query) }
        return matched.isEmpty ? nil : matched
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
                    ForEach(messages.filter { search.isEmpty || $0.displayContent.localizedCaseInsensitiveContains(search) }) { message in
                        MacMessageRow(
                            message: message,
                            parent: message.replyToEventID.flatMap { id in messages.first { $0.id == id } },
                            reactions: model.directMessageReactions(for: message),
                            reply: { reply = $0 },
                            react: { target, emoji in
                                Task { do { try await model.sendDirectMessageReaction(to: target, emoji: emoji) } catch { self.error = error.localizedDescription } }
                            },
                            reportError: { error = $0 }
                        ).id(message.id)
                    }
                    }.padding(22)
                }.background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
                    .scrollPosition(id: $scrollAnchor)
                    .onAppear {
                        if scrollAnchor == nil || !messages.contains(where: { $0.id == scrollAnchor }) { scrollAnchor = messages.last?.id }
                        markRead()
                    }
                    .onChange(of: messages.last?.id) { _, id in
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
                MacAttachmentQueueView(queue: attachments, busy: sending)
                HStack(alignment: .bottom, spacing: 12) {
                    Button { attachments.chooseFiles() } label: { Image(systemName: "paperclip") }.disabled(sending || attachments.importing)
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
        Task {
            defer { sending = false }
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
            } catch { self.error = error.localizedDescription }
        }
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
        } else if let envelope {
            MacSharedContentCard(item: envelope.item)
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

private struct MacSharedContentCard: View {
    let item: TaskifyShareItem
    var body: some View {
        switch item {
        case .task(let task):
            card(icon: task.assignment == true ? "person.crop.circle.badge.checkmark" : "checklist",
                 label: task.assignment == true ? "ASSIGNMENT" : "SHARED TASK", title: task.title, subtitle: task.note)
        case .contact(let contact):
            card(icon: "person.crop.circle", label: "SHARED CONTACT",
                 title: contact.displayName.trimmedOrNil ?? contact.name.trimmedOrNil ?? contact.npub, subtitle: contact.about)
        case .calendarEvent(let event):
            card(icon: "calendar", label: "SHARED EVENT", title: event.title ?? "Calendar event", subtitle: formattedISO(event.start))
        case .board(let board):
            card(icon: "square.grid.2x2", label: "SHARED BOARD", title: board.boardName ?? "Shared board", subtitle: nil)
        case .assignmentResponse(let response):
            Label("Assignment \(response.status.rawValue)", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
        }
    }
    private func card(icon: String, label: String, title: String, subtitle: String?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(.subheadline.bold()).foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30).background(Color.accentColor.opacity(0.15), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.system(size: 9, weight: .bold)).tracking(0.6).foregroundStyle(Color.accentColor)
                Text(title).font(.subheadline.weight(.semibold))
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                Text("See Inbox to respond").font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }.padding(10).frame(maxWidth: 280, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
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
