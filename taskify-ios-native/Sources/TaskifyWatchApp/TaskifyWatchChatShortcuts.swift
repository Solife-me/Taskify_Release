import AppIntents
import Observation
import TaskifyWatchShared

/// Hands a chat destination from a widget link or an App Intent to the root view. Intents have no
/// route to the view hierarchy, and on a cold launch the request arrives before it exists, so the
/// request waits here until the root view is ready to apply it.
@MainActor
@Observable
final class TaskifyWatchChatRouter {
    struct Request: Equatable {
        let id = UUID()
        let link: TaskifyWatchChatLink
    }

    static let shared = TaskifyWatchChatRouter()

    private(set) var request: Request?

    private init() {}

    func open(_ link: TaskifyWatchChatLink) {
        request = Request(link: link)
    }

    func finish(_ finished: Request) {
        if request == finished { request = nil }
    }
}

struct TaskifyWatchOpenMessagesIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Messages"
    static var description = IntentDescription("Opens your Taskify messages.")
    static var openAppWhenRun: Bool = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        TaskifyWatchChatRouter.shared.open(.messages)
        return .result()
    }
}

struct TaskifyWatchNewMessageIntent: AppIntent {
    static var title: LocalizedStringResource = "New Message"
    static var description = IntentDescription("Opens Taskify ready to start a conversation.")
    static var openAppWhenRun: Bool = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        TaskifyWatchChatRouter.shared.open(.newMessage)
        return .result()
    }
}

struct TaskifyWatchOpenConversationIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Conversation"
    static var description = IntentDescription("Opens a Taskify conversation.")
    static var openAppWhenRun: Bool = true

    @Parameter(
        title: "Conversation",
        requestValueDialog: "Which conversation?"
    )
    var conversation: TaskifyWatchConversationEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$conversation)")
    }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        TaskifyWatchChatRouter.shared.open(.conversation(id: conversation.id))
        return .result()
    }
}

/// Sends without opening the app, and always asks first. A message cannot be recalled once sent,
/// and the confirmation is the only chance to catch a misheard name or dictation.
struct TaskifyWatchSendMessageIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Message"
    static var description = IntentDescription("Sends a Taskify message after you confirm it.")
    static var openAppWhenRun: Bool = false

    @Parameter(
        title: "Conversation",
        requestValueDialog: "Who should this go to?"
    )
    var conversation: TaskifyWatchConversationEntity

    @Parameter(
        title: "Message",
        requestValueDialog: "What's your message?"
    )
    var message: String

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$conversation)")
    }

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw $message.needsValueError("What's your message?")
        }
        let name = conversation.name
        let prompt: IntentDialog = "Send “\(text)” to \(name)?"
        if #available(watchOS 11.0, *) {
            try await requestConfirmation(actionName: .send, dialog: prompt)
        } else {
            try await requestConfirmation(
                result: .result(dialog: prompt),
                confirmationActionName: .send
            )
        }
        let delivered = try await TaskifyWatchAppModel.shared.sendChatFromShortcut(
            text,
            conversationID: conversation.id
        )
        // Same rule as the composer: never say sent until a relay has acknowledged it.
        return .result(dialog: delivered
            ? "Sent to \(name)."
            : "Not delivered yet. Open Taskify on your Watch to finish sending to \(name).")
    }
}

/// Must live in the app target; see `TaskifyShortcuts` on the iPhone.
struct TaskifyWatchChatShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TaskifyWatchOpenMessagesIntent(),
            phrases: [
                "Open \(.applicationName) messages",
                "Show my \(.applicationName) messages",
                "Open \(.applicationName) chat",
                "Check \(.applicationName) chat",
            ],
            shortTitle: "Messages",
            systemImageName: "bubble.left.and.bubble.right.fill"
        )
        AppShortcut(
            intent: TaskifyWatchNewMessageIntent(),
            phrases: [
                "New \(.applicationName) message",
                "Start a \(.applicationName) chat",
                "Start a conversation in \(.applicationName)",
            ],
            shortTitle: "New Message",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: TaskifyWatchOpenConversationIntent(),
            phrases: [
                "Open \(\.$conversation) in \(.applicationName)",
                "Open my chat with \(\.$conversation) in \(.applicationName)",
                "Open a conversation in \(.applicationName)",
            ],
            shortTitle: "Conversation",
            systemImageName: "bubble.left.fill"
        )
        AppShortcut(
            intent: TaskifyWatchSendMessageIntent(),
            phrases: [
                "Message \(\.$conversation) in \(.applicationName)",
                "Send a message to \(\.$conversation) in \(.applicationName)",
                "Send a \(.applicationName) message to \(\.$conversation)",
                "Send a \(.applicationName) message",
                "Send a message in \(.applicationName)",
            ],
            shortTitle: "Send Message",
            systemImageName: "paperplane.fill"
        )
    }
}
