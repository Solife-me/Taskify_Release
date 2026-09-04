import CoreGraphics
import SwiftUI
import TaskifyWatchShared
import WatchKit

struct TaskifyWatchChatListView: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @State private var confirmingClear = false
#if DEBUG
    @State private var initialConversation = ProcessInfo.processInfo.environment["TASKIFY_INITIAL_CONVERSATION"]
#endif

    private var conversations: [TaskifyWatchChatThread] {
        model.chatThreads.filter { !$0.isRequest }
    }

    private var requests: [TaskifyWatchChatThread] {
        model.chatThreads.filter(\.isRequest)
    }

    var body: some View {
        List {
            if !model.isChatConfigured {
                Section {
                    Label(
                        "Open Taskify on iPhone once to finish chat setup.",
                        systemImage: "iphone.and.arrow.forward"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            if conversations.isEmpty && requests.isEmpty && model.isChatConfigured {
                ContentUnavailableView(
                    "No messages",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Start a private conversation from your Watch.")
                )
            } else {
                if !conversations.isEmpty {
                    Section {
                        ForEach(conversations) { thread in
                            TaskifyWatchChatThreadLink(thread: thread)
                        }
                    }
                }
                if !requests.isEmpty {
                    Section("Requests") {
                        ForEach(requests) { thread in
                            TaskifyWatchChatThreadLink(thread: thread)
                        }
                    }
                }
                if !model.leftChatGroups.isEmpty {
                    Section("Left groups") {
                        ForEach(model.leftChatGroups) { group in
                            Button {
                                model.setGroupLeft(group.groupID, left: false)
                            } label: {
                                Label("Rejoin \(group.displayName)", systemImage: "person.3.fill")
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            Section {
                Label(model.chatStatusMessage, systemImage: "lock.shield.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Button("Clear Watch chat data", role: .destructive) {
                    confirmingClear = true
                }
            }
        }
        .listStyle(.carousel)
        .navigationTitle("Messages")
        .tint(model.taskifyAccentColor)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    TaskifyWatchNewChatView()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(model.taskifyAccentColor)
                        .taskifyWatchCircularGlassControl(size: 38)
                }
                .buttonStyle(.plain)
                .disabled(!model.isChatConfigured)
                .accessibilityLabel("New message")
            }
        }
        .refreshable { await model.refreshChat() }
        .task { await model.refreshChat() }
#if DEBUG
        .navigationDestination(item: $initialConversation) { conversationID in
            let thread = model.chatThreads.first { $0.id == conversationID }
            TaskifyWatchConversationView(
                conversationID: conversationID,
                title: thread?.displayName ?? "Conversation",
                memberPublicKeys: thread?.memberPublicKeys ?? [conversationID],
                groupID: thread?.isGroup == true ? conversationID : nil
            )
        }
#endif
        .confirmationDialog(
            "Clear Watch chat data?",
            isPresented: $confirmingClear,
            titleVisibility: .visible
        ) {
            Button("Clear messages", role: .destructive) { model.clearChatData() }
        } message: {
            Text("This clears local messages and queued sends. Your account and contacts stay on this Watch.")
        }
    }
}

private struct TaskifyWatchChatThreadLink: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    let thread: TaskifyWatchChatThread

    var body: some View {
        NavigationLink {
            TaskifyWatchConversationView(
                conversationID: thread.id,
                title: thread.displayName,
                memberPublicKeys: thread.memberPublicKeys,
                groupID: thread.isGroup ? thread.id : nil
            )
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 9) {
                    TaskifyWatchChatAvatar(
                        name: thread.displayName,
                        url: thread.isRequest ? nil : thread.avatarURL,
                        isGroup: thread.isGroup,
                        size: 48
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(thread.displayName)
                            .font(.body.weight(thread.unreadCount > 0 ? .bold : .semibold))
                            .lineLimit(2)
                        Text(activityLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 2)
                    if thread.unreadCount > 0 {
                        Text(thread.unreadCount, format: .number)
                            .font(.caption2.bold())
                            .foregroundStyle(model.taskifyAccentForegroundColor)
                            .padding(5)
                            .background(model.taskifyAccentColor, in: Circle())
                    }
                }
                Text(thread.preview)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(.vertical, 3)
        }
    }

    private var activityLabel: String {
        let date = Date(timeIntervalSince1970: TimeInterval(thread.latestActivityAt))
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if date > Date().addingTimeInterval(-7 * 24 * 60 * 60) {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

private struct TaskifyWatchChatAvatar: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @State private var loadedPhoto: (url: URL, image: CGImage)?
    let name: String
    let url: URL?
    let isGroup: Bool
    let size: CGFloat

    var body: some View {
        Group {
            if isGroup {
                ZStack {
                    Circle().fill(model.taskifyAccentColor.opacity(0.2))
                    Image(systemName: "person.3.fill")
                        .font(.system(size: size * 0.38, weight: .semibold))
                        .foregroundStyle(model.taskifyAccentColor)
                }
            } else if let loadedPhoto, loadedPhoto.url == url {
                Image(loadedPhoto.image, scale: 1, label: Text(name))
                    .resizable().scaledToFill()
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: "\(url?.absoluteString ?? "")|\(model.avatarRefreshRevision)") {
            if loadedPhoto?.url != url { loadedPhoto = nil }
            guard !isGroup, let url else { return }
            let loader = TaskifyWatchAvatarLoader.shared
            if let cached = await loader.cachedImage(for: url), !Task.isCancelled {
                loadedPhoto = (url, cached)
            }
            guard !Task.isCancelled else { return }
            if let image = try? await loader.image(for: url), !Task.isCancelled {
                loadedPhoto = (url, image)
            }
        }
    }

    private var fallback: some View {
        ZStack {
            Circle().fill(Color.secondary.opacity(0.22))
            Text(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1).uppercased())
                .font(.system(size: size * 0.38, weight: .bold))
                .foregroundStyle(.primary)
        }
    }
}

private struct TaskifyWatchNewChatView: View {
    @Environment(TaskifyWatchAppModel.self) private var model

    var body: some View {
        List {
            Section {
                NavigationLink {
                    TaskifyWatchNewGroupView()
                } label: {
                    Label("New group", systemImage: "person.3.fill")
                }
            }

            Section("Contacts") {
                ForEach(model.chatSnapshot.contacts) { contact in
                    NavigationLink {
                        TaskifyWatchConversationView(
                            conversationID: contact.publicKey,
                            title: contact.displayName,
                            memberPublicKeys: [contact.publicKey],
                            groupID: nil
                        )
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(contact.displayName).lineLimit(1)
                            if !contact.npub.isEmpty {
                                Text(contact.npub)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("New Chat")
    }
}

private struct TaskifyWatchNewGroupView: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selectedPublicKeys: Set<String> = []
    @State private var name = ""
    @State private var isSending = false

    var body: some View {
        List {
            Section("Group name") {
                TextFieldLink(prompt: Text("Optional name")) {
                    HStack {
                        Text(name.isEmpty ? "Add name" : name)
                        Spacer()
                        Image(systemName: "pencil")
                    }
                } onSubmit: { value in
                    name = String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
                }
            }

            Section("Choose 2–16 people") {
                ForEach(model.chatSnapshot.contacts) { contact in
                    Button {
                        if selectedPublicKeys.contains(contact.publicKey) {
                            selectedPublicKeys.remove(contact.publicKey)
                        } else if selectedPublicKeys.count < 16 {
                            selectedPublicKeys.insert(contact.publicKey)
                        }
                    } label: {
                        HStack {
                            Text(contact.displayName).lineLimit(1)
                            Spacer()
                            if selectedPublicKeys.contains(contact.publicKey) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(model.taskifyAccentColor)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            Section {
                TextFieldLink(prompt: Text("First message")) {
                    Label(isSending ? "Sending…" : "Write first message", systemImage: "paperplane.fill")
                } onSubmit: { value in
                    sendFirstMessage(value)
                }
                .disabled(selectedPublicKeys.count < 2 || isSending)
            } footer: {
                Text("Each member receives an independently encrypted copy.")
            }
        }
        .navigationTitle("New Group")
    }

    private func sendFirstMessage(_ value: String) {
        guard selectedPublicKeys.count >= 2, !isSending else { return }
        isSending = true
        Task { @MainActor in
            let sent = await model.sendChat(
                value,
                memberPublicKeys: Array(selectedPublicKeys),
                subject: name.isEmpty ? nil : name
            )
            isSending = false
            if sent {
                WKInterfaceDevice.current().play(.success)
                dismiss()
            } else {
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }
}

private struct TaskifyWatchChatTimelineItem: Identifiable {
    var id: String { message.id }
    let message: TaskifyWatchChatMessage
    let isOutgoing: Bool
    let senderName: String
    let showsDayDivider: Bool
    let dayLabel: String?
    let groupedWithPrevious: Bool
    let groupedWithNext: Bool
    let reactions: [String]
    let ownReaction: String?
    let requiresPhotoConsent: Bool
}

private struct TaskifyWatchConversationView: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    let conversationID: String
    let title: String
    let memberPublicKeys: [String]
    let groupID: String?

    @State private var replyTarget: TaskifyWatchChatMessage?
    @State private var isSending = false

    private var bottomAnchorID: String { "chat-bottom-\(conversationID)" }
    private var composerClearance: CGFloat { replyTarget == nil ? 52 : 76 }

    private var subject: String? {
        guard let groupID else { return nil }
        return model.chatSnapshot.groups.first { $0.groupID == groupID }?.name
    }

    private var peerAvatarURL: URL? {
        guard groupID == nil,
              let peer = memberPublicKeys.first(where: { $0 != model.chatIdentityPublicKey }) else {
            return nil
        }
        return model.chatContact(publicKey: peer)?.avatarURL
    }

    var body: some View {
        // Build grouping, reaction, sender, and day metadata once per snapshot. The prior view
        // rebuilt the complete reaction dictionary and repeatedly filtered/sorted all messages
        // for every visible row, which became quadratic while scrolling longer threads.
        let timeline = timelineItems
        let lastSentMessageID = timeline.last {
            $0.isOutgoing && $0.message.deliveryState == .sent
        }?.id
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        if timeline.isEmpty {
                            ContentUnavailableView(
                                "No saved messages",
                                systemImage: "bubble.left",
                                description: Text("Send a message now. Encrypted history loads when available.")
                            )
                            .padding(.top, 22)
                        } else {
                            ForEach(timeline) { item in
                                VStack(spacing: 0) {
                                    if item.showsDayDivider, let dayLabel = item.dayLabel {
                                        Text(dayLabel)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.top, 7)
                                            .padding(.bottom, 3)
                                    }
                                    TaskifyWatchChatMessageRow(
                                        message: item.message,
                                        isOutgoing: item.isOutgoing,
                                        senderName: item.senderName,
                                        showsSenderName: groupID != nil
                                            && !item.isOutgoing
                                            && !item.groupedWithPrevious,
                                        showsTail: !item.groupedWithNext,
                                        showsSentStatus: item.id == lastSentMessageID,
                                        reactions: item.reactions,
                                        requiresPhotoConsent: item.requiresPhotoConsent,
                                        onRetry: {
                                            model.retryChatMessage(item.message.rumorID)
                                        },
                                        onReply: { replyTarget = item.message },
                                        onReact: { reaction in
                                            sendReaction(
                                                reaction,
                                                to: item.message,
                                                ownReaction: item.ownReaction
                                            )
                                        }
                                    )
                                    .padding(.top, item.groupedWithPrevious ? 1 : 3)
                                    .padding(.bottom, item.groupedWithNext ? 1 : 3)
                                }
                                // Keep visible text at full opacity and size even when a long
                                // message extends past the viewport. The system handles edge effects.
                                .id(item.id)
                            }
                        }

                        // Reserve only the composer's actual footprint. The ScrollView itself can
                        // extend through the conservative rounded-screen safe area, while this
                        // landing zone keeps the newest bubble readable above the glass pill.
                        Color.clear
                            .frame(height: composerClearance)
                            .id(bottomAnchorID)
                    }
                }
                .defaultScrollAnchor(.bottom)

                composer
                    .padding(.bottom, 5)
            }
            .ignoresSafeArea(.container, edges: .bottom)
            .onChange(of: timeline.last?.id) { oldID, newID in
                guard let newID, newID != oldID else { return }
                Task { @MainActor in
                    await Task.yield()
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(bottomAnchorID, anchor: .bottom)
                    }
                }
            }
            .onChange(of: replyTarget?.id) {
                Task { @MainActor in
                    await Task.yield()
                    proxy.scrollTo(bottomAnchorID, anchor: .bottom)
                }
            }
            .task(id: conversationID) {
                // Position before waiting on the network so opening a thread never flashes its
                // oldest message. Repeat after refresh in case newly fetched events changed size.
                await Task.yield()
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
                model.markChatRead(conversationID)
                await model.refreshChat()
                model.markChatRead(conversationID)
                await Task.yield()
                proxy.scrollTo(bottomAnchorID, anchor: .bottom)
            }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    detailsView
                } label: {
                    TaskifyWatchChatAvatar(
                        name: title,
                        url: peerAvatarURL,
                        isGroup: groupID != nil,
                        size: 38
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(groupID == nil ? "Conversation options" : "Group options")
            }
        }
        .onChange(of: model.chatSnapshot.generatedAt) {
            model.markChatRead(conversationID)
        }
    }

    private var composer: some View {
        VStack(spacing: 5) {
            if let replyTarget {
                HStack(spacing: 5) {
                    Image(systemName: "arrowshape.turn.up.left.fill")
                    Text("Replying to \(senderName(replyTarget.senderPublicKey))")
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Button { self.replyTarget = nil } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
            }

            TextFieldLink(prompt: Text(replyTarget == nil ? "Message" : "Reply")) {
                HStack(spacing: 6) {
                    Text(isSending ? "Sending…" : (replyTarget == nil ? "Message" : "Reply"))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 2)
                    Image(systemName: "mic.fill")
                        .foregroundStyle(.secondary)
                }
                .padding(.leading, 13)
                .padding(.trailing, 11)
                .frame(maxWidth: .infinity)
                .frame(height: 38)
                .contentShape(Capsule())
                .modifier(TaskifyWatchComposerGlass())
            } onSubmit: { value in
                send(value)
            }
            .buttonStyle(.plain)
            .disabled(isSending || !model.isChatConfigured)
            .padding(.horizontal, 7)
        }
        .padding(.top, 2)
        .padding(.bottom, 1)
    }

    private var detailsView: some View {
        TaskifyWatchChatDetailsView(
            title: title,
            conversationID: conversationID,
            memberPublicKeys: memberPublicKeys,
            groupID: groupID
        )
    }

    private var timelineItems: [TaskifyWatchChatTimelineItem] {
        _ = model.viewClock
        let allMessages = model.chatMessages(conversationID: conversationID)
        let messages = allMessages.filter { $0.kind != .reaction }
        let identity = model.chatIdentityPublicKey ?? ""
        let contacts = model.chatSnapshot.contacts.reduce(
            into: [String: TaskifyWatchContact]()
        ) { $0[$1.publicKey] = $1 }
        var reactionsByTargetAndSender: [String: [String: TaskifyWatchChatMessage]] = [:]
        for reaction in allMessages where reaction.kind == .reaction {
            guard let target = reaction.reactionTargetRumorID else { continue }
            if reaction.content == "-" {
                reactionsByTargetAndSender[target]?[reaction.senderPublicKey] = nil
            } else {
                reactionsByTargetAndSender[target, default: [:]][reaction.senderPublicKey] = reaction
            }
        }
        let calendar = Calendar.current
        return messages.indices.map { index in
            let message = messages[index]
            let groupedWithPrevious = index > 0
                && canGroup(message, after: messages[index - 1], calendar: calendar)
            let groupedWithNext = index + 1 < messages.count
                && canGroup(messages[index + 1], after: message, calendar: calendar)
            let showsDayDivider: Bool
            if index == 0 {
                showsDayDivider = true
            } else {
                let previous = Date(timeIntervalSince1970: TimeInterval(messages[index - 1].createdAt))
                let current = Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                showsDayDivider = !calendar.isDate(previous, inSameDayAs: current)
            }
            let reactionsBySender = reactionsByTargetAndSender[message.rumorID] ?? [:]
            let reactions = reactionsBySender.values
                .sorted {
                    if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
                    return $0.rumorID < $1.rumorID
                }
                .map(\.content)
            return TaskifyWatchChatTimelineItem(
                message: message,
                isOutgoing: message.senderPublicKey == identity,
                senderName: message.senderPublicKey == identity
                    ? "You"
                    : contacts[message.senderPublicKey]?.displayName ?? "Unknown sender",
                showsDayDivider: showsDayDivider,
                dayLabel: showsDayDivider ? dayLabel(for: message.createdAt) : nil,
                groupedWithPrevious: groupedWithPrevious,
                groupedWithNext: groupedWithNext,
                reactions: reactions,
                ownReaction: reactionsBySender[identity]?.content,
                requiresPhotoConsent: message.senderPublicKey != identity
                    && contacts[message.senderPublicKey] == nil
            )
        }
    }

    private func dayLabel(for timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        let calendar = Calendar.current
        let time = date.formatted(.dateTime.hour().minute())
        if calendar.isDateInToday(date) {
            return "Today \(time)"
        }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        if date > Date().addingTimeInterval(-7 * 24 * 60 * 60) {
            return date.formatted(.dateTime.weekday(.wide).hour().minute())
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    private func canGroup(
        _ current: TaskifyWatchChatMessage,
        after previous: TaskifyWatchChatMessage,
        calendar: Calendar
    ) -> Bool {
        guard current.replyToRumorID == nil,
              current.senderPublicKey == previous.senderPublicKey,
              current.createdAt - previous.createdAt <= 5 * 60 else { return false }
        let currentDate = Date(timeIntervalSince1970: TimeInterval(current.createdAt))
        let previousDate = Date(timeIntervalSince1970: TimeInterval(previous.createdAt))
        return calendar.isDate(currentDate, inSameDayAs: previousDate)
    }

    private func senderName(_ publicKey: String) -> String {
        if publicKey == model.chatIdentityPublicKey { return "You" }
        return model.chatContact(publicKey: publicKey)?.displayName ?? "Unknown sender"
    }

    private func send(_ value: String) {
        guard !isSending else { return }
        isSending = true
        let replyID = replyTarget?.rumorID
        Task { @MainActor in
            let sent = await model.sendChat(
                value,
                memberPublicKeys: memberPublicKeys,
                subject: subject,
                replyToRumorID: replyID
            )
            isSending = false
            if sent {
                replyTarget = nil
                WKInterfaceDevice.current().play(.click)
            } else {
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }

    private func sendReaction(
        _ reaction: String,
        to message: TaskifyWatchChatMessage,
        ownReaction: String?
    ) {
        let value = ownReaction == reaction ? "-" : reaction
        Task { @MainActor in
            _ = await model.sendChat(
                value,
                memberPublicKeys: memberPublicKeys,
                subject: subject,
                reactionToRumorID: message.rumorID
            )
        }
    }
}

private struct TaskifyWatchChatMessageRow: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    let message: TaskifyWatchChatMessage
    let isOutgoing: Bool
    let senderName: String
    let showsSenderName: Bool
    let showsTail: Bool
    let showsSentStatus: Bool
    let reactions: [String]
    let requiresPhotoConsent: Bool
    let onRetry: () -> Void
    let onReply: () -> Void
    let onReact: (String) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if isOutgoing { Spacer(minLength: 25) }
            VStack(alignment: isOutgoing ? .trailing : .leading, spacing: 3) {
                if showsSenderName {
                    Text(senderName)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 5)
                }

                bubble
                if isOutgoing, let deliveryState = message.deliveryState,
                   deliveryState != .sent || showsSentStatus {
                    deliveryStatus(deliveryState)
                }
            }
            if !isOutgoing { Spacer(minLength: 25) }
        }
        .padding(.horizontal, 8)
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 5) {
                if message.replyToRumorID != nil {
                    Label("Reply", systemImage: "arrowshape.turn.up.left")
                        .font(.caption2)
                        .opacity(0.72)
                }
                messageBody
        }
        .font(.body)
        .foregroundStyle(
            isOutgoing ? model.taskifyAccentForegroundColor : Color.white
        )
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background { bubbleShape.fill(bubbleFill) }
        .overlay(alignment: isOutgoing ? .topLeading : .topTrailing) {
            if !reactions.isEmpty {
                TaskifyWatchReactionBadge(
                    reactions: reactions,
                    isOutgoing: isOutgoing
                )
                .offset(x: isOutgoing ? -5 : 5, y: -17)
            }
        }
        .padding(.top, reactions.isEmpty ? 0 : 16)
        .contentShape(bubbleShape)
        .contextMenu {
            Button("Love", systemImage: "heart.fill") { react("❤️") }
            Button("Like", systemImage: "hand.thumbsup.fill") { react("👍") }
            Button("Dislike", systemImage: "hand.thumbsdown.fill") { react("👎") }
            Button("Laugh", systemImage: "face.smiling.fill") { react("😂") }
            Button("Emphasize", systemImage: "exclamationmark.2") { react("‼️") }
            Button("Question", systemImage: "questionmark") { react("❓") }
            Button("Reply", systemImage: "arrowshape.turn.up.left") { onReply() }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Reply", systemImage: "arrowshape.turn.up.left") { onReply() }
            Button("Like", systemImage: "hand.thumbsup.fill") { react("👍") }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button("Heart", systemImage: "heart.fill") { react("❤️") }
            Button("Laugh", systemImage: "face.smiling.fill") { react("😂") }
        }
    }

    @ViewBuilder
    private func deliveryStatus(_ state: TaskifyWatchChatDeliveryState) -> some View {
        switch state {
        case .queued:
            Label("Queued", systemImage: "clock")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .partiallySent:
            Label("Partially sent", systemImage: "exclamationmark.circle")
                .font(.caption2)
                .foregroundStyle(.orange)
        case .sent:
            Label("Sent", systemImage: "checkmark")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .failed:
            VStack(alignment: .trailing, spacing: 2) {
                Button(action: onRetry) {
                    Label("Retry", systemImage: "arrow.clockwise")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Message failed. Retry delivery")
                if let reason = message.lastSubmissionError {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
    }

    private var bubbleShape: TaskifyWatchMessageBubbleShape {
        TaskifyWatchMessageBubbleShape(isIncoming: !isOutgoing, showsTail: showsTail)
    }

    private var bubbleFill: Color {
        isOutgoing
            ? model.taskifyAccentColor
            : Color(red: 44 / 255, green: 44 / 255, blue: 48 / 255).opacity(0.98)
    }

    @ViewBuilder
    private var messageBody: some View {
        switch message.kind {
        case .text:
            TaskifyWatchChatMarkdownText(markdown: message.content, isOutgoing: isOutgoing)
        case .reaction:
            HStack(spacing: 4) {
                Text(message.content).font(.title3)
                Text("Reaction").font(.caption2).foregroundStyle(.secondary)
            }
        case .photo:
            if let attachment = message.attachment {
                TaskifyWatchReceivedPhotoView(
                    attachment: attachment,
                    requiresConsent: requiresPhotoConsent
                )
            } else {
                Label("Photo unavailable", systemImage: "photo")
            }
        case .unsupportedAttachment:
            Label("Open attachment on iPhone", systemImage: "iphone")
                .font(.caption)
        case .unsupportedMessage:
            Label("Open this message on iPhone", systemImage: "iphone")
                .font(.caption)
        }
    }

    private func react(_ emoji: String) {
        WKInterfaceDevice.current().play(.click)
        onReact(emoji)
    }
}

/// Watch-sized port of the phone chat's markdown renderer: the same `NostrChatMarkdown` block
/// model and inline styling, on a compressed type ramp. The phone's tap-to-copy affordance on
/// code blocks and inline code is omitted — watchOS has no pasteboard API to copy into.
private struct TaskifyWatchChatMarkdownText: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    private let document: NostrChatMarkdownDocument
    private let isOutgoing: Bool

    init(markdown: String, isOutgoing: Bool) {
        document = TaskifyWatchMarkdownCache.shared.document(markdown)
        self.isOutgoing = isOutgoing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                blockView(block)
                    .padding(.top, topPadding(for: block, at: index))
            }
        }
        .tint(foreground)
    }

    @ViewBuilder
    private func blockView(_ block: NostrChatMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let content):
            inlineText(content, font: .body)
        case let .heading(level, content):
            inlineText(content, font: headingFont(level: level))
        case let .unorderedListItem(depth, content):
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text("•")
                    .font(.body.weight(.bold))
                    .frame(width: 9, alignment: .trailing)
                inlineText(content, font: .body)
            }
            .padding(.leading, CGFloat(depth) * 9)
        case let .orderedListItem(depth, number, content):
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text("\(number).")
                    .font(.body.weight(.semibold))
                    .frame(minWidth: 14, alignment: .trailing)
                inlineText(content, font: .body)
            }
            .padding(.leading, CGFloat(depth) * 9)
        case let .blockQuote(depth, content):
            HStack(alignment: .top, spacing: 6) {
                RoundedRectangle(cornerRadius: 1.25, style: .continuous)
                    .fill(foreground.opacity(0.38))
                    .frame(width: 2.5)
                inlineText(content, font: .body.italic())
                    .foregroundStyle(foreground.opacity(0.88))
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 8)
        case let .codeBlock(language, content):
            VStack(alignment: .leading, spacing: 3) {
                if let language {
                    Text(language.uppercased())
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(foreground.opacity(0.62))
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(content)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(foreground)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(7)
            .background(codeBackground, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityElement(children: .combine)
        case .thematicBreak:
            Rectangle()
                .fill(foreground.opacity(0.24))
                .frame(minWidth: 80, maxWidth: .infinity, minHeight: 1, maxHeight: 1)
        }
    }

    private func inlineText(_ markdown: String, font: Font) -> some View {
        Text(styledInlineMarkdown(markdown))
            .font(font)
            .foregroundStyle(foreground)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func styledInlineMarkdown(_ markdown: String) -> AttributedString {
        var attributed = TaskifyWatchMarkdownCache.shared.inline(markdown)
        let runs = attributed.runs.map { run in
            (
                range: run.range,
                intent: run.inlinePresentationIntent,
                link: run.link
            )
        }
        for run in runs {
            if run.intent?.contains(.code) == true {
                attributed[run.range].font = Font
                    .system(.callout, design: .monospaced)
                    .weight(.medium)
                attributed[run.range].foregroundColor = foreground
                attributed[run.range].backgroundColor = codeBackground
                continue
            }
            if let link = run.link, !isSafeExternalLink(link) {
                attributed[run.range].link = nil
            }
        }
        return attributed
    }

    private var foreground: Color {
        isOutgoing ? model.taskifyAccentForegroundColor : .white
    }

    private var codeBackground: Color {
        isOutgoing ? Color.black.opacity(0.2) : Color.white.opacity(0.12)
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1: .title3.weight(.bold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .body.weight(.semibold)
        }
    }

    private func topPadding(for block: NostrChatMarkdownBlock, at index: Int) -> CGFloat {
        guard index > 0 else { return 0 }
        let previous = document.blocks[index - 1]
        if isListItem(block), isListItem(previous) { return 3 }
        if isBlockQuote(block), isBlockQuote(previous) { return 3 }
        return 8
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
}

private struct TaskifyWatchReactionBadge: View {
    let reactions: [String]
    let isOutgoing: Bool

    private let fill = Color(red: 37 / 255, green: 37 / 255, blue: 41 / 255)

    private var emojis: [String] {
        reactions.reduce(into: []) { result, emoji in
            if !result.contains(emoji) { result.append(emoji) }
        }
    }

    var body: some View {
        HStack(spacing: -5) {
            ForEach(emojis, id: \.self) { emoji in
                let count = reactions.filter { $0 == emoji }.count
                ZStack {
                    Circle().fill(fill)
                    Circle().stroke(Color.white.opacity(0.14), lineWidth: 0.7)
                    Text(emoji).font(.system(size: 14))
                }
                .frame(width: 27, height: 27)
                .overlay(alignment: .topTrailing) {
                    if count > 1 {
                        Text("\(count)")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 13, height: 13)
                            .background(Color.gray.opacity(0.9), in: Circle())
                            .offset(x: 2, y: -2)
                    }
                }
            }
        }
        .overlay(alignment: isOutgoing ? .bottomTrailing : .bottomLeading) {
            ZStack {
                Circle().frame(width: 7, height: 7)
                Circle()
                    .frame(width: 3.5, height: 3.5)
                    .offset(x: isOutgoing ? 6 : -6, y: 6)
            }
            .foregroundStyle(fill)
            .offset(x: isOutgoing ? 1 : -1, y: 4)
        }
        .shadow(color: .black.opacity(0.28), radius: 2, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reactions: \(emojis.joined(separator: ", "))")
    }
}

/// The compact Messages tail used by both the iPhone and Watch chat renderers. The tail extends
/// beyond the layout bounds so grouped messages keep their text and rounded bodies aligned.
private struct TaskifyWatchMessageBubbleShape: Shape {
    let isIncoming: Bool
    let showsTail: Bool

    func path(in rect: CGRect) -> Path {
        let radius = min(CGFloat(17), rect.height / 2)
        guard showsTail else {
            return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect)
        }

        let tailWidth: CGFloat = 5
        let tailHeight = min(CGFloat(10), max(CGFloat(6), rect.height * 0.3))
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
            path.addLine(to: CGPoint(x: bodyLeft + 15, y: bottom))
            path.addCurve(
                to: CGPoint(x: bodyLeft - tailWidth, y: bottom),
                control1: CGPoint(x: bodyLeft + 9, y: bottom),
                control2: CGPoint(x: bodyLeft - tailWidth + 3, y: bottom)
            )
            path.addCurve(
                to: CGPoint(x: bodyLeft, y: bottom - tailHeight),
                control1: CGPoint(x: bodyLeft - tailWidth + 3, y: bottom),
                control2: CGPoint(x: bodyLeft, y: bottom - 4)
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
                to: CGPoint(x: bodyRight + tailWidth, y: bottom),
                control1: CGPoint(x: bodyRight, y: bottom - 4),
                control2: CGPoint(x: bodyRight + tailWidth - 3, y: bottom)
            )
            path.addCurve(
                to: CGPoint(x: bodyRight - 15, y: bottom),
                control1: CGPoint(x: bodyRight + tailWidth - 3, y: bottom),
                control2: CGPoint(x: bodyRight - 9, y: bottom)
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

private struct TaskifyWatchComposerGlass: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(watchOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.16), lineWidth: 0.8))
        }
    }
}

private struct TaskifyWatchReceivedPhotoView: View {
    let attachment: TaskifyWatchChatAttachment
    let requiresConsent: Bool
    @State private var image: CGImage?
    @State private var failed = false
    @State private var isAuthorized = false

    var body: some View {
        Group {
            if let image {
                Image(image, scale: 1, label: Text("Received photo"))
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 130)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else if requiresConsent && !isAuthorized {
                Button {
                    isAuthorized = true
                } label: {
                    Label("Load photo", systemImage: "photo.badge.arrow.down")
                }
                .font(.caption)
            } else if failed {
                Label("Photo unavailable", systemImage: "exclamationmark.triangle")
                    .font(.caption)
            } else {
                ProgressView("Decrypting…")
                    .font(.caption2)
            }
        }
        .task(id: isAuthorized) {
            guard !requiresConsent || isAuthorized else { return }
            do {
                image = try await TaskifyWatchPhotoLoader.shared.image(for: attachment)
            } catch {
                failed = true
            }
        }
    }
}

private struct TaskifyWatchChatDetailsView: View {
    @Environment(TaskifyWatchAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let title: String
    let conversationID: String
    let memberPublicKeys: [String]
    let groupID: String?

    private var group: TaskifyWatchGroupConversation? {
        guard let groupID else { return nil }
        return model.chatSnapshot.groups.first { $0.groupID == groupID }
    }

    var body: some View {
        List {
            if let group {
                Section("Group") {
                    TextFieldLink(prompt: Text("Group name")) {
                        Label(group.displayName, systemImage: "pencil")
                    } onSubmit: { model.renameGroup(group.groupID, name: $0) }

                    Button {
                        model.setGroupMuted(group.groupID, muted: !group.isMuted)
                    } label: {
                        Label(
                            group.isMuted ? "Unmute" : "Mute",
                            systemImage: group.isMuted ? "bell.fill" : "bell.slash.fill"
                        )
                    }
                }

                Section("Members") {
                    ForEach(group.memberPublicKeys, id: \.self) { publicKey in
                        Text(memberName(publicKey)).lineLimit(1)
                    }
                }

                Section {
                    Button("Leave group", role: .destructive) {
                        model.setGroupLeft(group.groupID, left: true)
                        dismiss()
                    }
                }
            } else if let peer = memberPublicKeys.first(where: { $0 != model.chatIdentityPublicKey }) {
                Section {
                    Button("Block sender", role: .destructive) {
                        model.blockChatSender(peer)
                        dismiss()
                    }
                } footer: {
                    Text("Blocking removes this sender's saved Watch messages and ignores future ones.")
                }
            }

            Section {
                Button("Delete conversation from Watch", role: .destructive) {
                    model.deleteChatConversation(conversationID)
                    dismiss()
                }
            }

            Section {
                Label("End-to-end encrypted", systemImage: "lock.shield.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(title)
    }

    private func memberName(_ publicKey: String) -> String {
        if publicKey == model.chatIdentityPublicKey { return "You" }
        if let contact = model.chatContact(publicKey: publicKey) { return contact.displayName }
        return "\(publicKey.prefix(8))…\(publicKey.suffix(6))"
    }
}
