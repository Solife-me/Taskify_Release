import AppIntents
import SwiftUI
import TaskifyWatchShared
import WidgetKit

private let chatWidgetSymbol = "bubble.left.and.bubble.right.fill"

/// Explicit Watch-app reloads remain the fast path; this lets a complication recover on its own if
/// WidgetKit delayed a reload while enforcing its update budget.
private func nextChatWidgetRefresh(after date: Date) -> Date {
    date.addingTimeInterval(30 * 60)
}

private extension TaskifyWatchChatWidgetSnapshot {
    static var preview: TaskifyWatchChatWidgetSnapshot {
        TaskifyWatchChatWidgetSnapshot(
            unreadCount: 3,
            conversations: [
                TaskifyWatchChatWidgetConversation(
                    id: String(repeating: "a", count: 64),
                    displayName: "Sam",
                    unreadCount: 2,
                    isGroup: false
                ),
                TaskifyWatchChatWidgetConversation(
                    id: String(repeating: "b", count: 64),
                    displayName: "Weekend plans",
                    unreadCount: 1,
                    isGroup: true
                ),
            ]
        )
    }
}

// MARK: - Messages

private struct TaskifyWatchMessagesEntry: TimelineEntry {
    let date: Date
    let snapshot: TaskifyWatchChatWidgetSnapshot

    /// Lets the Smart Stack bring this forward only while something is waiting to be read.
    var relevance: TimelineEntryRelevance? {
        TimelineEntryRelevance(score: snapshot.unreadCount > 0 ? 1 : 0)
    }
}

private struct TaskifyWatchMessagesProvider: TimelineProvider {
    func placeholder(in context: Context) -> TaskifyWatchMessagesEntry {
        TaskifyWatchMessagesEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (TaskifyWatchMessagesEntry) -> Void
    ) {
        completion(TaskifyWatchMessagesEntry(
            date: Date(),
            snapshot: context.isPreview ? .preview : TaskifyWatchChatWidgetCache.load()
        ))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<TaskifyWatchMessagesEntry>) -> Void
    ) {
        let now = Date()
        let entry = TaskifyWatchMessagesEntry(date: now, snapshot: TaskifyWatchChatWidgetCache.load())
        completion(Timeline(entries: [entry], policy: .after(nextChatWidgetRefresh(after: now))))
    }
}

struct TaskifyWatchMessagesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: TaskifyWatchChatWidgetCache.messagesWidgetKind,
            provider: TaskifyWatchMessagesProvider()
        ) { entry in
            TaskifyWatchMessagesView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(TaskifyWatchChatLink.messages.url)
        }
        .configurationDisplayName("Messages")
        .description("See your unread Taskify messages.")
        .supportedFamilies([
            .accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner,
        ])
    }
}

