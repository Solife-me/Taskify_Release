import SwiftUI
import TaskifyCore

struct MacChatView: View {
    let search: String
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
                MacConversation(peer: selection, title: name(selection)).id(selection).frame(minWidth: 340)
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
    @Environment(AppModel.self) private var model
    @Environment(\.controlActiveState) private var activeState
    @State private var composer = ""
    @StateObject private var attachments = MacAttachmentQueue()
    @State private var sending = false
    @State private var deleting = false
    @State private var groupDetails = false
    @State private var reply: NostrDirectMessage?
    @State private var error: String?
    @State private var search = ""
    private var messages: [NostrDirectMessage] { model.directMessages(with: peer) }
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
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        ForEach(messages.filter { search.isEmpty || $0.displayContent.localizedCaseInsensitiveContains(search) }) { message in
                            HStack {
                                if !message.isIncoming { Spacer(minLength: 60) }
                                VStack(alignment: .leading, spacing: 5) {
                                    if let parentID = message.replyToEventID, let parent = messages.first(where: { $0.id == parentID }) {
                                        Text(parent.displayContent).font(.caption).lineLimit(2).foregroundStyle(.secondary).padding(.leading, 8)
                                            .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor).frame(width: 2) }
                                    }
                                    Text(.init(message.displayContent)).textSelection(.enabled)
                                    if let attachment = message.attachment {
                                        Button("Save Attachment…") { Task { do { try await MacAttachmentExport.chat(attachment) } catch { self.error = error.localizedDescription } } }
                                    }
                                    HStack {
                                        Text(Date(timeIntervalSince1970: Double(message.createdAt)).formatted(date: .omitted, time: .shortened))
                                        if !message.isIncoming { Text(message.deliveryState.map { String(describing: $0).capitalized } ?? "Queued") }
                                    }.font(.caption2).foregroundStyle(.secondary)
                                    let reactions = model.directMessageReactions(for: message)
                                    if !reactions.isEmpty { Text(reactions.map(\.emoji).joined(separator: " ")).font(.caption) }
                                }.padding(12)
                                    .background(message.isIncoming ? Color(nsColor: .controlBackgroundColor) : Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                                    .contextMenu {
                                        Button("Reply") { reply = message }
                                        Button("Copy") { macCopy(message.content) }
                                        ForEach(["❤️", "👍", "✅", "😂"], id: \.self) { emoji in
                                            Button(emoji) { Task { do { try await model.sendDirectMessageReaction(to: message, emoji: emoji) } catch { self.error = error.localizedDescription } } }
                                        }
                                    }
                                if message.isIncoming { Spacer(minLength: 60) }
                            }.id(message.id)
                        }
                    }.padding(22)
                }.background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
                    .onAppear { if let id = messages.last?.id { proxy.scrollTo(id, anchor: .bottom) }; markRead() }
                    .onChange(of: messages.last?.id) { _, id in
                        if let id { proxy.scrollTo(id, anchor: .bottom) }
                        markRead()
                    }
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                if let reply {
                    HStack { Text("Replying to: \(reply.displayContent)").font(.caption).lineLimit(1); Spacer(); Button("Cancel Reply") { self.reply = nil } }
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                MacAttachmentQueueView(queue: attachments, busy: sending)
                HStack(alignment: .bottom, spacing: 12) {
                    Button { attachments.chooseFiles() } label: { Image(systemName: "paperclip") }.disabled(sending || attachments.importing)
                    TextField("Message", text: $composer, axis: .vertical).lineLimit(2...8).textFieldStyle(.plain)
                        .padding(10).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                    Button(action: send) { if sending { ProgressView().controlSize(.small) } else { Label("Send", systemImage: "arrow.up") } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(sending || attachments.importing || (composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.files.isEmpty) || model.isDirectMessagePeerBlocked(peer) || model.hasLeftDirectMessageGroup(peer))
                }
            }.padding(16)
        }
        .sheet(isPresented: $groupDetails) { MacGroupDetails(groupID: peer) }
        .confirmationDialog("Delete this conversation from this account's local history?", isPresented: $deleting) {
            Button("Delete Conversation", role: .destructive) { model.deleteDirectMessageThread(peerPublicKey: peer) }
            Button("Cancel", role: .cancel) {}
        }
        .task { await model.prepareDirectMessageRecipient(peer) }
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