private struct TaskifyWatchMessagesView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskifyWatchMessagesEntry

    private var unreadCount: Int { entry.snapshot.unreadCount }

    var body: some View {
        switch family {
        case .accessoryCircular:
            circular
        case .accessoryInline:
            inline
        case .accessoryCorner:
            corner
        default:
            rectangular
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if unreadCount > 0 {
                VStack(spacing: -1) {
                    Image(systemName: chatWidgetSymbol)
                        .font(.caption2.bold())
                        .widgetAccentable()
                    Text(unreadCount, format: .number)
                        .font(.title3.bold())
                        .minimumScaleFactor(0.6)
                }
            } else {
                Image(systemName: chatWidgetSymbol)
                    .font(.title3.bold())
                    .widgetAccentable()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var inline: some View {
        Label(
            unreadCount > 0 ? accessibilitySummary : "No new messages",
            systemImage: chatWidgetSymbol
        )
        .accessibilityLabel(accessibilitySummary)
    }

    private var corner: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: chatWidgetSymbol)
                .font(.title3.bold())
                .widgetAccentable()
        }
        .widgetLabel(unreadCount > 0 ? "\(unreadCount) unread" : "Messages")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Label("Messages", systemImage: chatWidgetSymbol)
                    .font(.caption.bold())
                    .widgetAccentable()
                Spacer(minLength: 2)
                if unreadCount > 0 {
                    Text(unreadCount, format: .number)
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                }
            }

            let unread = entry.snapshot.unreadConversations.prefix(2)
            if unread.isEmpty {
                Spacer(minLength: 0)
                // Unread requests are counted above but never named on the watch face.
                Text(unreadCount > 0 ? "New message request" : "All caught up")
                    .font(.caption)
                Spacer(minLength: 0)
            } else {
                ForEach(unread) { conversation in
                    HStack(spacing: 5) {
                        Image(systemName: conversation.isGroup ? "person.3.fill" : "person.fill")
                            .font(.system(size: 9, weight: .bold))
                            .widgetAccentable()
                        Text(conversation.displayName)
                            .font(.caption2)
                            .lineLimit(1)
                            .privacySensitive()
                        Spacer(minLength: 2)
                        Text(conversation.unreadCount, format: .number)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        switch unreadCount {
        case 0: "No new Taskify messages"
        case 1: "1 new message"
        default: "\(unreadCount) new messages"
        }
    }
}

// MARK: - Conversation

struct TaskifyWatchConversationWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Conversation"
    static var description = IntentDescription("Choose the conversation this complication opens.")

    @Parameter(title: "Conversation")
    var conversation: TaskifyWatchConversationEntity?

    init() {}

    init(conversation: TaskifyWatchConversationEntity) {
        self.conversation = conversation
    }
}

private struct TaskifyWatchConversationEntry: TimelineEntry {
    let date: Date
    /// Nil when the conversation is no longer on this Watch. Its saved configuration still carries
    /// the old name, which must not outlive a deleted thread or a replaced account.
    let conversation: TaskifyWatchChatWidgetConversation?

    var relevance: TimelineEntryRelevance? {
        TimelineEntryRelevance(score: (conversation?.unreadCount ?? 0) > 0 ? 1 : 0)
    }

    var link: TaskifyWatchChatLink {
        conversation.map { .conversation(id: $0.id) } ?? .messages
    }

    static func make(
        date: Date,
        configuration: TaskifyWatchConversationWidgetIntent,
        snapshot: TaskifyWatchChatWidgetSnapshot
    ) -> TaskifyWatchConversationEntry {
        TaskifyWatchConversationEntry(
            date: date,
            conversation: configuration.conversation.flatMap { snapshot.conversation(id: $0.id) }
        )
    }
}

private struct TaskifyWatchConversationProvider: AppIntentTimelineProvider {
    private static let recommendationCount = 8

    func placeholder(in context: Context) -> TaskifyWatchConversationEntry {
        TaskifyWatchConversationEntry(
            date: Date(),
            conversation: TaskifyWatchChatWidgetSnapshot.preview.conversations.first
        )
    }

    func snapshot(
        for configuration: TaskifyWatchConversationWidgetIntent,
        in context: Context
    ) async -> TaskifyWatchConversationEntry {
        guard !context.isPreview || configuration.conversation != nil else {
            return placeholder(in: context)
        }
        return .make(
            date: Date(),
            configuration: configuration,
            snapshot: TaskifyWatchChatWidgetCache.load()
        )
    }

    func timeline(
        for configuration: TaskifyWatchConversationWidgetIntent,
        in context: Context
    ) async -> Timeline<TaskifyWatchConversationEntry> {
        let now = Date()
        let entry = TaskifyWatchConversationEntry.make(
            date: now,
            configuration: configuration,
            snapshot: TaskifyWatchChatWidgetCache.load()
        )
        return Timeline(entries: [entry], policy: .after(nextChatWidgetRefresh(after: now)))
    }

    /// watchOS has no configuration screen for complications: the choices offered in the face
    /// editor are exactly these, so a conversation not listed here cannot be picked.
    func recommendations() -> [AppIntentRecommendation<TaskifyWatchConversationWidgetIntent>] {
        TaskifyWatchChatWidgetCache.load().conversations
            .prefix(Self.recommendationCount)
            .map { conversation in
                AppIntentRecommendation(
                    intent: TaskifyWatchConversationWidgetIntent(
                        conversation: TaskifyWatchConversationEntity(conversation)
                    ),
                    description: Text(conversation.displayName)
                )
            }
    }
}

struct TaskifyWatchConversationWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: TaskifyWatchChatWidgetCache.conversationWidgetKind,
            intent: TaskifyWatchConversationWidgetIntent.self,
            provider: TaskifyWatchConversationProvider()
        ) { entry in
            TaskifyWatchConversationView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(entry.link.url)
        }
        .configurationDisplayName("Conversation")
        .description("Jump straight into a Taskify conversation.")
        .supportedFamilies([
            .accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner,
        ])
    }
}

private struct TaskifyWatchConversationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskifyWatchConversationEntry

    private var name: String { entry.conversation?.displayName ?? "Messages" }
    private var unreadCount: Int { entry.conversation?.unreadCount ?? 0 }
    private var symbol: String {
        entry.conversation?.isGroup == true ? "person.3.fill" : "bubble.left.fill"
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            circular
        case .accessoryInline:
            inline
        case .accessoryCorner:
            corner
        default:
            rectangular
        }
    }

    private var monogram: some View {
        Group {
            if let initial = entry.conversation?.displayName.first {
                Text(String(initial).uppercased())
                    .font(.title3.bold())
                    .privacySensitive()
            } else {
                Image(systemName: chatWidgetSymbol)
                    .font(.title3.bold())
            }
        }
        .widgetAccentable()
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if unreadCount > 0 {
                VStack(spacing: -2) {
                    monogram
                    Text(unreadCount, format: .number)
                        .font(.caption2.bold())
                        .minimumScaleFactor(0.7)
                }
            } else {
                monogram
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var inline: some View {
        Label {
            Text(unreadCount > 0 ? "\(unreadCount) · \(name)" : name)
                .privacySensitive()
        } icon: {
            Image(systemName: symbol)
        }
        .accessibilityLabel(accessibilitySummary)
    }

    private var corner: some View {
        ZStack {
            AccessoryWidgetBackground()
            monogram
        }
        .widgetLabel(unreadCount > 0 ? "\(unreadCount) unread" : "Message")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.caption2.bold())
                    .widgetAccentable()
                Text(name)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .privacySensitive()
            }
            Text(statusText)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var statusText: String {
        guard entry.conversation != nil else { return "Tap to open" }
        switch unreadCount {
        case 0: return "No new messages"
        case 1: return "1 new message"
        default: return "\(unreadCount) new messages"
        }
    }

    private var accessibilitySummary: String {
        guard entry.conversation != nil else { return "Open Taskify messages" }
        return "\(name), \(statusText)"
    }
}

// MARK: - New Message

private struct TaskifyWatchNewMessageEntry: TimelineEntry {
    let date: Date
}

private struct TaskifyWatchNewMessageProvider: TimelineProvider {
    func placeholder(in context: Context) -> TaskifyWatchNewMessageEntry {
        TaskifyWatchNewMessageEntry(date: Date())
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (TaskifyWatchNewMessageEntry) -> Void
    ) {
        completion(TaskifyWatchNewMessageEntry(date: Date()))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<TaskifyWatchNewMessageEntry>) -> Void
    ) {
        completion(Timeline(entries: [TaskifyWatchNewMessageEntry(date: Date())], policy: .never))
    }
}

struct TaskifyWatchNewMessageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: "TaskifyWatchNewMessageWidget",
            provider: TaskifyWatchNewMessageProvider()
        ) { _ in
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "square.and.pencil")
                    .font(.title3.bold())
                    .widgetAccentable()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("New Taskify message")
            .containerBackground(.fill.tertiary, for: .widget)
            .widgetURL(TaskifyWatchChatLink.newMessage.url)
        }
        .configurationDisplayName("New Message")
        .description("Start a Taskify conversation from your watch face.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}
